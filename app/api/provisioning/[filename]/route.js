import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import {
  resolveProvisioningRequest,
  buildConfigForPhone,
  yealinkCommonConfig,
  vendorFromUserAgent,
} from "@/lib/hardphones/config-generators.mjs";
import { recordProvisioningEvent, phoneProvisioningLogger } from "@/lib/hardphones/logging.mjs";
import { authorizeProvisioning, getProvisioningEnrollment, provisioningEventToken, provisioningCredentials } from "@/lib/hardphones/provisioning-access.mjs";

export const dynamic = "force-dynamic";

function requestOriginBaseUrl(request) {
  try {
    const url = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = forwardedHost || request.headers.get("host") || url.host;
    const protocol = forwardedProto || url.protocol.replace(/:$/, "");
    return `${protocol}://${host}`;
  } catch {
    return "";
  }
}

function resolveBaseUrl(request) {
  const candidates = [
    process.env.TELNYX_WEBHOOK_BASE_URL,
    process.env.NEXTAUTH_URL,
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value.replace(/\/$/, "");
  }
  return requestOriginBaseUrl(request);
}

function resolveProvisioningBaseUrl(request) {
  return requestOriginBaseUrl(request);
}

function requestSourceIp(request) {
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || request.headers.get("x-real-ip") || null;
}

// GET /api/provisioning/[filename] — device provisioning endpoint.
// Phones fetch their config files here at boot (DHCP option 66/160 or vendor
// redirect service points at https://<host>/api/provisioning/). Unknown MACs
// get 404 and are logged. Every vendor requires a per-device Basic credential.
export async function GET(request, { params }) {
  const pool = getPostgresPool();
  if (!pool) return new NextResponse("Server not ready", { status: 500 });

  const { filename } = await params;
  const resolved = resolveProvisioningRequest(filename);
  const userAgent = request.headers.get("user-agent") || "";
  const uaVendor = vendorFromUserAgent(userAgent);

  if (!resolved) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Yealink common config — static fleet defaults, no credentials inside.
  if (resolved.kind === "common") {
    await recordProvisioningEvent(pool, { eventType: "common_config_fetch", detail: { filename, userAgent } });
    return new NextResponse(yealinkCommonConfig({ baseUrl: resolveProvisioningBaseUrl(request) }), {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Polycom default master config — intentionally not served (unknown phones
  // must be added to inventory first).
  if (resolved.kind === "default-master") {
    await recordProvisioningEvent(pool, { eventType: "unknown_phone_request", detail: { filename, userAgent } });
    return new NextResponse("Not found", { status: 404 });
  }

  const mac = resolved.mac;
  const { rows } = await pool.query(
    `SELECT id, mac, vendor, model, phone_name, label, assigned_phone_number_id, assigned_phone_number, sip_username, sip_password, admin_password, settings, provisioning_state
     FROM hp_phones WHERE mac = $1`,
    [mac],
  );
  const phone = rows[0];

  if (!phone) {
    await recordProvisioningEvent(pool, { mac, eventType: "unknown_phone_request", detail: { filename, userAgent, uaVendor } });
    return new NextResponse("Not found", { status: 404 });
  }
  if (phone.provisioning_state === "disabled") {
    await recordProvisioningEvent(pool, { phoneId: phone.id, mac, eventType: "disabled_phone_request", detail: { filename } });
    return new NextResponse("Not found", { status: 404 });
  }

  const enrollment = await getProvisioningEnrollment(pool, phone.id);
  if (!authorizeProvisioning(request.headers.get("authorization"), phone, enrollment)) {
    return new NextResponse("Device authentication required", {
      status: 401, headers: { "WWW-Authenticate": 'Basic realm="CC provisioning"', "Cache-Control": "no-store" },
    });
  }

  const assignment = (await pool.query(`SELECT a.number FROM cc_extension_assignments a
    JOIN cc_phone_stations s ON s.id=a.station_id
    WHERE s.phone_id=$1 AND a.target_type='phone'`, [phone.id])).rows[0];
  phone.extension = assignment?.number || null;
  // This value is resolved at every authenticated fetch, including after a
  // number is reassigned or removed. No duplicate extension field in hp_phones.

  // Serve only the managed registration file and master for Polycom; its
  // reserved local override filename must remain absent.
  const kind = resolved.kind;
  const baseUrl = enrollment?.base_url || resolveBaseUrl(request);
  // Native CTI polls the device. URL-authenticated notifications are opt-in
  // until their firmware behavior and device-side log handling are certified.
  const config = buildConfigForPhone(phone, kind, { baseUrl, credential: provisioningCredentials(phone, enrollment),
    eventToken: phone.settings?.polycom_event_notifications === true ? provisioningEventToken(phone, enrollment) : "" });
  if (!config) {
    phoneProvisioningLogger.warn("hardphone_config_generation_failed", { operation: "hp_serve", phoneId: phone.id, mac, detail: { vendor: phone.vendor, kind } });
    return new NextResponse("Not found", { status: 404 });
  }

  const sourceIp = requestSourceIp(request);
  // HTTP source addresses can be a proxy/tunnel. Device management addresses
  // are enrolled separately and verified against the physical MAC.
  await pool.query(
    `UPDATE hp_phones SET last_seen_at = NOW(), last_user_agent = $2 WHERE id = $1`,
    [phone.id, userAgent.slice(0, 300) || null],
  );
  if (kind === "registration" || (phone.vendor !== "polycom" && kind === "mac-config")) {
    await pool.query("UPDATE hp_device_enrollments SET downloaded_at = NOW() WHERE phone_id = $1", [phone.id]);
  }
  await recordProvisioningEvent(pool, {
    phoneId: phone.id,
    mac,
    eventType: "config_served",
    detail: { filename, kind, vendor: phone.vendor, userAgent, sourceIp, uaVendorMismatch: Boolean(uaVendor && uaVendor !== phone.vendor) },
  });

  return new NextResponse(config.body, {
    status: 200,
    headers: { "Content-Type": `${config.contentType}; charset=utf-8`, "Cache-Control": "no-store" },
  });
}
