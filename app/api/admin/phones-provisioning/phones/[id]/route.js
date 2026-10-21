import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { SUPPORTED_VENDORS, validatePhoneLineLabel } from "@/lib/hardphones/config-generators.mjs";
import { deleteLegacyPhoneCredential, deletePhoneSipConnection, clearPhoneSipConnectionCallerId } from "@/lib/hardphones/credentials.mjs";
import { ownedVoiceNumber } from "@/lib/telephony/dialing.mjs";
import { syncHardphonePhoneNumbersFromTelnyx } from "@/lib/hardphones/number-sync.mjs";
import { adminRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { withStationMaintenance } from "@/lib/telephony/stations.mjs";
import { syncStationInventory } from "@/lib/telephony/extensions.mjs";
import { synchronizePolycomLineLabel } from "@/lib/hardphones/polycom-provisioning.mjs";


const PHONE_COLUMNS = `id, phone_name, mac, vendor, model, label, agent_id, telnyx_credential_id, telnyx_connection_id, telnyx_connection_name,
  assigned_phone_number_id, assigned_phone_number, sip_username,
  settings, provisioning_state, ip_address, last_ip, local_bridge_id, last_seen_at, last_user_agent, created_at, updated_at`;

async function GET_handler(_request, { params }, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const { rows } = await pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones WHERE id = $1`, [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    let phone = rows[0];
    [phone] = await syncHardphonePhoneNumbersFromTelnyx(pool, [phone]).catch(() => [phone]);
    const { rows: events } = await pool.query(
      `SELECT id, event_type, detail, created_at FROM hp_provisioning_events WHERE phone_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [id],
    );
    return NextResponse.json({ phone, events });
  } catch {
    return NextResponse.json({ error: "Failed to load phone" }, { status: 500 });
  }
}

async function PUT_handler(request, { params }, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const body = await request.json();
    const { rows: existingRows } = await pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones WHERE id = $1`, [id]);
    if (!existingRows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const existingPhone = existingRows[0];
    const columns = [];
    const values = [];
    let idx = 1;
    if (body.vendor !== undefined) {
      const vendor = String(body.vendor || "").toLowerCase();
      if (!SUPPORTED_VENDORS.includes(vendor)) return NextResponse.json({ error: "Unsupported vendor" }, { status: 400 });
      columns.push(`vendor = $${idx++}`); values.push(vendor);
    }
    if (body.phone_name !== undefined) { columns.push(`phone_name = $${idx++}`); values.push(String(body.phone_name || "").trim() || null); }
    if (body.model !== undefined) { columns.push(`model = $${idx++}`); values.push(String(body.model || "").trim() || null); }
    if (body.label !== undefined) { columns.push(`label = $${idx++}`); values.push(validatePhoneLineLabel(body.label, body.vendor || existingPhone.vendor)); }
    if (body.agent_id !== undefined) { columns.push(`agent_id = $${idx++}`); values.push(String(body.agent_id || "").trim() || null); }
    if (body.ip_address !== undefined) { columns.push(`ip_address = $${idx++}`); values.push(String(body.ip_address || "").trim() || null); }
    if (body.local_bridge_id !== undefined) { columns.push(`local_bridge_id = $${idx++}`); values.push(String(body.local_bridge_id || "").trim() || null); }
    if (body.settings !== undefined) { columns.push(`settings = $${idx++}`); values.push(JSON.stringify(body.settings && typeof body.settings === "object" ? body.settings : {})); }
    if (body.assigned_phone_number_id !== undefined || body.assigned_phone_number !== undefined) {
      const nextNumberId = String(body.assigned_phone_number_id || "").trim() || null;
      const assigned = nextNumberId ? await ownedVoiceNumber(nextNumberId) : null;
      if (!nextNumberId && body.assigned_phone_number) return NextResponse.json({ error: "Select a DID from the Telnyx inventory" }, { status: 400 });
      const connectionId = existingPhone.telnyx_connection_id || existingPhone.telnyx_credential_id;
      await clearPhoneSipConnectionCallerId({ connectionId });
      columns.push(`assigned_phone_number_id = $${idx++}`); values.push(assigned?.id || null);
      columns.push(`assigned_phone_number = $${idx++}`); values.push(assigned?.number || null);
    }

    if (body.provisioning_state !== undefined) {
      const state = String(body.provisioning_state || "");
      if (!["pending", "provisioned", "disabled"].includes(state)) return NextResponse.json({ error: "Invalid provisioning_state" }, { status: 400 });
      columns.push(`provisioning_state = $${idx++}`); values.push(state);
    }
    if (!columns.length) return NextResponse.json({ error: "No changes" }, { status: 400 });
    values.push(id);
    await pool.query(`UPDATE hp_phones SET ${columns.join(", ")} WHERE id = $${idx}`, values);
    if (body.assigned_phone_number_id !== undefined || body.assigned_phone_number !== undefined) {
      await pool.query("UPDATE hp_phones SET settings=jsonb_set(COALESCE(settings,'{}'::jsonb),'{outbound_caller_id_configured}','true'::jsonb) WHERE id=$1", [id]);
    }
    await syncStationInventory(pool);
    const { rows } = await pool.query(`SELECT ${PHONE_COLUMNS} FROM hp_phones WHERE id = $1`, [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const displaySync = body.label !== undefined && rows[0].vendor === "polycom" && rows[0].provisioning_state === "provisioned"
      ? await synchronizePolycomLineLabel(pool, rows[0], { force:true }).catch(() => ({ok:false,reason:"phone_unreachable"})) : null;
    return NextResponse.json({ phone: rows[0], displaySync: displaySync ? { ok:displaySync.ok, reason:displaySync.reason } : null });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_update_failed", runtimePayload({ error: err, operation: "hp_update" }));
    return NextResponse.json({ error: err.status ? err.message : "Failed to update phone" }, { status: err.status || 500 });
  }
}

async function DELETE_handler(_request, { params }, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const { id } = await params;
    const { rows } = await pool.query(`SELECT telnyx_connection_id, telnyx_credential_id, mac FROM hp_phones WHERE id = $1`, [id]);
    if (!rows.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const credentialDeleted = rows[0].telnyx_connection_id
      ? await deletePhoneSipConnection(rows[0].telnyx_connection_id)
      : await deleteLegacyPhoneCredential(rows[0].telnyx_credential_id);
    await pool.query(`DELETE FROM hp_provisioning_events WHERE phone_id = $1`, [id]);
    await pool.query(`DELETE FROM hp_phones WHERE id = $1`, [id]);
    return NextResponse.json({ ok: true, credentialDeleted });
  } catch (err) {
    adminRuntimeLogger.error("hardphone_delete_failed", runtimePayload({ error: err, operation: "hp_delete" }));
    return NextResponse.json({ error: "Failed to delete phone" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
const maintenance = handler => async (request,context,authz) => {
  if(authz.user.experimental_features!==true)return NextResponse.json({error:"Forbidden"},{status:403});
  const {id}=await context.params;
  return withStationMaintenance(getPostgresPool(),id,()=>handler(request,context,authz));
};
export const GET = withPermission("phones:read", GET_handler, { route: "/api/admin/phones-provisioning/phones/[id]" });
export const PUT = withPermission("phones:update", maintenance(PUT_handler), { route: "/api/admin/phones-provisioning/phones/[id]" });
export const DELETE = withPermission("phones:delete", maintenance(DELETE_handler), { route: "/api/admin/phones-provisioning/phones/[id]" });
