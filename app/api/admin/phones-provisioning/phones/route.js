import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { normalizeMac, SUPPORTED_VENDORS, validatePhoneLineLabel } from "@/lib/hardphones/config-generators.mjs";
import { createPhoneSipConnection, deletePhoneSipConnection, listTelnyxPhoneNumbers } from "@/lib/hardphones/credentials.mjs";
import { ownedVoiceNumber } from "@/lib/telephony/dialing.mjs";
import { syncHardphonePhoneNumbersFromTelnyx } from "@/lib/hardphones/number-sync.mjs";
import { syncHardphoneRegistrationStatusesFromTelnyx } from "@/lib/hardphones/registration-sync.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


const PHONE_COLUMNS = `id, phone_name, mac, vendor, model, label, agent_id, telnyx_credential_id, telnyx_connection_id, telnyx_connection_name,
  assigned_phone_number_id, assigned_phone_number, sip_username, settings, provisioning_state, ip_address, last_ip,
  local_bridge_id, sip_registration_status, sip_registration_status_at, last_seen_at, last_user_agent, created_at, updated_at`;

function hardphoneConfigStatus(user = {}) {
  return {
    phoneAdminPasswordConfigured: Boolean(process.env.TELNYX_PHONE_ADMIN_PASSWORD),
    outboundVoiceProfileConfigured: Boolean(process.env.TELNYX_OUTBOUND_VOICE_PROFILE),
    userTimezone: user.timezone || "UTC",
  };
}

function isNewerTimestamp(candidate, current) {
  if (!candidate) return false;
  const candidateTime = new Date(candidate).getTime();
  if (!Number.isFinite(candidateTime)) return false;
  if (!current) return true;
  const currentTime = new Date(current).getTime();
  if (!Number.isFinite(currentTime)) return true;
  return candidateTime > currentTime;
}

function resolveSipRegistrationStatus(phone, registrationEvent) {
  const useEvent = registrationEvent?.sip_registration_status
    && isNewerTimestamp(registrationEvent.registration_status_at, phone.sip_registration_status_at);
  if (useEvent) {
    return {
      sip_registration_status: registrationEvent.sip_registration_status,
      sip_registration_status_at: registrationEvent.registration_status_at,
    };
  }
  return {
    sip_registration_status: phone.sip_registration_status || registrationEvent?.sip_registration_status || "unknown",
    sip_registration_status_at: phone.sip_registration_status_at || registrationEvent?.registration_status_at || null,
  };
}

async function GET_handler(request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const searchParams = new URL(request.url).searchParams;
    const includeAvailablePhoneNumbers = searchParams.get("includeAvailablePhoneNumbers") === "1";
    const syncNumbers = includeAvailablePhoneNumbers || searchParams.get("syncNumbers") === "1";
    const [{ rows }, { rows: eventRows }, { rows: registrationRows }, availablePhoneNumbers, { rows: extensionRows }] = await Promise.all([
      pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones ORDER BY created_at DESC LIMIT 500`),
      pool.query(
        `SELECT phone_id, MAX(created_at) AS last_event_at, COUNT(*)::int AS events
         FROM hp_provisioning_events WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY phone_id`,
      ),
      pool.query(
        `SELECT DISTINCT ON (phone_id) phone_id, detail->>'registration_status' AS sip_registration_status, created_at AS registration_status_at
         FROM hp_provisioning_events
         WHERE event_type = 'registration_status_event'
         ORDER BY phone_id, created_at DESC`,
      ),
      includeAvailablePhoneNumbers ? listTelnyxPhoneNumbers().then(items => items.map(n => ({ id:n.id, phone_number:n.phone_number }))).catch((err) => {
        adminRuntimeLogger.warn("hardphone_number_inventory_failed", runtimePayload({ error: err, operation: "hp_number_inventory" }));
        return [];
      }) : Promise.resolve([]),
      pool.query(`SELECT s.phone_id, a.number AS extension
        FROM cc_phone_stations s JOIN cc_extension_assignments a ON a.station_id=s.id
        WHERE a.target_type='phone' AND s.phone_id IS NOT NULL`),
    ]);
    let syncedRows = syncNumbers ? await syncHardphonePhoneNumbersFromTelnyx(pool, rows).catch((err) => {
      adminRuntimeLogger.warn("hardphone_number_sync_failed", runtimePayload({ error: err, operation: "hp_number_sync" }));
      return rows;
    }) : rows;
    syncedRows = await syncHardphoneRegistrationStatusesFromTelnyx(pool, syncedRows).catch((err) => {
      adminRuntimeLogger.warn("hardphone_registration_sync_failed", runtimePayload({ error: err, operation: "hp_registration_sync" }));
      return syncedRows;
    });
    const eventsByPhone = Object.fromEntries(eventRows.map((r) => [r.phone_id, r]));
    const registrationByPhone = Object.fromEntries(registrationRows.map((r) => [r.phone_id, r]));
    const extensionByPhone = Object.fromEntries(extensionRows.map(r => [r.phone_id, r.extension]));
    return NextResponse.json({
      phones: syncedRows.map((p) => ({
        ...p,
        extension: extensionByPhone[p.id] || null,
        recent_events: eventsByPhone[p.id]?.events || 0,
        ...resolveSipRegistrationStatus(p, registrationByPhone[p.id]),
      })),
      availablePhoneNumbers,
      config: hardphoneConfigStatus(user),
    });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_list_failed", runtimePayload({ error: err, operation: "hp_list" }));
    return NextResponse.json({ error: "Failed to load phones" }, { status: 500 });
  }
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  if (!process.env.TELNYX_PHONE_ADMIN_PASSWORD) {
    return NextResponse.json({ error: "TELNYX_PHONE_ADMIN_PASSWORD must be configured before adding hard phones" }, { status: 400 });
  }
  if (!process.env.TELNYX_OUTBOUND_VOICE_PROFILE) {
    return NextResponse.json({ error: "TELNYX_OUTBOUND_VOICE_PROFILE must be configured before adding hard phones" }, { status: 400 });
  }
  try {
    const body = await request.json();
    const mac = normalizeMac(body?.mac);
    const vendor = String(body?.vendor || "").toLowerCase();
    if (!mac) return NextResponse.json({ error: "Valid 12-hex-digit MAC address is required" }, { status: 400 });
    if (!SUPPORTED_VENDORS.includes(vendor)) {
      return NextResponse.json({ error: `Vendor must be one of: ${SUPPORTED_VENDORS.join(", ")}` }, { status: 400 });
    }
    const { rows: existing } = await pool.query(`SELECT id FROM hp_phones WHERE mac = $1`, [mac]);
    if (existing.length) return NextResponse.json({ error: "A phone with this MAC already exists" }, { status: 409 });

    const phoneName = String(body?.phone_name || "").trim() || null;
    const label = validatePhoneLineLabel(body?.label, vendor);
    const model = String(body?.model || "").trim() || null;
    const assignedPhoneNumberId = String(body?.assigned_phone_number_id || "").trim() || null;
    if (!assignedPhoneNumberId && body.assigned_phone_number) return NextResponse.json({ error: "Select a DID from the Telnyx inventory" }, { status: 400 });
    const selectedNumber = assignedPhoneNumberId ? await ownedVoiceNumber(assignedPhoneNumberId) : null;
    const assignedPhoneNumber = selectedNumber?.number || null;
    let connection = { id: null, connection_id: null, connection_name: null, sip_username: null, sip_password: null };
    const assignedNumber = selectedNumber ? { id: selectedNumber.id, phone_number: selectedNumber.number } : null;
    try {
      connection = await createPhoneSipConnection({ mac, vendor, model });
    } catch (err) {
      adminRuntimeLogger.error("hardphone_credential_failed", runtimePayload({ error: err, operation: "hp_sip_connection_create" }));
      if (connection?.id) await deletePhoneSipConnection(connection.id);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }

    let client = null;
    let commitStarted = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const adminPassword = process.env.TELNYX_PHONE_ADMIN_PASSWORD;
      const numberValue = assignedNumber?.phone_number || assignedPhoneNumber || null;
      const numberId = assignedNumber?.id || assignedPhoneNumberId || null;
      const ipAddress = null;
      const { rows } = await client.query(
        `INSERT INTO hp_phones (phone_name, mac, vendor, model, label, agent_id, telnyx_credential_id, telnyx_connection_id, telnyx_connection_name,
          assigned_phone_number_id, assigned_phone_number, sip_username, sip_password, admin_password, settings, ip_address, local_bridge_id, provisioning_state, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending', $18)
         RETURNING ${PHONE_COLUMNS}`,
        [
          phoneName,
          mac,
          vendor,
          model,
          label,
          String(body?.agent_id || "").trim() || null,
          connection.id,
          connection.connection_id || connection.id,
          connection.connection_name,
          numberId,
          numberValue,
          connection.sip_username,
          connection.sip_password,
          adminPassword,
          JSON.stringify({ ...(body?.settings && typeof body.settings === "object" ? body.settings : {}), outbound_caller_id_configured: true }),
          ipAddress,
          String(body?.local_bridge_id || body?.settings?.local_bridge_id || "").trim() || null,
          user.id || user.email || null,
        ],
      );
      await client.query(
        `INSERT INTO hp_provisioning_events (phone_id, mac, event_type, detail) VALUES ($1, $2, 'created', $3)`,
        [rows[0].id, mac, JSON.stringify({ vendor, credential_connection_id: connection.connection_id || connection.id, assigned_phone_number: numberValue })],
      );
      commitStarted = true;
      await client.query("COMMIT");
      return NextResponse.json({ phone: rows[0] }, { status: 201 });
    } catch (err) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackErr) {
          adminRuntimeLogger.error("hardphone_create_rollback_failed", runtimePayload({ error: rollbackErr, operation: "hp_create_rollback" }));
        }
      }
      if (connection.id && !commitStarted) {
        try {
          await deletePhoneSipConnection(connection.id);
        } catch (cleanupErr) {
          adminRuntimeLogger.error(
            "hardphone_credential_cleanup_failed",
            runtimePayload({ error: cleanupErr, operation: "hp_sip_connection_cleanup", connection_id: connection.id }),
          );
        }
      }
      throw err;
    } finally {
      if (client) client.release();
    }
  } catch (err) {
    adminRuntimeLogger.error("hardphone_create_failed", runtimePayload({ error: err, operation: "hp_create" }));
    return NextResponse.json({ error: err.status ? err.message : "Failed to create phone" }, { status: err.status || 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("phones:read", GET_handler, { route: "/api/admin/phones-provisioning/phones" });
export const POST = withPermission("phones:create", POST_handler, { route: "/api/admin/phones-provisioning/phones" });
