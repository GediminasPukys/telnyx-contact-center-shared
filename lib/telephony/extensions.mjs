import { randomUUID } from "node:crypto";

export const EXTENSION_TYPES = ["user", "queue", "phone"];
export const telephonyError = (status, message) => Object.assign(new Error(message), { status });
const fail = telephonyError;
export async function telephonyTransaction(pool, work) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Serialize directory changes, including overlap checks and assign/unassign.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('cc:extension-directory',0))");
    const value = await work(db);
    await db.query("COMMIT");
    return value;
  } catch (e) { await db.query("ROLLBACK"); throw e; }
  finally { db.release(); }
}
export function validatePool(body) {
  const digits = Number(body.digits), start = Number(body.start), end = Number(body.end);
  const types = Array.isArray(body.types) ? [...new Set(body.types)] : [];
  if (!String(body.name || "").trim() || String(body.name).length > 80
    || ![3,4,5].includes(digits) || !Number.isInteger(start) || !Number.isInteger(end)
    || start < 10 ** (digits-1) || end >= 10 ** digits || end < start
    || types.length !== 1 || types.some(type => !EXTENSION_TYPES.includes(type))) throw fail(400, "Choose one object category: phones, users or queues");
  // Service numbers must never be allocated as ordinary extensions.
  if ([112,911,999].some(number => number >= start && number <= end)) throw fail(400, "The range includes a reserved service number");
  return { name: String(body.name).trim(), digits, start, end, types };
}
export async function saveExtensionPool(pool, actor, body) {
  const input = validatePool(body);
  return telephonyTransaction(pool, async db => {
    const id = body.id || randomUUID();
    const old = (await db.query("SELECT * FROM cc_extension_pools WHERE id=$1", [id])).rows[0];
    if (body.id && !old) throw fail(404, "Pool not found");
    const overlap = await db.query("SELECT 1 FROM cc_extension_pools WHERE id<>$1 AND start_number<=$3 AND end_number>=$2", [id,input.start,input.end]);
    if (overlap.rowCount) throw fail(409, "This range overlaps an existing pool");
    const bound = await db.query("SELECT target_type FROM cc_extension_pool_types WHERE pool_id<>$1 AND target_type=ANY($2::text[])", [id,input.types]);
    if (bound.rowCount) throw fail(409, "An object type already has a pool. Edit that pool first.");
    const stranded = await db.query(`SELECT 1 FROM cc_extension_assignments WHERE pool_id=$1
      AND (number::int<$2 OR number::int>$3 OR NOT(target_type=ANY($4::text[])))`,[id,input.start,input.end,input.types]);
    if (stranded.rowCount) throw fail(409, "Reassign allocated numbers before changing this range or its object types");
    await db.query(`INSERT INTO cc_extension_pools(id,name,digits,start_number,end_number) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET name=$2,digits=$3,start_number=$4,end_number=$5`,[id,input.name,input.digits,input.start,input.end]);
    await db.query("DELETE FROM cc_extension_pool_types WHERE pool_id=$1",[id]);
    for (const type of input.types) await db.query("INSERT INTO cc_extension_pool_types(target_type,pool_id) VALUES($1,$2)",[type,id]);
    await db.query("INSERT INTO cc_station_audit(actor_id,action,target_id,detail) VALUES($1,'pool_saved',$2,$3)",[actor,id,JSON.stringify(input)]);
    return { id };
  });
}
export async function deleteExtensionPool(pool, actor, id) {
  return telephonyTransaction(pool, async db => {
    if ((await db.query("SELECT 1 FROM cc_extension_assignments WHERE pool_id=$1",[id])).rowCount) throw fail(409, "This pool still has assigned numbers");
    await db.query("DELETE FROM cc_extension_pools WHERE id=$1",[id]);
    await db.query("INSERT INTO cc_station_audit(actor_id,action,target_id) VALUES($1,'pool_deleted',$2)",[actor,id]);
    return { ok:true };
  });
}
export async function syncStationInventory(db) {
  await db.query(`INSERT INTO cc_phone_stations(name,kind,phone_id,owner_id,shared,connection_id,sip_username)
    SELECT COALESCE(NULLIF(p.phone_name,''),NULLIF(p.label,''),p.model,p.mac),'deskphone',p.id,u.id,u.id IS NULL,
      COALESCE(p.telnyx_connection_id,p.telnyx_credential_id),p.sip_username
    FROM hp_phones p LEFT JOIN users u ON u.id=p.agent_id ON CONFLICT(phone_id)
    DO UPDATE SET connection_id=EXCLUDED.connection_id,sip_username=EXCLUDED.sip_username,name=EXCLUDED.name,
      shared=CASE WHEN cc_phone_stations.owner_id IS DISTINCT FROM EXCLUDED.owner_id THEN EXCLUDED.shared ELSE cc_phone_stations.shared END,
      owner_id=EXCLUDED.owner_id`);
}
export async function ensureWebStation(db, user) {
  return (await db.query(`INSERT INTO cc_phone_stations(name,kind,owner_id)
    VALUES($1,'webrtc',$2) ON CONFLICT(owner_id) WHERE kind='webrtc'
    DO UPDATE SET owner_id=EXCLUDED.owner_id RETURNING *`,
  [`${user.first_name || user.username || "User"} — WebRTC`,String(user.id)])).rows[0];
}
export async function resolveExtensionObject(db, type, id, { lock = false } = {}) {
  if (!EXTENSION_TYPES.includes(type) || !id) throw fail(400, "Invalid extension target");
  let result;
  if (type === "user") result = await db.query(`SELECT id, COALESCE(NULLIF(trim(concat_ws(' ',first_name,last_name)),''),username) AS name FROM users WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,[id]);
  else if (type === "queue") result = await db.query(`SELECT id,COALESCE(display_name,name) AS name FROM cc_queues WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,[id]);
  else {
    await syncStationInventory(db);
    result = await db.query(`SELECT id,name,phone_id FROM cc_phone_stations WHERE (id::text=$1 OR phone_id::text=$1) ${lock ? "FOR UPDATE" : ""}`,[id]);
  }
  if (!result.rows[0]) throw fail(404, "Object not found");
  return result.rows[0];
}
export async function assignExtension(pool, actor, { type, targetId, number, expectedNumber }) {
  return telephonyTransaction(pool, async db => {
    const object = await resolveExtensionObject(db,type,targetId,{lock:true});
    const column = type === "user" ? "user_id" : type === "queue" ? "queue_id" : "station_id";
    const current = (await db.query(`SELECT number FROM cc_extension_assignments WHERE ${column}=$1`,[object.id])).rows[0]?.number || null;
    if (expectedNumber !== undefined && (expectedNumber || null) !== current) throw fail(409,"This assignment changed. Refresh before saving.");
    if (number === current) return {number};
    if (number) {
      if (!/^[1-9]\d{2,4}$/.test(String(number))) throw fail(400,"Invalid extension");
      const poolRow = (await db.query(`SELECT p.* FROM cc_extension_pools p JOIN cc_extension_pool_types t ON t.pool_id=p.id
        WHERE t.target_type=$1 AND $2::int BETWEEN p.start_number AND p.end_number`,[type,number])).rows[0];
      if (!poolRow) throw fail(400,"Choose a number from the pool assigned to this object type");
      if ((await db.query("SELECT 1 FROM cc_extension_assignments WHERE number=$1",[number])).rowCount) throw fail(409,"This extension is already assigned");
      if ((await db.query("SELECT 1 FROM users WHERE extension=$1 AND ($2::text IS NULL OR id<>$2)",[String(number),type==="user"?object.id:null])).rowCount) throw fail(409,"This extension is already assigned to a user in the legacy directory");
      await db.query(`DELETE FROM cc_extension_assignments WHERE ${column}=$1`,[object.id]);
      await db.query(`INSERT INTO cc_extension_assignments(number,pool_id,target_type,${column}) VALUES($1,$2,$3,$4)`,[String(number),poolRow.id,type,object.id]);
    } else await db.query(`DELETE FROM cc_extension_assignments WHERE ${column}=$1`,[object.id]);
    if (type === "user") await db.query("UPDATE users SET extension=$2 WHERE id=$1",[object.id,number||null]);
    await db.query("INSERT INTO cc_station_audit(actor_id,action,target_id,detail) VALUES($1,'extension_assigned',$2,$3)",
      [actor,object.id,JSON.stringify({type,previous:current,number:number||null})]);
    return { number: number || null };
  });
}
export async function extensionChoices(db, type, targetId, search = "") {
  const object = await resolveExtensionObject(db,type,targetId);
  const column = type === "user" ? "user_id" : type === "queue" ? "queue_id" : "station_id";
  const current = (await db.query(`SELECT number FROM cc_extension_assignments WHERE ${column}=$1`,[object.id])).rows[0]?.number || null;
  const pool = (await db.query("SELECT p.* FROM cc_extension_pools p JOIN cc_extension_pool_types t ON t.pool_id=p.id WHERE t.target_type=$1",[type])).rows[0] || null;
  const numbers = pool ? (await db.query(`SELECT n::text AS number FROM generate_series($1::int,$2::int) n
    WHERE (NOT EXISTS(SELECT 1 FROM cc_extension_assignments a WHERE a.number=n::text) OR n::text=$3)
    AND NOT EXISTS(SELECT 1 FROM users u WHERE u.extension=n::text AND ($5::text IS NULL OR u.id<>$5))
    AND n::text LIKE $4 ORDER BY n LIMIT 100`,[pool.start_number,pool.end_number,current,`${String(search).replace(/[^0-9]/g,"")}%`,type==="user"?object.id:null])).rows.map(r=>r.number) : [];
  return { object, current, pool, numbers };
}
export async function extensionDirectory(db, { search = "", type = null } = {}) {
  // Inventory totals are independent of the directory filter and its row limit.
  const counts = (await db.query(`SELECT
    (SELECT count(*)::int FROM users WHERE active=true) AS "user",
    (SELECT count(*)::int FROM cc_queues) AS queue,
    (SELECT count(*)::int FROM cc_phone_stations) AS phone`)).rows[0];
  const pools = (await db.query(`SELECT p.*,ARRAY(SELECT target_type FROM cc_extension_pool_types t WHERE t.pool_id=p.id ORDER BY target_type) AS types,
    (SELECT count(*)::int FROM cc_extension_assignments a WHERE a.pool_id=p.id) AS used FROM cc_extension_pools p ORDER BY start_number`)).rows;
  const objects = (await db.query(`WITH objects AS (
    SELECT 'user' AS type,id,COALESCE(NULLIF(trim(concat_ws(' ',first_name,last_name)),''),username) AS name,username AS detail,NULL::text AS kind FROM users WHERE active=true
    UNION ALL SELECT 'queue',id,COALESCE(display_name,name),'Queue',NULL::text FROM cc_queues
    UNION ALL SELECT 'phone',s.id::text,s.name,COALESCE(p.model,CASE WHEN s.kind='webrtc' THEN 'WebRTC' ELSE 'SIP client' END),s.kind
      FROM cc_phone_stations s LEFT JOIN hp_phones p ON p.id=s.phone_id)
    SELECT o.*,a.number FROM objects o LEFT JOIN cc_extension_assignments a
      ON a.target_type=o.type AND COALESCE(a.user_id,a.queue_id,a.station_id::text)=o.id
    WHERE ($1::text IS NULL OR o.type=$1) AND (o.name ILIKE $2 OR o.detail ILIKE $2 OR a.number ILIKE $2)
    ORDER BY o.type,o.name LIMIT 150`,[type,`%${search.slice(0,100)}%`])).rows;
  return { pools, objects, counts };
}
