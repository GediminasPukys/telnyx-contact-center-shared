import { buildTelnyxV2Url } from "../telnyx.js";
import { voiceReachableSql } from "../acd/push-readiness.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
export const isExtension = value => /^[1-9]\d{2,4}$/.test(String(value || "").trim());
export const isE164 = value => /^\+[1-9]\d{6,14}$/.test(String(value || "").trim());

export async function ensureDialingSchema(db) {
  await db.query(`ALTER TABLE cc_queues ADD COLUMN IF NOT EXISTS outbound_number_id TEXT;
    ALTER TABLE cc_queues ADD COLUMN IF NOT EXISTS outbound_number TEXT;`);
}

async function numberRequest(path) {
  const response = await fetch(buildTelnyxV2Url(path), {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
    cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw fail(response.status === 404 ? 400 : 502, "Could not verify the number in the Telnyx account.");
  return response.json();
}

// A number ID, never a caller-supplied telephone number, is accepted by queue administration.
export async function ownedVoiceNumber(id) {
  if (!id) return null;
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(String(id))) throw fail(400, "Select a number from the Telnyx account.");
  const { data } = await numberRequest(`/phone_numbers/${encodeURIComponent(id)}`);
  if (data?.status !== "active" || !isE164(data?.phone_number))
    throw fail(400, "Select an active Telnyx phone number.");
  return { id: String(data.id), number: data.phone_number };
}

export async function ownedVoiceNumbers({ query = "", page = 1 } = {}) {
  const params = new URLSearchParams({ "page[size]": "50", "page[number]": String(Math.max(1, Math.min(10000, Number(page) || 1))), "filter[status]": "active" });
  if (query.trim()) params.set("filter[phone_number]", query.trim());
  const result = await numberRequest(`/phone_numbers?${params}`);
  return { items: (result.data || []).filter(n => isE164(n.phone_number)).map(n => ({ id: String(n.id), number: n.phone_number })), meta: result.meta };
}

export async function outboundIdentities(db, agentId) {
  const user = (await db.query("SELECT voice_number FROM users WHERE id=$1", [agentId])).rows[0];
  const queues = (await db.query(`SELECT q.id,COALESCE(NULLIF(q.display_name,''),q.name) AS name,q.outbound_number
    FROM cc_queue_user_assignments a JOIN cc_queues q ON q.id=a.queue_id
    WHERE a.user_id=$1 AND a.enabled=true AND q.enabled=true AND q.active=true
      AND q.outbound_number_id IS NOT NULL AND q.outbound_number IS NOT NULL
    ORDER BY name,q.id`, [agentId])).rows;
  return [
    { id: "personal", kind: "personal", label: "My number", number: user?.voice_number || null, available: isE164(user?.voice_number) },
    ...queues.map(q => ({ id: `queue:${q.id}`, kind: "queue", queueId: q.id, label: q.name, number: q.outbound_number, available: true })),
  ];
}

export async function resolveOutboundIdentity(db, agentId, source = "personal", { internal = false } = {}) {
  const identities = await outboundIdentities(db, agentId);
  // On-net calls never inherit the previously selected queue's outbound reporting context.
  const selected = identities.find(i => i.id === (internal ? "personal" : source));
  if (!selected) throw fail(403, "You cannot call on behalf of this queue.");
  if (!selected.available && !internal) throw fail(409, "Set your Voice Number or select a queue with an outbound number.");
  if (selected.kind === "queue") {
    const queue = (await db.query("SELECT outbound_number_id FROM cc_queues WHERE id=$1",[selected.queueId])).rows[0];
    const current = await ownedVoiceNumber(queue?.outbound_number_id);
    if (!current || current.number !== selected.number) throw fail(409,"This queue's outbound number is no longer available.");
  }
  return { ...selected, number: selected.number || (internal ? process.env.TELNYX_MAIN_FROM_NUMBER : null) };
}

export async function lookupExtension(db, number) {
  if (!isExtension(number)) throw fail(400, "Enter a 3–5 digit extension.");
  const row = (await db.query(`SELECT a.*,COALESCE(NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.username,
      NULLIF(q.display_name,''),q.name,s.name) AS name
    FROM cc_extension_assignments a JOIN cc_extension_pools p ON p.id=a.pool_id
    JOIN cc_extension_pool_types t ON t.pool_id=p.id AND t.target_type=a.target_type
    LEFT JOIN users u ON u.id=a.user_id LEFT JOIN cc_queues q ON q.id=a.queue_id
    LEFT JOIN cc_phone_stations s ON s.id=a.station_id
    WHERE a.number=$1 AND a.number::int BETWEEN p.start_number AND p.end_number`, [String(number).trim()])).rows[0];
  if (!row) throw fail(404, "This extension is not assigned.");
  return row;
}

export async function resolveDialTarget(db, input, { callerId = null } = {}) {
  const value = String(input || "").trim();
  if (isExtension(value)) {
    const entry = await lookupExtension(db, value);
    const base = { internal: true, extension: value, type: entry.target_type, label: entry.name, queueId: entry.queue_id, userId: entry.user_id, stationId: entry.station_id };
    if (entry.target_type === "queue") {
      const queue = (await db.query("SELECT id FROM cc_queues WHERE id=$1 AND enabled=true AND active=true", [entry.queue_id])).rows[0];
      if (!queue) throw fail(409, "This queue is unavailable.");
      // This is the browser's origination address, never a provider customer Dial.
      // Core answers the originator and enqueues that leg locally.
      return { ...base, destination: `sip:queue-${entry.queue_id}@sip.telnyx.com` };
    }
    let sip;
    if (entry.target_type === "user") {
      if (String(entry.user_id) === String(callerId)) throw fail(409, "This is your own extension.");
      const endpoint = (await db.query(`SELECT e.sip_username FROM cc_agent_voice_preferences p
        JOIN cc_voice_endpoints e ON e.id=p.endpoint_id
        WHERE p.agent_id=$1 AND ${voiceReachableSql("e")}`, [entry.user_id])).rows[0];
      sip = endpoint?.sip_username;
      if (!sip) throw fail(409, "This user has no available selected phone.");
    } else {
      const station = (await db.query(`SELECT s.*,COALESCE(h.sip_username,s.sip_username) AS identity,
        l.agent_id AS occupant_id FROM cc_phone_stations s LEFT JOIN hp_phones h ON h.id=s.phone_id
        LEFT JOIN cc_station_leases l ON l.station_id=s.id AND l.purpose='work'
        WHERE s.id=$1 AND s.enabled=true AND (h.id IS NULL OR h.provisioning_state<>'disabled')`, [entry.station_id])).rows[0];
      if (!station) throw fail(409, "This phone is unavailable.");
      if (station.kind === "webrtc") {
        const endpoint = (await db.query(`SELECT e.sip_username FROM cc_agent_voice_preferences p JOIN cc_voice_endpoints e ON e.id=p.endpoint_id
          WHERE p.agent_id=$1 AND e.station_id=$2 AND ${voiceReachableSql("e")}`, [station.owner_id, station.id])).rows[0];
        sip = endpoint?.sip_username;
      } else sip = station.identity;
      base.userId = station.occupant_id || null;
      if (base.userId && String(base.userId) === String(callerId)) throw fail(409, "This is your current phone.");
      if (!sip) throw fail(409, "This phone has no available SIP identity.");
    }
    if (base.userId) {
      const occupied = await db.query("SELECT 1 FROM acd_reservations WHERE agent_id=$1 AND channel IN ('voice','video') AND state<>'released' LIMIT 1", [base.userId]);
      if (occupied.rowCount) throw fail(409, "This user is already on a call.");
    }
    return { ...base, destination: `sip:${sip}@sip.telnyx.com` };
  }
  if (isE164(value)) return { internal: false, type: "external", destination: value, label: value };
  if (/^sip:[^@\s<>]+@[a-z0-9.-]+(?::\d+)?$/i.test(value)) {
    const username = value.match(/^sip:([^@]+)@sip\.telnyx\.com$/i)?.[1];
    const targetUser = username ? (await db.query("SELECT id FROM users WHERE lower(telephony_user_name)=lower($1)",[username])).rows[0] : null;
    if (targetUser && String(targetUser.id) === String(callerId)) throw fail(409,"This is your current phone.");
    return { internal: true, type: "sip", destination: value, label: value, userId:targetUser?.id || null };
  }
  throw fail(400, "Enter an assigned extension, an international number beginning with +, or a SIP address.");
}
