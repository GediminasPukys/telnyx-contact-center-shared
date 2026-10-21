import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool } from "./helpers/acd-test-db.mjs";
import { ensureStationSchema } from "../lib/telephony/stations-schema.mjs";
import { saveExtensionPool, assignExtension, extensionChoices, extensionDirectory, deleteExtensionPool, ensureWebStation, validatePool } from "../lib/telephony/extensions.mjs";
import { claimStation, releaseStation, stationInventory, refreshStationRegistration, readLoginChoice, saveStation, bindWebStation, releaseAuthStations, withStationMaintenance } from "../lib/telephony/stations.mjs";
import { authenticateVoiceEndpoint, registerVoiceEndpoint, sweepStaleVoiceEndpoints } from "../lib/acd/voice-endpoints.mjs";
import { heartbeatAgentSession } from "../lib/acd/sessions.mjs";
let db, phone, station, web, userPool, phonePool, queuePool;
const alice={id:"station-alice",username:"alice",authSessionId:"alice-login",experimental_features:true};
const bob={id:"station-bob",username:"bob",authSessionId:"bob-login",experimental_features:true};
const check=async()=>({registration_status:"registered"});
before(async()=>{
  db=await prepareAcdTestPool("cc_station_directory_test");
  await db.query(`DROP TABLE IF EXISTS cc_station_leases,cc_voice_login_choices,cc_extension_assignments,cc_extension_pool_types,cc_extension_pools,cc_station_audit,cc_phone_stations,hp_phones CASCADE;
    DROP TABLE IF EXISTS cc_user_sessions CASCADE;
    CREATE TABLE cc_user_sessions(id TEXT PRIMARY KEY,user_id TEXT,session_token TEXT,logout_at TIMESTAMPTZ);
    INSERT INTO cc_user_sessions(id,user_id,session_token) VALUES('alice-row','station-alice','alice-login'),('bob-row','station-bob','bob-login');
    ALTER TABLE users ADD COLUMN extension TEXT, ADD COLUMN experimental_features BOOLEAN DEFAULT true;
    CREATE TABLE hp_phones(id UUID PRIMARY KEY,mac TEXT,phone_name TEXT,label TEXT,model TEXT,vendor TEXT,agent_id TEXT,
      sip_username TEXT,telnyx_connection_id TEXT,telnyx_credential_id TEXT,provisioning_state TEXT,settings JSONB DEFAULT '{}');
    INSERT INTO users(id,username) VALUES('station-alice','alice'),('station-bob','bob');
    INSERT INTO cc_queues(id,name) VALUES('station-queue','Sales');`);
  await ensureStationSchema(db);
  await ensureStationSchema(db);
  phone=randomUUID();
  await db.query(`INSERT INTO hp_phones(id,mac,model,vendor,sip_username,telnyx_connection_id) VALUES($1,'0004f2abcdef','VVX 300','polycom','controlled-phone','123456789012345')`,[phone]);
  const inventory=await stationInventory(db,alice);
  station=inventory.find(s=>s.kind==="deskphone");
  web=await ensureWebStation(db,alice);
});
after(async()=>{await db?.end();});
test("exactly three separate pool categories; phone subtypes cannot become pools",()=>{
  assert.throws(()=>validatePool({name:"wrong",digits:4,start:1001,end:1099,types:["deskphone"]}),{status:400});
  assert.throws(()=>validatePool({name:"mixed",digits:4,start:1001,end:1099,types:["phone","user"]}),{status:400});
});
test("create the user's three independent example ranges",async()=>{
  phonePool=await saveExtensionPool(db,"admin",{name:"Phones",digits:4,start:1001,end:1099,types:["phone"]});
  userPool=await saveExtensionPool(db,"admin",{name:"Users",digits:4,start:2001,end:2999,types:["user"]});
  queuePool=await saveExtensionPool(db,"admin",{name:"Queues",digits:4,start:3001,end:3999,types:["queue"]});
  assert.notEqual(userPool.id,phonePool.id);
});
test("directory totals include the full inventory even when no search results match",async()=>{
  const inventory=await extensionDirectory(db);
  const filtered=await extensionDirectory(db,{type:"queue",search:"no-such-object"});
  assert.equal(filtered.objects.length,0);
  assert.deepEqual(filtered.counts,inventory.counts);
  assert.equal(inventory.counts.user,2);
  assert.equal(inventory.counts.queue,1);
  assert.equal(inventory.counts.phone,2);
  assert.equal(inventory.objects.find(o=>o.id===web.id).kind,"webrtc");
  assert.equal(inventory.objects.find(o=>o.id===station.id).detail,"VVX 300");
});
test("an object only sees numbers from its own category",async()=>{
  const a=await extensionChoices(db,"user",alice.id), b=await extensionChoices(db,"queue","station-queue");
  assert.equal(a.pool.id,userPool.id);assert.equal(a.numbers[0],"2001");
  assert.equal(b.pool.id,queuePool.id);assert.equal(b.numbers[0],"3001");
  assert.equal((await extensionChoices(db,"phone",phone)).pool.id,phonePool.id);
  assert.equal((await extensionChoices(db,"phone",web.id)).pool.id,phonePool.id);
});
test("server rejects assigning a phone's number to a user",async()=>{
  await assert.rejects(assignExtension(db,"admin",{type:"user",targetId:alice.id,number:"1001"}),{status:400});
});
test("overlap and a second pool for one category are rejected",async()=>{
  await assert.rejects(saveExtensionPool(db,"admin",{name:"Overlap",digits:4,start:1050,end:1200,types:["user"]}),{status:409});
  await assert.rejects(saveExtensionPool(db,"admin",{name:"Duplicate type",digits:5,start:12000,end:13000,types:["phone"]}),{status:409});
});
test("simultaneous assignment of the same number has one winner",async()=>{
  const results=await Promise.allSettled([alice,bob].map(u=>assignExtension(db,"admin",{type:"user",targetId:u.id,number:"2001"})));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(results.find(r=>r.status==="rejected").reason.status,409);
});
test("assigned ranges cannot be deleted or shrunk around existing numbers",async()=>{
  await assignExtension(db,"admin",{type:"phone",targetId:phone,number:"1001",expectedNumber:null});
  await assert.rejects(deleteExtensionPool(db,"admin",phonePool.id),{status:409});
  await assert.rejects(saveExtensionPool(db,"admin",{id:phonePool.id,name:"Phones",digits:4,start:1010,end:1099,types:["phone"]}),{status:409});
});
test("optimistic assignment prevents overwriting another administrator",async()=>{
  await assert.rejects(assignExtension(db,"admin",{type:"phone",targetId:phone,number:"1002",expectedNumber:null}),{status:409});
});
let winner, claim;
test("two agents claiming one physical phone have exactly one winner",async()=>{
  const results=await Promise.allSettled([alice,bob].map(u=>claimStation(db,u,{stationId:station.id,deviceId:u.id},{check})));
  const idx=results.findIndex(r=>r.status==="fulfilled");winner=[alice,bob][idx];claim=results[idx].value;
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(results.find(r=>r.status==="rejected").reason.status,409);
  assert.equal(claim.registration.kind,"deskphone");
  const selected=(await db.query("SELECT telephony_user_name FROM users WHERE id=$1",[winner.id])).rows[0];
  assert.equal(selected.telephony_user_name,"controlled-phone");
});
test("occupancy names the user and prevents cross-session access",async()=>{
  const other=winner.id===alice.id?bob:alice;
  const s=(await stationInventory(db,other)).find(s=>s.id===station.id);
  assert.equal(s.busy,true);assert.equal(s.occupant_name,winner.username);assert.equal(s.auth_session_id,undefined);
  await assert.rejects(authenticateVoiceEndpoint(db,other,claim.registration.token),{status:403});
});
test("physical readiness comes from server registration, never browser voiceReady",async()=>{
  const endpoint=await authenticateVoiceEndpoint(db,winner,claim.registration.token);
  const ready=await heartbeatAgentSession(db,{agentId:winner.id,sessionId:endpoint.id,voiceEndpoint:endpoint,voiceReady:false,ready:{video:true}});
  assert.equal(ready.voiceReady,true);assert.equal(ready.ready.video,false);
  await refreshStationRegistration(db,station.id,{force:true,check:async()=>({registration_status:"not_registered"})});
  assert.equal((await heartbeatAgentSession(db,{agentId:winner.id,sessionId:endpoint.id,voiceEndpoint:endpoint,voiceReady:true})).voiceReady,false);
  await refreshStationRegistration(db,station.id,{force:true,check});
});
test("an expired heartbeat never releases active voice work or wrap-up",async()=>{
  await db.query("UPDATE cc_station_leases SET expires_at=now()-interval '1 minute' WHERE station_id=$1",[station.id]);
  await db.query("UPDATE acd_agent_state SET workflow_state='wrapup' WHERE agent_id=$1",[winner.id]);
  await assert.rejects(releaseStation(db,{id:"admin"},{stationId:station.id,generation:claim.leaseGeneration,reason:"Wrong station"},{admin:true}),{status:409});
  const other=winner.id===alice.id?bob:alice;
  await assert.rejects(claimStation(db,other,{stationId:station.id,deviceId:other.id},{check}),{status:409});
  await db.query("UPDATE acd_agent_state SET workflow_state='idle' WHERE agent_id=$1",[winner.id]);
});
test("release checks generation, revokes controller, and retains physical SIP identity",async()=>{
  await assert.rejects(releaseStation(db,{id:"admin"},{stationId:station.id,generation:randomUUID(),reason:"Wrong station"},{admin:true}),{status:409});
  await releaseStation(db,{id:"admin"},{stationId:station.id,generation:claim.leaseGeneration,reason:"Wrong station"},{admin:true});
  await assert.rejects(authenticateVoiceEndpoint(db,winner,claim.registration.token),{status:403});
  assert.equal(await readLoginChoice(db,winner),null);
  assert.equal((await db.query("SELECT telnyx_connection_id FROM hp_phones WHERE id=$1",[phone])).rows[0].telnyx_connection_id,"123456789012345");
});
test("an unregistered or unauthorized phone cannot be claimed",async()=>{
  await assert.rejects(claimStation(db,{...alice,experimental_features:false},{stationId:station.id,deviceId:"browser"},{check}),{status:403});
  await assert.rejects(claimStation(db,alice,{stationId:station.id,deviceId:"browser"},{check:async()=>({registration_status:"not_registered"})}),{status:409});
});
test("the user may keep separate user and WebRTC phone extensions",async()=>{
  await assignExtension(db,"admin",{type:"phone",targetId:web.id,number:"1002"});
  const result=await claimStation(db,alice,{stationId:web.id,deviceId:"browser"});
  assert.equal(result.choice.kind,"webrtc");
  assert.equal((await extensionChoices(db,"phone",web.id)).current,"1002");
});
test("two catalog entries cannot expose the same physical SIP identity",async()=>{
  await assert.rejects(saveStation(db,alice,{name:"Duplicate SIP",kind:"sip",shared:true,connectionId:"123456789012345",sipUsername:"controlled-phone"}),{status:409});
});
test("browser tabs share one WebRTC station and releasing it revokes both",async()=>{
  const registrations=[];
  for(const deviceId of ["tab-one","tab-two"]) {
    const value=await registerVoiceEndpoint(db,alice,{kind:"web",deviceId},async id=>({id:`credential-${id}`,username:`sip-${id}`}));
    await bindWebStation(db,alice,value.registration.id);registrations.push(value.registration);
  }
  for(const registration of registrations) {
    const endpoint=await authenticateVoiceEndpoint(db,alice,registration.token);
    await heartbeatAgentSession(db,{agentId:alice.id,sessionId:endpoint.id,voiceEndpoint:endpoint,voiceReady:true});
  }
  const lease=(await db.query("SELECT generation FROM cc_station_leases WHERE station_id=$1",[web.id])).rows[0];
  await releaseStation(db,alice,{stationId:web.id,generation:lease.generation});
  for(const registration of registrations)await assert.rejects(authenticateVoiceEndpoint(db,alice,registration.token),{status:403});
});
test("an idle expired station is reclaimed and its former controller is revoked",async()=>{
  const a=await claimStation(db,alice,{stationId:station.id,deviceId:"old-tab"},{check});
  await db.query("UPDATE cc_station_leases SET expires_at=now()-interval '1 second' WHERE station_id=$1",[station.id]);
  const b=await claimStation(db,bob,{stationId:station.id,deviceId:"new-tab"},{check});
  await assert.rejects(authenticateVoiceEndpoint(db,alice,a.registration.token),{status:403});
  assert.equal((await db.query("SELECT telephony_user_name FROM users WHERE id=$1",[alice.id])).rows[0].telephony_user_name,null);
  await releaseStation(db,bob,{stationId:station.id,generation:b.leaseGeneration});
});
test("native credential cleanup cannot delete the phone or clear a newer login's routing",async()=>{
  const a=await claimStation(db,alice,{stationId:station.id,deviceId:"old-native"},{check});
  await releaseStation(db,alice,{stationId:station.id,generation:a.leaseGeneration});
  await db.query("UPDATE cc_voice_endpoints SET revoked_at=now()-interval '2 hours' WHERE id=$1",[a.registration.id]);
  const b=await claimStation(db,alice,{stationId:station.id,deviceId:"new-native"},{check});
  const released=[];await sweepStaleVoiceEndpoints(db,{release:async id=>released.push(id)});
  assert.ok(!released.includes("123456789012345"));
  assert.equal((await db.query("SELECT telephony_user_name FROM users WHERE id=$1",[alice.id])).rows[0].telephony_user_name,"controlled-phone");
  await releaseStation(db,alice,{stationId:station.id,generation:b.leaseGeneration});
});
test("closed login sessions cannot claim a phone",async()=>{
  await db.query("UPDATE cc_user_sessions SET logout_at=now() WHERE session_token=$1",[alice.authSessionId]);
  await assert.rejects(claimStation(db,alice,{stationId:station.id,deviceId:"closed-tab"},{check}),{status:401});
});
test("disabled voice policy prevents station claims",async()=>{
  await db.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'voice',false,1,1) ON CONFLICT(agent_id,channel) DO UPDATE SET enabled=false",[bob.id]);
  await assert.rejects(claimStation(db,bob,{stationId:station.id,deviceId:"disabled-voice"},{check}),{status:403});
  await db.query("DELETE FROM cc_agent_channel_policies WHERE agent_id=$1 AND channel='voice'",[bob.id]);
});
test("occupied phones cannot enter credential-changing maintenance; idle logout releases them",async()=>{
  const claimed=await claimStation(db,bob,{stationId:station.id,deviceId:"logout-tab"},{check});
  let effect=false;
  await assert.rejects(withStationMaintenance(db,phone,async()=>{effect=true;}),{status:409});
  assert.equal(effect,false);
  await db.query("UPDATE cc_user_sessions SET logout_at=now() WHERE session_token=$1",[bob.authSessionId]);
  await releaseAuthStations(db,bob);
  assert.equal((await db.query("SELECT 1 FROM cc_station_leases WHERE station_id=$1",[station.id])).rowCount,0);
  await assert.rejects(authenticateVoiceEndpoint(db,bob,claimed.registration.token),{status:403});
  await withStationMaintenance(db,phone,async()=>{effect=true;});
  assert.equal(effect,true);
});
