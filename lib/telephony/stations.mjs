import { randomUUID, randomBytes, createHash } from "node:crypto";
import { ensureAgentState } from "../acd/agent-state.mjs";
import { hasVoiceWork, voiceLockKey, applyVoiceSelection, readVoiceEndpoints, retireStationEndpoints } from "../acd/voice-endpoints.mjs";
import { checkPhoneSipRegistrationStatus } from "../hardphones/credentials.mjs";
import { syncStationInventory, ensureWebStation, telephonyError as fail } from "./extensions.mjs";

const native = kind => ["deskphone", "sip"].includes(kind);
const hash = value => createHash("sha256").update(value).digest("hex");
export const STATION_LEASE_SECONDS = 60;
export function stationAccessible(station, user) {
  return station.enabled && (station.shared || station.owner_id === String(user.id))
    && (!native(station.kind) || user.experimental_features === true);
}

export async function stationInventory(db, user, { admin = false } = {}) {
  await syncStationInventory(db);
  if (!admin) await ensureWebStation(db, user);
  const rows = (await db.query(`SELECT s.id,s.name,s.kind,s.phone_id,s.owner_id,s.shared,s.enabled,
      s.registration_status,s.registration_checked_at,s.connection_id,s.sip_username,
      p.vendor,p.model,p.mac,p.provisioning_state,
      a.number AS extension,l.agent_id AS occupant_id,l.auth_session_id,l.generation AS lease_generation,
      l.expires_at,l.purpose,
      COALESCE(NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.username) AS occupant_name,
      COALESCE(NULLIF(trim(concat_ws(' ',owner.first_name,owner.last_name)),''),owner.username) AS owner_name,
      (l.station_id IS NOT NULL AND (l.expires_at>now() OR EXISTS(SELECT 1 FROM acd_reservations r
        WHERE r.agent_id=l.agent_id AND r.channel IN ('voice','video') AND r.state<>'released')
        OR EXISTS(SELECT 1 FROM acd_agent_state state WHERE state.agent_id=l.agent_id AND state.workflow_state<>'idle'
          AND (state.workflow_work_item_id IS NULL OR NOT EXISTS(SELECT 1 FROM acd_work_items w
            WHERE w.id=state.workflow_work_item_id AND w.channel NOT IN ('voice','video')))))) AS occupied
    FROM cc_phone_stations s LEFT JOIN hp_phones p ON p.id=s.phone_id
    LEFT JOIN cc_extension_assignments a ON a.station_id=s.id
    LEFT JOIN cc_station_leases l ON l.station_id=s.id
    LEFT JOIN users u ON u.id=l.agent_id LEFT JOIN users owner ON owner.id=s.owner_id
    ORDER BY CASE s.kind WHEN 'webrtc' THEN 0 ELSE 1 END,s.name`)).rows;
  return rows.filter(s => admin || stationAccessible(s, user)).map(s => {
    const mine = s.occupant_id === String(user.id) && s.auth_session_id === user.authSessionId;
    const { auth_session_id, ...safe } = s;
    return { ...safe, mine, busy: s.occupied && !mine };
  });
}

export async function readLoginChoice(db, user) {
  if (!user.authSessionId) return null;
  const choice = (await db.query(`SELECT c.*,s.name,s.enabled,p.vendor,p.model,
    ((p.vendor IN ('polycom','yealink') AND COALESCE(p.settings->>'cti_mode','direct')<>'telnyx')
      OR (p.vendor='audiocodes' AND p.settings->>'cti_mode' IN ('sip_controller','desktop_bridge'))) AS native_control,
    l.generation AS lease_generation,l.expires_at,l.endpoint_id,
    e.revoked_at FROM cc_voice_login_choices c
    LEFT JOIN cc_phone_stations s ON s.id=c.station_id
    LEFT JOIN hp_phones p ON p.id=s.phone_id
    LEFT JOIN cc_station_leases l ON l.station_id=c.station_id AND l.auth_session_id=c.auth_session_id AND l.agent_id=c.agent_id
    LEFT JOIN cc_voice_endpoints e ON e.id=l.endpoint_id
    WHERE c.auth_session_id=$1 AND c.agent_id=$2`, [user.authSessionId,String(user.id)])).rows[0];
  if (!choice || (choice.kind !== "none" && (!choice.enabled || !choice.lease_generation || choice.revoked_at))) return null;
  return choice;
}

// A single station directory lock serializes claims/releases. Voice locks are
// acquired in a stable order before locking agent rows, as in ACD admission.
async function stationTransaction(pool, agentIds, work) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('cc:station-leases',0))");
    const ids = [...new Set(await agentIds(db))].filter(Boolean).sort();
    const states = new Map();
    for (const id of ids) {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [voiceLockKey(id)]);
      await ensureAgentState(db, id);
      states.set(id, (await db.query("SELECT * FROM acd_agent_state WHERE agent_id=$1 FOR UPDATE", [id])).rows[0]);
    }
    const value = await work(db, states);
    await db.query("COMMIT");
    return value;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}

async function retireLease(db, lease, actor, reason) {
  if (!lease) return;
  if (lease.endpoint_id) {
    await retireStationEndpoints(db, {stationId:lease.station_id,agentId:lease.agent_id,authSessionId:lease.auth_session_id});
    const changed = await db.query(`UPDATE cc_agent_voice_preferences SET endpoint_id=NULL,generation=generation+1
      WHERE agent_id=$1 AND endpoint_id IN (SELECT id FROM cc_voice_endpoints WHERE station_id=$2 AND agent_id=$1 AND auth_session_id=$3)
      RETURNING agent_id`, [lease.agent_id,lease.station_id,lease.auth_session_id]);
    if (changed.rowCount) await db.query("UPDATE users SET telephony_credentials_id=NULL,telephony_user_name=NULL WHERE id=$1", [lease.agent_id]);
  }
  await db.query("DELETE FROM cc_voice_login_choices WHERE auth_session_id=$1 AND station_id=$2", [lease.auth_session_id,lease.station_id]);
  await db.query("DELETE FROM cc_station_leases WHERE station_id=$1", [lease.station_id]);
  await db.query("INSERT INTO cc_station_audit(actor_id,action,target_id,detail) VALUES($1,'station_released',$2,$3)",
    [actor,lease.station_id,JSON.stringify({ agentId:lease.agent_id,reason })]);
}

export async function refreshStationRegistration(db, stationId, { force = false, check = checkPhoneSipRegistrationStatus } = {}) {
  const s = (await db.query(`SELECT s.*,p.vendor,p.model,COALESCE(p.telnyx_connection_id,p.telnyx_credential_id,s.connection_id) AS sip_connection,
    COALESCE(p.sip_username,s.sip_username) AS username,p.provisioning_state,
    ((p.vendor IN ('polycom','yealink') AND COALESCE(p.settings->>'cti_mode','direct')<>'telnyx')
      OR (p.vendor='audiocodes' AND p.settings->>'cti_mode' IN ('sip_controller','desktop_bridge'))) AS native_control
    FROM cc_phone_stations s LEFT JOIN hp_phones p ON p.id=s.phone_id WHERE s.id=$1`, [stationId])).rows[0];
  if (!s) throw fail(404, "Station not found");
  if (s.kind === "webrtc") return s;
  if (!s.sip_connection || !s.username || s.provisioning_state === "disabled") throw fail(409, "Provision this station before selecting it");
  if (!force && s.registration_checked_at && Date.now()-new Date(s.registration_checked_at).getTime()<15000) return s;
  let status = "unknown";
  try { status = (await check(s.sip_connection))?.registration_status || "unknown"; }
  catch { /* A provider failure withdraws readiness instead of extending stale data. */ }
  await db.query("UPDATE cc_phone_stations SET registration_status=$2,registration_checked_at=now() WHERE id=$1", [stationId,status]);
  return { ...s,registration_status:status,registration_checked_at:new Date() };
}

export async function claimStation(pool, user, { stationId, kind, deviceId, purpose = "work" }, dependencies = {}) {
  if (!user.authSessionId) throw fail(409, "Sign in again before choosing a phone");
  if (!(await pool.query("SELECT 1 FROM cc_user_sessions WHERE session_token=$1 AND user_id=$2 AND logout_at IS NULL",[user.authSessionId,String(user.id)])).rowCount) throw fail(401,"This application session has ended. Sign in again.");
  if (kind !== "none" && (await pool.query("SELECT 1 FROM cc_agent_channel_policies WHERE agent_id=$1 AND channel='voice' AND enabled=false",[String(user.id)])).rowCount) throw fail(403,"Voice is disabled for this account");
  if (!deviceId || !/^[a-zA-Z0-9_-]{1,128}$/.test(deviceId)) throw fail(400, "Invalid browser session");
  if (!["work","identify"].includes(purpose)) throw fail(400, "Invalid station purpose");
  let station = null;
  if (kind !== "none") {
    station = (await pool.query("SELECT * FROM cc_phone_stations WHERE id=$1", [stationId])).rows[0];
    if (!station || !stationAccessible(station,user)) throw fail(403, "This station is not available to your account");
    if(station.phone_id && (await pool.query("SELECT 1 FROM hp_phones WHERE id=$1 AND (settings->'desktop_setup'->>'expires')::timestamptz>now()",[station.phone_id])).rowCount)throw fail(409,"Phone setup is in progress. Try again after it finishes.");
    if (native(station.kind)) {
      station = await refreshStationRegistration(pool,stationId,{force:true,...dependencies});
      if (station.registration_status !== "registered") throw fail(409, "The station is not registered. Connect it and try again.");
    }
  }
  const agentId = String(user.id);
  return stationTransaction(pool, async db => [agentId,...(await db.query(
    "SELECT agent_id FROM cc_station_leases WHERE station_id=$1 OR agent_id=$2", [stationId || null,agentId])).rows.map(r=>r.agent_id)], async (db, states) => {
    // Recheck access under the same lock as administrator edits.
    if (station) {
      const fresh = (await db.query("SELECT * FROM cc_phone_stations WHERE id=$1 FOR UPDATE", [stationId])).rows[0];
      if (!fresh || !stationAccessible(fresh,user)) throw fail(403,"This station is not available to your account");
      if(fresh.phone_id && (await db.query("SELECT 1 FROM hp_phones WHERE id=$1 AND (settings->'desktop_setup'->>'expires')::timestamptz>now()",[fresh.phone_id])).rowCount)throw fail(409,"Phone setup is in progress. Try again after it finishes.");
    }
    const targetLease = station ? (await db.query("SELECT * FROM cc_station_leases WHERE station_id=$1 FOR UPDATE", [stationId])).rows[0] : null;
    const ownLease = (await db.query("SELECT * FROM cc_station_leases WHERE agent_id=$1 FOR UPDATE", [agentId])).rows[0];
    const same = targetLease?.agent_id === agentId && targetLease?.auth_session_id === user.authSessionId;
    if (targetLease?.purpose === "identify" && new Date(targetLease.expires_at)>new Date()) throw fail(409,"Wait for the phone identification test to finish");
    if (targetLease && !same) {
      if (new Date(targetLease.expires_at)>new Date() || await hasVoiceWork(db,targetLease.agent_id,states.get(targetLease.agent_id))) throw fail(409,"This station is occupied. Ask an administrator to resolve the conflict.");
      await retireLease(db,targetLease,agentId,"expired");
    }
    if (ownLease && !(same && ownLease.station_id === stationId)) {
      if (ownLease.auth_session_id !== user.authSessionId && new Date(ownLease.expires_at)>new Date()) throw fail(409,"Your phone is in use in another application session");
      if (await hasVoiceWork(db,agentId,states.get(agentId))) throw fail(409,"Finish the voice interaction and wrap-up before changing phones");
      await retireLease(db,ownLease,agentId,"changed");
    }
    // Reopening the same controller must not interrupt its active call.
    if (same && targetLease.endpoint_id) {
      const endpoint = (await db.query("SELECT * FROM cc_voice_endpoints WHERE id=$1", [targetLease.endpoint_id])).rows[0];
      if (endpoint && endpoint.device_id !== `station:${stationId}:${deviceId}` && await hasVoiceWork(db,agentId,states.get(agentId))) throw fail(409,"The active call is controlled in another browser tab");
    } else if (await hasVoiceWork(db,agentId,states.get(agentId))) throw fail(409,"Finish the voice interaction and wrap-up before changing phones");
    if (purpose === "identify" && ownLease) throw fail(409,"Release your current station before testing another phone");
    let registration = null;
    let lease = targetLease && same ? targetLease : null;
    if (station) {
      lease = (await db.query(`INSERT INTO cc_station_leases(station_id,agent_id,auth_session_id,purpose,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '60 seconds') ON CONFLICT(station_id)
        DO UPDATE SET heartbeat_at=now(),expires_at=now()+interval '60 seconds' RETURNING *`, [stationId,agentId,user.authSessionId,purpose])).rows[0];
      if (native(station.kind) && purpose === "work") {
        const secret = randomBytes(32).toString("base64url");
        if (lease.endpoint_id) await db.query("UPDATE cc_voice_endpoints SET revoked_at=now(),ready=false WHERE id=$1", [lease.endpoint_id]);
        const endpoint = (await db.query(`INSERT INTO cc_voice_endpoints
          (id,agent_id,auth_session_id,device_id,kind,label,secret_hash,credential_id,sip_username,station_id,credential_owned,ready,expires_at,socket_ready_until,last_seen_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,true,now()+interval '45 seconds',now()+interval '45 seconds',now())
          ON CONFLICT(agent_id,auth_session_id,device_id) DO UPDATE SET
            kind=EXCLUDED.kind,label=EXCLUDED.label,secret_hash=EXCLUDED.secret_hash,credential_id=EXCLUDED.credential_id,
            sip_username=EXCLUDED.sip_username,station_id=EXCLUDED.station_id,credential_owned=false,
            revoked_at=NULL,ready=true,expires_at=EXCLUDED.expires_at,socket_ready_until=EXCLUDED.socket_ready_until,last_seen_at=now()
          RETURNING *`, [randomUUID(),agentId,user.authSessionId,`station:${stationId}:${deviceId}`,station.kind,station.name,hash(secret),station.sip_connection,station.username,station.id])).rows[0];
        await db.query("UPDATE cc_station_leases SET endpoint_id=$2 WHERE station_id=$1", [stationId,endpoint.id]);
        await db.query("INSERT INTO cc_agent_voice_preferences(agent_id) VALUES($1) ON CONFLICT DO NOTHING", [agentId]);
        const pref = (await db.query("SELECT endpoint_id,generation FROM cc_agent_voice_preferences WHERE agent_id=$1", [agentId])).rows[0];
        if (pref.endpoint_id !== endpoint.id) await applyVoiceSelection(db,agentId,{...endpoint,video_reachable:false},{generation:pref.generation,actor:`agent:${agentId}`,reason:"station_selected"});
        registration = { id:endpoint.id,token:`${endpoint.id}.${secret}`,kind:station.kind,stationId };
      }
    }
    if (purpose === "work") await db.query(`INSERT INTO cc_voice_login_choices(auth_session_id,agent_id,station_id,kind)
      VALUES($1,$2,$3,$4) ON CONFLICT(auth_session_id) DO UPDATE SET station_id=$3,kind=$4,selected_at=now(),pending_selection=true`,
      [user.authSessionId,agentId,station?.id || null,station?.kind || "none"]);
    await db.query("INSERT INTO cc_station_audit(actor_id,action,target_id,detail) VALUES($1,'station_claimed',$2,$3)",
      [agentId,station?.id || null,JSON.stringify({kind:station?.kind || "none",purpose})]);
    return { choice:{kind:station?.kind || "none",station_id:station?.id || null,name:station?.name,vendor:station?.vendor,model:station?.model,native_control:station?.native_control},leaseGeneration:lease?.generation,
      registration,...await readVoiceEndpoints(db,agentId) };
  });
}

export async function releaseStation(pool, actor, { stationId, generation, reason = "released" }, { admin = false } = {}) {
  if (admin && !String(reason).trim()) throw fail(400,"Enter a reason for releasing this station");
  return stationTransaction(pool, async db => (await db.query("SELECT agent_id FROM cc_station_leases WHERE station_id=$1", [stationId])).rows.map(r=>r.agent_id),
    async (db,states) => {
      const lease = (await db.query("SELECT * FROM cc_station_leases WHERE station_id=$1 FOR UPDATE", [stationId])).rows[0];
      if (!lease) return { ok:true };
      if (generation !== lease.generation) throw fail(409,"The station session changed. Refresh before releasing it.");
      if (!admin && (lease.agent_id !== String(actor.id) || lease.auth_session_id !== actor.authSessionId)) throw fail(403,"This station belongs to another session");
      if (lease.test_call_id && new Date(lease.expires_at)>new Date()) throw fail(409,"Wait for the phone identification test to finish");
      if (await hasVoiceWork(db,lease.agent_id,states.get(lease.agent_id))) throw fail(409,"Finish the voice interaction and wrap-up before releasing this phone");
      await retireLease(db,lease,String(actor.id),String(reason).slice(0,250));
      return { ok:true };
    });
}

export async function releaseAuthStations(pool, user) {
  if(!user?.authSessionId)return;
  const leases=(await pool.query("SELECT station_id,generation FROM cc_station_leases WHERE agent_id=$1 AND auth_session_id=$2 AND purpose='work'",[String(user.id),user.authSessionId])).rows;
  for(const lease of leases) {
    try{await releaseStation(pool,user,{stationId:lease.station_id,generation:lease.generation,reason:"signed_out"});}
    catch(error){if(error.status!==409)throw error;} // Active calls/wrap-up retain ownership.
  }
}

export async function saveStation(pool, user, body) {
  const name = String(body.name || "").trim();
  if (!name || name.length>100) throw fail(400,"Enter a station name");
  if (!body.id && body.kind !== "sip") throw fail(400,"WebRTC and provisioned phones are added from their source objects");
  return stationTransaction(pool, async () => [], async db => {
    if (body.id && (await db.query("SELECT 1 FROM cc_station_leases WHERE station_id=$1", [body.id])).rowCount) throw fail(409,"Release this station before editing its assignment");
    if (body.id) {
      const row = (await db.query("SELECT kind,owner_id FROM cc_phone_stations WHERE id=$1", [body.id])).rows[0];
      if (!row) throw fail(404,"Station not found");
      if (row.kind === "webrtc" && (body.shared || body.ownerId !== row.owner_id)) throw fail(400,"A WebRTC station must keep its own user");
    }
    if ((!body.id || body.kind === "sip") && (!/^\d{10,30}$/.test(body.connectionId || "") || !/^[a-zA-Z0-9_.-]{1,128}$/.test(body.sipUsername || ""))) throw fail(400,"Enter a Telnyx credential connection ID and SIP username");
    const id = body.id || randomUUID();
    if (body.kind === "sip" && (await db.query(`SELECT 1 FROM cc_phone_stations WHERE id<>$1
      AND (connection_id=$2 OR lower(sip_username)=lower($3))`,[id,body.connectionId,body.sipUsername])).rowCount) throw fail(409,"This SIP identity already belongs to another station");
    await db.query(`INSERT INTO cc_phone_stations(id,name,kind,owner_id,shared,enabled,connection_id,sip_username)
      VALUES($1,$2,'sip',$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET name=$2,owner_id=$3,shared=$4,enabled=$5,
        connection_id=CASE WHEN cc_phone_stations.kind='sip' THEN $6 ELSE cc_phone_stations.connection_id END,
        sip_username=CASE WHEN cc_phone_stations.kind='sip' THEN $7 ELSE cc_phone_stations.sip_username END`,
      [id,name,body.ownerId || null,body.shared === true,body.enabled !== false,body.connectionId || null,body.sipUsername || null]);
    await db.query("UPDATE hp_phones SET phone_name=$2,agent_id=$3 WHERE id=(SELECT phone_id FROM cc_phone_stations WHERE id=$1)",[id,name,body.ownerId || null]);
    await db.query("INSERT INTO cc_station_audit(actor_id,action,target_id) VALUES($1,'station_saved',$2)", [String(user.id),id]);
    return { id };
  });
}

// Provisioning CRUD and session claims share this lock. A phone may not lose its
// remote credential first and only then discover a conflicting active lease.
export async function withStationMaintenance(pool, phoneId, work) {
  const db=await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock(hashtextextended('cc:station-leases',0))");
    if((await db.query("SELECT 1 FROM cc_station_leases l JOIN cc_phone_stations s ON s.id=l.station_id WHERE s.phone_id=$1",[phoneId])).rowCount)throw fail(409,"Release the station session before changing or deleting this phone");
    return await work();
  } finally {
    await db.query("SELECT pg_advisory_unlock(hashtextextended('cc:station-leases',0))");
    db.release();
  }
}

// Runs inside the ACD heartbeat transaction, after the agent lock. The SIP
// registration check is made outside that transaction and cached for 15 seconds.
export async function heartbeatStation(db, endpoint, { offline = false } = {}) {
  const lease = (await db.query(`SELECT * FROM cc_station_leases WHERE (endpoint_id=$1 OR ($4='web' AND station_id=$5))
    AND agent_id=$2 AND auth_session_id=$3 AND purpose='work' FOR UPDATE`,
    [endpoint.id,endpoint.agent_id,endpoint.auth_session_id,endpoint.kind,endpoint.station_id])).rows[0];
  if (!lease) throw fail(409,"Choose your phone again. This station session has ended.");
  const s = (await db.query(`SELECT s.*,u.experimental_features FROM cc_phone_stations s JOIN users u ON u.id=$2 WHERE s.id=$1`,
    [lease.station_id,endpoint.agent_id])).rows[0];
  const permitted = s && stationAccessible(s,{id:endpoint.agent_id,experimental_features:s.experimental_features});
  if (!(await db.query("SELECT 1 FROM cc_user_sessions WHERE session_token=$1 AND user_id=$2 AND logout_at IS NULL",[endpoint.auth_session_id,endpoint.agent_id])).rowCount) throw fail(401,"This application session has ended");
  await db.query("UPDATE cc_station_leases SET heartbeat_at=now(),expires_at=now()+interval '60 seconds' WHERE station_id=$1", [lease.station_id]);
  return !offline && permitted && (!native(s.kind) || (s.registration_status === "registered"
    && Date.now()-new Date(s.registration_checked_at).getTime()<45000));
}

export async function bindWebStation(pool, user, endpointId) {
  return stationTransaction(pool,async () => [String(user.id)],async db => {
    const choice = await readLoginChoice(db,user);
    if (!choice) return; // Existing API/mobile clients keep their enrollment path.
    if (choice.kind !== "webrtc") throw fail(409,"Select the browser phone before registering WebRTC");
    const lease = (await db.query("SELECT * FROM cc_station_leases WHERE station_id=$1 FOR UPDATE", [choice.station_id])).rows[0];
    if (!lease || lease.auth_session_id !== user.authSessionId) throw fail(409,"Choose your phone again");
    // Multiple browser tabs share the user's WebRTC station; only the selected
    // endpoint receives calls. Hardware stations have exactly one controller.
    await db.query("UPDATE cc_voice_endpoints SET station_id=$2 WHERE id=$1 AND kind='web'", [endpointId,choice.station_id]);
    await db.query("UPDATE cc_station_leases SET endpoint_id=$2,heartbeat_at=now(),expires_at=now()+interval '60 seconds' WHERE station_id=$1", [choice.station_id,endpointId]);
    return choice.pending_selection;
  });
}
