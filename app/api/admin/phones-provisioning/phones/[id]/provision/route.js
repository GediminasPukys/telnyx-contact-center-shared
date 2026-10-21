import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { configurePolycomProvisioning, verifyPolycomProvisioning } from "@/lib/hardphones/polycom-provisioning.mjs";
import { configureAudioCodesProvisioning, verifyAudioCodesProvisioning } from "@/lib/hardphones/audiocodes-provisioning.mjs";
import { configureYealinkProvisioning, verifyYealinkProvisioning } from "@/lib/hardphones/yealink-provisioning.mjs";
import { enrollProvisioningPhone, getProvisioningEnrollment, polycomBootstrapConfig, audiocodesBootstrapConfig, yealinkBootstrapConfig } from "@/lib/hardphones/provisioning-access.mjs";
import { withStationMaintenance } from "@/lib/telephony/stations.mjs";

export const dynamic = "force-dynamic";

async function handler(request, { params }, { user }) {
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
  const { id } = await params;
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Invalid phone id" }, { status: 400 });
  try {
    const { rows: [phone] } = await pool.query("SELECT * FROM hp_phones WHERE id = $1", [id]);
    if (!phone) return NextResponse.json({ error: "Phone not found" }, { status: 404 });
    const adapters = {
      polycom: { configure: configurePolycomProvisioning, verify: verifyPolycomProvisioning, bootstrap: polycomBootstrapConfig },
      audiocodes: { configure: configureAudioCodesProvisioning, verify: verifyAudioCodesProvisioning, bootstrap: audiocodesBootstrapConfig },
      yealink: { configure: configureYealinkProvisioning, verify: verifyYealinkProvisioning, bootstrap: yealinkBootstrapConfig },
    };
    const adapter = adapters[phone.vendor];
    if (!adapter || phone.provisioning_state === "disabled") return NextResponse.json({ error: "An enabled supported phone is required" }, { status: 409 });
    const { operation, currentAdminPassword } = await request.json().catch(() => ({}));
    if (currentAdminPassword !== undefined && (typeof currentAdminPassword !== "string" || currentAdminPassword.length > 256)) {
      return NextResponse.json({ error: "Invalid administrator password" }, { status: 400 });
    }
    if (operation === "bootstrap") {
      const enrollment = await enrollProvisioningPhone(pool, phone);
      return new NextResponse(adapter.bootstrap(phone, enrollment), { headers: {
        "Content-Type": phone.vendor === "polycom" ? "application/xml" : "text/plain", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${phone.mac}-cc-bootstrap.cfg"`,
      } });
    }
    if (!["configure", "verify"].includes(operation)) return NextResponse.json({ error: "Expected configure, verify or bootstrap" }, { status: 400 });
    const result = operation === "configure"
      ? await withStationMaintenance(pool, id, () => adapter.configure(pool, phone, { currentAdminPassword: currentAdminPassword || undefined }))
      : await adapter.verify(pool, phone);
    return NextResponse.json(result, { status: result.ok ? 200 : 409, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const reasons = ["device_mac_mismatch", "unsupported_device_model", "unsupported_device_form", "unsupported_device_response",
      "auth_failed", "certificate_changed", "request_timeout", "invalid_phone_ip", "unsupported_device_password"];
    if (reasons.includes(error.message)) return NextResponse.json({ ok: false, reason: error.message }, { status: 409 });
    if (error.status) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "Provisioning failed. Check the configured HTTPS origin and server secret." }, { status: 500 });
  }
}

export const POST = withPermission("phones:update", handler, { route: "/api/admin/phones-provisioning/phones/[id]/provision" });

export const GET = withPermission("phones:read", async (_request, { params }, { user }) => {
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: "Invalid phone id" }, { status: 400 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 503 });
  const enrollment = await getProvisioningEnrollment(pool, id);
  return NextResponse.json({ enrolled: Boolean(enrollment), baseUrl: enrollment?.base_url,
    downloadedAt: enrollment?.downloaded_at, verifiedAt: enrollment?.verified_at, verification: enrollment?.verification || {},
    certificatePinned: Boolean(enrollment?.certificate_fingerprint),
  }, { headers: { "Cache-Control": "no-store" } });
}, { route: "/api/admin/phones-provisioning/phones/[id]/provision" });
