import { randomUUID } from "node:crypto";
import { buildTelnyxV2Url } from "../telnyx.js";
import { executeCtiAction } from "../hardphones/cti.mjs";
import { getProvisioningEnrollment } from "../hardphones/provisioning-access.mjs";
import { claimStation, releaseStation } from "./stations.mjs";
import { telephonyError as fail } from "./extensions.mjs";

export async function stationPhone(db, stationId) {
  const phone = (await db.query("SELECT p.* FROM cc_phone_stations s JOIN hp_phones p ON p.id=s.phone_id WHERE s.id=$1", [stationId])).rows[0];
  if (phone?.vendor === "polycom") phone.certificate_fingerprint=(await getProvisioningEnrollment(db,phone.id))?.certificate_fingerprint;
  return phone;
}
async function provider(path, body) {
  const response = await fetch(buildTelnyxV2Url(path), {
    method:"POST",headers:{Authorization:`Bearer ${process.env.TELNYX_API_KEY}`,"Content-Type":"application/json"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(15000),
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok && path.endsWith("/actions/hangup") && payload.errors?.some(e=>String(e.code)==="90018"))return {ended:true};
  if(!response.ok)throw Object.assign(fail(502,`Phone test provider returned HTTP ${response.status}`),{definitive:response.status>=400&&response.status<500&&![408,429].includes(response.status)});
  return payload.data;
}

export async function identifyStation(pool,user,body) {
  const base=String(process.env.TELNYX_WEBHOOK_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/$/,"");
  const from=String(process.env.HP_CTI_FROM_NUMBER || process.env.TELNYX_DEFAULT_FROM_NUMBER || "");
  if(!process.env.TELNYX_API_KEY || !process.env.TELNYX_CALL_CONTROL_ID || !/^\+[1-9]\d{1,14}$/.test(from) || !base.startsWith("https://")) throw fail(503,"Configure the phone test caller ID and public webhook URL");
  const recent=await pool.query("SELECT 1 FROM cc_station_audit WHERE actor_id=$1 AND action='station_identified' AND created_at>now()-interval '30 seconds'", [String(user.id)]);
  if(recent.rowCount)throw fail(429,"Wait 30 seconds before testing another phone");
  // Claim and check registration first, so nobody can occupy it while it rings.
  const claim=await claimStation(pool,user,{...body,purpose:"identify"});
  let callId=null,sessionId=null,dialStarted=false,rejected=false;
  try {
    const station=(await pool.query(`SELECT COALESCE(p.sip_username,s.sip_username) AS username,s.kind
      FROM cc_phone_stations s LEFT JOIN hp_phones p ON p.id=s.phone_id WHERE s.id=$1`,[body.stationId])).rows[0];
    if(station.kind==="webrtc")throw fail(400,"The browser phone does not need a physical identification ring");
    const phone=await stationPhone(pool,body.stationId);
    if(phone?.vendor==="polycom" && phone.settings?.cti_mode==="direct") {
      const status=await executeCtiAction(phone,"status",{}, {pool,baseUrl:base});
      if(!status.ok)throw fail(409,"Could not verify that the phone is idle");
      const calls=Array.isArray(status.call)?status.call:status.call?[status.call]:[];
      if(calls.length)throw fail(409,"The physical phone is already on a call");
    }
    sessionId=randomUUID();
    if(phone)await pool.query("INSERT INTO hp_cti_sessions(id,phone_id,target,status) VALUES($1,$2,'station-identification','originating')",[sessionId,phone.id]);
    await pool.query("INSERT INTO cc_station_audit(actor_id,action,target_id) VALUES($1,'station_identified',$2)",[String(user.id),body.stationId]);
    dialStarted=true;
    const result=await provider("/calls",{
      to:`sip:${station.username}@sip.telnyx.com`,from,connection_id:process.env.TELNYX_CALL_CONTROL_ID,
      command_id:sessionId,timeout_secs:8,time_limit_secs:30,retry_on_timeout:false,
      webhook_url:`${base}/api/provisioning/cti-webhook`,webhook_url_method:"POST",
      client_state:Buffer.from(JSON.stringify({hardphoneCti:true,phoneId:phone?.id,sessionId,leg:"phone",stationIdentify:true})).toString("base64"),
    });
    callId=result?.call_control_id;
    if(!callId)throw fail(502,"The provider did not return a phone test call");
    await pool.query("UPDATE cc_station_leases SET test_call_id=$2 WHERE station_id=$1 AND generation=$3", [body.stationId,callId,claim.leaseGeneration]);
    if(phone)await pool.query("UPDATE hp_cti_sessions SET call_control_id=$2,phone_call_control_id=$2,call_session_id=$3 WHERE id=$1",[sessionId,callId,result.call_session_id]);
    // A provider-enforced timeout also bounds the call if this process stops.
    await new Promise(resolve=>setTimeout(resolve,5000));
    return {ok:true,callLegId:result.call_leg_id};
  } catch(error) {
    rejected=error.definitive===true&&!callId;
    if(rejected&&sessionId)await pool.query("UPDATE hp_cti_sessions SET status='failed',updated_at=now() WHERE id=$1",[sessionId]);
    throw error;
  } finally {
    let ended=!dialStarted || rejected;
    if(callId)ended=await provider(`/calls/${encodeURIComponent(callId)}/actions/hangup`,{command_id:randomUUID()}).then(()=>true).catch(()=>false);
    if(ended) {
      await pool.query("UPDATE cc_station_leases SET test_call_id=NULL WHERE station_id=$1 AND generation=$2", [body.stationId,claim.leaseGeneration]);
      await releaseStation(pool,user,{stationId:body.stationId,generation:claim.leaseGeneration,reason:"identification_finished"});
    } else {
      // An unknown Dial/hangup outcome retains exclusivity beyond the provider's
      // 8-second ringing + 30-second answered-call limits.
      await pool.query("UPDATE cc_station_leases SET expires_at=now()+interval '45 seconds' WHERE station_id=$1 AND generation=$2", [body.stationId,claim.leaseGeneration]);
      throw fail(409,"The phone test is still ending. Wait before selecting it.");
    }
  }
}

export async function controlStation(pool,user,endpoint,action,params={}) {
  if(user.experimental_features!==true || !endpoint.station_id || endpoint.kind!=="deskphone")throw fail(403,"Native phone control is unavailable for this station");
  if(!["status","answer","hangup","hold","resume","mute","unmute","send_dtmf"].includes(action))throw fail(400,"Unsupported station action");
  const phone=await stationPhone(pool,endpoint.station_id);
  if(!phone || phone.provisioning_state==="disabled")throw fail(409,"This phone is disabled");
  // Do not advertise fallback answer as a real remote handset answer.
  if(!(["polycom","yealink"].includes(phone.vendor) || (phone.vendor==="audiocodes" && ["sip_controller","desktop_bridge"].includes(phone.settings?.cti_mode))) || phone.settings?.cti_mode==="telnyx")throw fail(409,"Use the controls on this SIP phone");
  if(action==="send_dtmf" && !/^[0-9*#A-D]{1,32}$/.test(params.digits||""))throw fail(400,"Invalid DTMF digits");
  const context={pool,baseUrl:process.env.TELNYX_WEBHOOK_BASE_URL || ""};
  if(action!=="status") {
    // The Poly driver re-reads callStatus and matches this exact reference
    // before each mutation. Avoid a second registration+call poll here:
    // UCS rejects concurrent management reads while processing call control.
    if(!(["polycom","audiocodes"].includes(phone.vendor)||(phone.vendor==="yealink"&&phone.settings?.cti_mode==="desktop_bridge")) || !/^[a-zA-Z0-9:_-]{1,128}$/.test(String(params.callRef||"")))
      throw fail(409,"This phone action is unavailable for the current call.");
  }
  const result=await executeCtiAction(phone,action,{digits:params.digits,callRef:params.callRef},context);
  if(!result.ok)throw fail(502,result.reason||"Phone control failed");
  // Never return provisioning credentials or the full driver response.
  const line=(Array.isArray(result.line)?result.line:[result.line]).find(Boolean);
  const interaction = action === "status" ? (await pool.query(`SELECT w.id,w.direction,w.state,w.queue_id,
      w.customer_address AS from_number,w.cc_address AS to_number,w.attributes,
      l.provider_call_id AS agent_call_control_id,c.provider_call_id AS call_control_id
    FROM acd_reservations r JOIN acd_work_items w ON w.id=r.work_item_id
    LEFT JOIN LATERAL (SELECT provider_call_id FROM acd_legs WHERE work_item_id=w.id AND agent_id=$1
      AND role='agent_device' AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1) l ON true
    LEFT JOIN LATERAL (SELECT provider_call_id FROM acd_legs WHERE work_item_id=w.id AND role='customer'
      AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1) c ON true
    WHERE r.agent_id=$1 AND r.channel='voice' AND r.state<>'released' AND w.state IN ('offered','active')
    ORDER BY r.created_at DESC LIMIT 1`,[String(user.id)])).rows[0] || null : null;
  return {ok:true,call:result.call||null,callStateKnown:result.callStateKnown!==false,registration:result.registration||line?.RegistrationStatus||null,reachable:result.reachable??true,
    interaction:interaction ? {...interaction,metadata:{agent_call_control_id:interaction.agent_call_control_id,original_call_control_id:interaction.call_control_id}} : null};
}
