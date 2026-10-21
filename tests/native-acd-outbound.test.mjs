import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepareAcdTestPool,seedAgent,seedQueue,makeFakeProvider} from './helpers/acd-test-db.mjs';
import {reserveDirectVoice,applyDirectCapacityEventWithRejection,cancelUnstartedDirectIntent,sweepAbandonedDirectIntents} from '../lib/acd/direct-capacity.mjs';
import {driveSaga,applySagaEvent,clearSagaDeadlineWakeups} from '../lib/acd/saga-engine.mjs';
import {routeAcdVoiceEvent} from '../lib/acd/live-intake.mjs';
import {ensureDialingSchema,outboundIdentities,resolveOutboundIdentity,isExtension,resolveDialTarget,ownedVoiceNumber} from '../lib/telephony/dialing.mjs';
const pool=await prepareAcdTestPool('acd_core_test_native_dialing');
after(async()=>{clearSagaDeadlineWakeups();await pool.end();});
await ensureDialingSchema(pool);
await pool.query("ALTER TABLE cc_queues ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true");
process.env.TELNYX_CALL_CONTROL_ID='native-test-application';
async function fixture({queue=false,internalQueue=false,native=false}={}){
 const agentId=randomUUID();await seedAgent(pool,agentId);await pool.query("UPDATE users SET voice_number='+15550001001' WHERE id=$1",[agentId]);
 const queueId=`native-queue-${randomUUID()}`;await seedQueue(pool,queueId,[agentId]);
 const context={identity:{id:queue?`queue:${queueId}`:'personal',kind:queue?'queue':'personal',number:queue?'+15550001002':'+15550001001',label:queue?'Sales':'My number',...(queue?{queueId}:{})},target:{type:internalQueue?'queue':'external',internal:internalQueue,destination:internalQueue?`sip:queue-${queueId}@sip.telnyx.com`:'+15550002000',...(internalQueue?{queueId}:{})},stationTarget:`sip:phone-${agentId}@sip.telnyx.com`,stationId:randomUUID()};
 if(native)context.nativeOrigination={endpointId:randomUUID(),number:'+15550002000'};
 const requestId=randomUUID();const intent=await reserveDirectVoice(pool,{agentId,requestId,target:context.target.destination,dialContext:context});
 const saga=(await pool.query("SELECT * FROM acd_sagas WHERE work_item_id=$1 AND type='manual_outbound'",[intent.work_item_id])).rows[0];
 const agentCallId=`v3:native-${randomUUID()}`;
 const provider=makeFakeProvider([{outcome:'accepted',httpStatus:200,response:{data:{call_control_id:agentCallId}}}]);
 const event=eventType=>({eventId:randomUUID(),eventType,payload:{call_control_id:agentCallId,direction:'outgoing',to:context.stationTarget,from:'+15550009999',custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]}});
 return{agentId,queueId,context,intent,saga,provider,event,agentCallId,requestId};
}
test('native station rings first; HTTP acceptance and initiated events cannot dial the customer',async()=>{
 const f=await fixture();await driveSaga(pool,f.saga.id,{provider:f.provider});
 assert.deepEqual(f.provider.calls.map(c=>c.operation),['manual_outbound_station_dial']);
 assert.equal(f.provider.calls[0].request.to,f.context.stationTarget);
 await applyDirectCapacityEventWithRejection(pool,f.event('call.initiated'),{provider:f.provider});
 assert.equal(f.provider.calls.length,1);
 await applyDirectCapacityEventWithRejection(pool,f.event('call.answered'),{provider:f.provider});
 assert.equal(f.provider.calls[1].operation,'manual_outbound_dial');
 assert.equal(f.provider.calls[1].request.from,'+15550001001','CLI must come from prepared context, not the webhook');
 assert.equal(f.provider.calls[1].request.link_to,undefined,'Native customer must be independent of the handset leg');
 await applyDirectCapacityEventWithRejection(pool,f.event('call.answered'),{provider:f.provider});
 assert.equal(f.provider.calls.filter(c=>c.operation==='manual_outbound_dial').length,1);
});
test('queue outbound persists queue attribution on work and agent segment; identity cannot change on retry',async()=>{
 const f=await fixture({queue:true});
 const work=(await pool.query('SELECT * FROM acd_work_items WHERE id=$1',[f.intent.work_item_id])).rows[0];
 assert.equal(work.queue_id,f.queueId);assert.equal(work.direction,'outbound');assert.equal(work.cc_address,'+15550001002');
 assert.equal((await reserveDirectVoice(pool,{agentId:f.agentId,requestId:f.requestId,target:f.context.target.destination,dialContext:f.context})).id,f.intent.id);
 await assert.rejects(reserveDirectVoice(pool,{agentId:f.agentId,requestId:f.requestId,target:f.context.target.destination,dialContext:{...f.context,identity:{...f.context.identity,id:'personal'}}}),{status:409});
 await driveSaga(pool,f.saga.id,{provider:f.provider});
 await applyDirectCapacityEventWithRejection(pool,f.event('call.initiated'),{provider:f.provider});
 assert.equal((await pool.query("SELECT queue_id FROM acd_segments WHERE work_item_id=$1 AND kind='agent'",[f.intent.work_item_id])).rows[0].queue_id,f.queueId);
 await applyDirectCapacityEventWithRejection(pool,f.event('call.answered'),{provider:f.provider});
 assert.equal(f.provider.calls.find(c=>c.operation==='manual_outbound_dial').request.from,'+15550001002');
});
test('internal queue call enqueues the caller without a PSTN/SIP customer Dial and retains caller capacity',async()=>{
 const f=await fixture({internalQueue:true});await driveSaga(pool,f.saga.id,{provider:f.provider});
 await applyDirectCapacityEventWithRejection(pool,f.event('call.initiated'),{provider:f.provider});
 await applyDirectCapacityEventWithRejection(pool,f.event('call.answered'),{provider:f.provider});
 assert.equal(f.provider.calls.some(c=>c.operation==='manual_outbound_dial'),false);
 assert.equal(f.provider.calls.at(-1).operation,'internal_queue_enqueue');
 await applySagaEvent(pool,{workItemId:f.intent.work_item_id,name:'leg.enqueued',role:'customer',payload:{provider_call_id:f.agentCallId,owner_saga_id:f.saga.id},provider:f.provider});
 const work=(await pool.query('SELECT * FROM acd_work_items WHERE id=$1',[f.intent.work_item_id])).rows[0];assert.equal(work.state,'queued');assert.equal(work.queue_id,f.queueId);assert.equal(work.direction,'internal');
 assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[f.intent.reservation_id])).rows[0].state,'active');
 await applyDirectCapacityEventWithRejection(pool,f.event('call.hangup'),{provider:f.provider});
 assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[f.intent.reservation_id])).rows[0].state,'released');
});
test('outbound identities reject arbitrary queue IDs and on-net ignores queue attribution',async()=>{
 const id=randomUUID();await seedAgent(pool,id);await pool.query("UPDATE users SET voice_number='+15550001001' WHERE id=$1",[id]);
 const identities=await outboundIdentities(pool,id);assert.equal(identities.length,1);
 await assert.rejects(resolveOutboundIdentity(pool,id,'queue:someone-elses-queue'),{status:403});
 assert.equal((await resolveOutboundIdentity(pool,id,'queue:someone-elses-queue',{internal:true})).id,'personal');
});
test('unknown short numbers never fall through to PSTN; DID administration accepts IDs, not numbers',async()=>{
 assert.ok(isExtension('2001'));assert.ok(isExtension('100'));assert.ok(isExtension('99999'));assert.equal(isExtension('12'),false);
 await assert.rejects(resolveDialTarget(pool,'12'),{status:400});
 await assert.rejects(resolveDialTarget(pool,'20001x'),{status:400});
 await assert.rejects(ownedVoiceNumber('+15550001001'),{status:400});
});
test('native origination cannot be cancelled as an unstarted browser intent while its Dial may be in flight',async()=>{
 const f=await fixture();
 assert.equal(await cancelUnstartedDirectIntent(pool,{id:f.intent.id,agentId:f.agentId}),false);
 assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[f.intent.reservation_id])).rows[0].state,'active');
});
test('a reflected SIP customer header cannot replace the provider-controlled leg or its park policy',async()=>{
 const f=await fixture();await driveSaga(pool,f.saga.id,{provider:f.provider});
 await applyDirectCapacityEventWithRejection(pool,f.event('call.answered'),{provider:f.provider});
 const headers=[{name:'X-CC-Work-Item-Id',value:f.intent.work_item_id},{name:'X-CC-Leg-Role',value:'customer'},{name:'X-CC-Saga-Id',value:f.saga.id}];
 await routeAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.initiated',payload:{call_control_id:'v3:owned-'+f.saga.id,direction:'outgoing',custom_headers:headers}},{node:'test'});
 await routeAcdVoiceEvent(pool,f.provider,{eventId:randomUUID(),eventType:'call.initiated',payload:{call_control_id:'v3:peer-'+f.saga.id,direction:'incoming',custom_headers:headers}},{node:'test'});
 const legs=(await pool.query("SELECT provider_call_id FROM acd_legs WHERE work_item_id=$1 AND role='customer'",[f.intent.work_item_id])).rows;
 assert.deepEqual(legs.map(l=>l.provider_call_id),['v3:owned-'+f.saga.id]);
 assert.equal((await pool.query('SELECT attributes FROM acd_work_items WHERE id=$1',[f.intent.work_item_id])).rows[0].attributes.customer_call_control_id,'v3:owned-'+f.saga.id);
});
test('on-net recipient capacity is reserved atomically and released when an unanswered native call ends',async()=>{
 const recipient=randomUUID(),caller=randomUUID(),otherCaller=randomUUID();
 for(const id of [recipient,caller,otherCaller])await seedAgent(pool,id);
 const context={identity:{id:'personal',kind:'personal',number:'+15550001001'},target:{internal:true,type:'user',userId:recipient,destination:'sip:recipient@sip.telnyx.com'},stationTarget:'sip:source@sip.telnyx.com',stationId:randomUUID()};
 const intent=await reserveDirectVoice(pool,{agentId:caller,requestId:randomUUID(),target:context.target.destination,dialContext:context});
 await assert.rejects(reserveDirectVoice(pool,{agentId:otherCaller,requestId:randomUUID(),target:context.target.destination,dialContext:context}),{status:409});
 assert.equal((await pool.query("SELECT 1 FROM acd_reservations WHERE agent_id=$1 AND state<>'released'",[otherCaller])).rowCount,0);
 const saga=(await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1",[intent.work_item_id])).rows[0];
 const callId=`v3:unanswered-${randomUUID()}`,provider=makeFakeProvider([{outcome:'accepted',httpStatus:200,response:{data:{call_control_id:callId}}}]);
 await driveSaga(pool,saga.id,{provider});
 await applyDirectCapacityEventWithRejection(pool,{eventId:randomUUID(),eventType:'call.hangup',payload:{call_control_id:callId,direction:'outgoing',to:context.stationTarget,hangup_cause:'no_answer',custom_headers:[{name:'X-CC-Direct-Intent-Id',value:intent.id}]}},{provider});
 assert.equal((await pool.query("SELECT 1 FROM acd_reservations WHERE work_item_id=$1 AND state<>'released'",[intent.work_item_id])).rowCount,0);
});
test('physical-keypad CLI follows the signed-in user, then phone DID, then the Main From Number',async()=>{
 const {handsetCallingIdentity}=await import('../lib/acd/handset-outbound.mjs');
 const agent=randomUUID();await seedAgent(pool,agent);await pool.query("UPDATE users SET voice_number='+15550001111' WHERE id=$1",[agent]);
 const phone={id:randomUUID(),assigned_phone_number_id:'owned-number',assigned_phone_number:'+15550002222'};
 assert.equal((await handsetCallingIdentity(pool,phone,{agent_id:agent,outbound_identity:'personal'},{internal:false})).number,'+15550001111');
 await assert.rejects(handsetCallingIdentity(pool,phone,{agent_id:agent,outbound_identity:'queue:unassigned'},{internal:false}),{status:403});
 const originalFetch=global.fetch,originalFrom=process.env.TELNYX_MAIN_FROM_NUMBER;
 try {
  global.fetch=async()=>new Response(JSON.stringify({data:{id:'owned-number',status:'active',phone_number:'+15550002222'}}));
  assert.equal((await handsetCallingIdentity(pool,phone,null,{internal:false})).number,'+15550002222');
  process.env.TELNYX_MAIN_FROM_NUMBER='+15550003333';
  assert.equal((await handsetCallingIdentity(pool,{id:phone.id},null,{internal:false})).number,'+15550003333');
  await pool.query('UPDATE users SET voice_number=NULL WHERE id=$1',[agent]);
  await assert.rejects(handsetCallingIdentity(pool,phone,{agent_id:agent},{internal:false}),{status:409});
 } finally {global.fetch=originalFetch;if(originalFrom===undefined)delete process.env.TELNYX_MAIN_FROM_NUMBER;else process.env.TELNYX_MAIN_FROM_NUMBER=originalFrom;}
});

test('parked outgoing credential-connection events identify physical keypad origination',async()=>{
 const {matchHandsetOriginator}=await import('../lib/acd/handset-outbound.mjs');
 const phone={id:randomUUID(),station_id:randomUUID(),sip_username:'phone0004F2000001'};
 const db={query:async sql=>({rows:sql.includes('to_regclass')?[{phones:'hp_phones'}]:[phone]})};
 const event={eventType:'call.initiated',payload:{direction:'outgoing',state:'parked',connection_id:'physical-connection',call_control_id:'v3:physical-keypad',to:'sip:controlled-receiver@sip.telnyx.com'}};
 assert.equal(await matchHandsetOriginator(db,event),phone);
 assert.equal(await matchHandsetOriginator(db,{...event,payload:{...event.payload,state:'ringing'}}),null);
 assert.equal(await matchHandsetOriginator(db,{...event,payload:{...event.payload,custom_headers:[{name:'X-CC-Work-Item-Id',value:randomUUID()}]}}),null);
 assert.equal(await matchHandsetOriginator(db,{...event,payload:{...event.payload,to:`sip:${phone.sip_username}@sip.telnyx.com`}}),null);
});

test('signed-in physical keypad admission reserves capacity using a UUID handling identity and normalizes SIP targets',async()=>{
 const {applyHandsetOutbound}=await import('../lib/acd/handset-outbound.mjs');
 const {ensureStationSchema}=await import('../lib/telephony/stations-schema.mjs');
 await pool.query(`CREATE TABLE IF NOT EXISTS hp_phones(id UUID PRIMARY KEY,telnyx_connection_id TEXT,telnyx_credential_id TEXT,sip_username TEXT,provisioning_state TEXT)`);
 await ensureStationSchema(pool);
 const agent=randomUUID(),phone=randomUUID(),station=randomUUID(),endpoint=randomUUID();
 await seedAgent(pool,agent);
 await pool.query("UPDATE users SET voice_number='+15550001111' WHERE id=$1",[agent]);
 await pool.query("INSERT INTO hp_phones(id,telnyx_connection_id,sip_username,provisioning_state) VALUES($1,$2,'physical-test','provisioned')",[phone,phone]);
 await pool.query("INSERT INTO cc_phone_stations(id,name,kind,phone_id) VALUES($1,'Test phone','deskphone',$2)",[station,phone]);
 await pool.query("INSERT INTO cc_voice_endpoints(id,agent_id,auth_session_id,device_id,kind,label,secret_hash,station_id) VALUES($1,$2,'test-login','test-device','deskphone','Test','test',$3)",[endpoint,agent,station]);
 await pool.query("INSERT INTO cc_station_leases(station_id,agent_id,auth_session_id,endpoint_id,expires_at) VALUES($1,$2,'test-login',$3,now()+interval '1 minute')",[station,agent,endpoint]);
 const event={eventId:randomUUID(),eventType:'call.initiated',payload:{direction:'outgoing',state:'parked',connection_id:phone,call_control_id:'v3:physical-'+randomUUID(),call_session_id:randomUUID(),to:'controlled-recipient@test.invalid'}};
 const provider=makeFakeProvider([{outcome:'accepted',response:{data:{result:'ok'}}}]);
 assert.equal((await applyHandsetOutbound(pool,provider,event)).outcome,'applied');
 const work=(await pool.query("SELECT * FROM acd_work_items WHERE attributes->>'native_station_id'=$1",[station])).rows[0];
 assert.equal(work.attributes.outbound_cli,'+15550001111');
 assert.equal(work.attributes.dial_target.destination,'sip:controlled-recipient@test.invalid');
 assert.equal((await pool.query("SELECT handling_session_id,state FROM acd_reservations WHERE work_item_id=$1",[work.id])).rows[0].handling_session_id,work.id);
 assert.deepEqual(provider.calls.map(c=>c.operation),['handset_answer']);
 assert.equal((await applyHandsetOutbound(pool,provider,event)).outcome,'noop');
 assert.equal(provider.calls.length,1);
});

for(const ambiguous of [false,true])test(`CTI handset SIP evidence binds the frozen queue without a callback (ambiguous=${ambiguous})`,async()=>{
 const {applyHandsetOutbound}=await import('../lib/acd/handset-outbound.mjs');
 const f=await fixture({queue:true,native:true}),phone=randomUUID();
 if(ambiguous)f.provider=makeFakeProvider([{outcome:'ambiguous',response:{error:'phone_reply_lost'}},{outcome:'accepted',response:{data:{result:'ok'}}}]);
 await pool.query("INSERT INTO hp_phones(id,telnyx_connection_id,sip_username,provisioning_state) VALUES($1::uuid,$1::text,'native-origin','provisioned')",[phone]);
 await pool.query("INSERT INTO cc_phone_stations(id,name,kind,phone_id) VALUES($1,'Native origination','deskphone',$2)",[f.context.stationId,phone]);
 await pool.query("INSERT INTO cc_voice_endpoints(id,agent_id,auth_session_id,device_id,kind,label,secret_hash,station_id,outbound_identity) VALUES($1,$2,'native-login','native-device','deskphone','Native','secret',$3,'personal')",[f.context.nativeOrigination.endpointId,f.agentId,f.context.stationId]);
 await pool.query("INSERT INTO cc_station_leases(station_id,agent_id,auth_session_id,endpoint_id,expires_at) VALUES($1,$2,'native-login',$3,now()+interval '1 minute')",[f.context.stationId,f.agentId,f.context.nativeOrigination.endpointId]);
 await driveSaga(pool,f.saga.id,{provider:f.provider});await driveSaga(pool,f.saga.id,{provider:f.provider});
 assert.deepEqual(f.provider.calls.map(c=>c.operation),['manual_outbound_phone_dial']);
 const event={eventId:randomUUID(),eventType:'call.initiated',payload:{direction:'outgoing',state:'parked',connection_id:phone,call_control_id:'v3:origin-'+randomUUID(),call_session_id:randomUUID(),to:f.context.nativeOrigination.number}};
 const single=new pool.constructor({...pool.options,max:1,connectionTimeoutMillis:1000});
 try{
 assert.equal((await applyHandsetOutbound(single,f.provider,event)).workItemId,f.intent.work_item_id);
 assert.equal(f.provider.calls.at(-1).operation,'handset_answer','Backend answers the outgoing SIP leg, not an incoming phone call');
 await applyHandsetOutbound(single,f.provider,event);
 assert.equal(f.provider.calls.filter(c=>c.operation==='handset_answer').length,1);
 await applyDirectCapacityEventWithRejection(pool,{...event,eventId:randomUUID(),eventType:'call.answered'},{provider:f.provider});
 const dial=f.provider.calls.find(c=>c.operation==='manual_outbound_dial');assert.equal(dial.request.from,'+15550001002');
 assert.equal(f.provider.calls.some(c=>c.operation==='manual_outbound_station_dial'),false);
 assert.equal((await pool.query("SELECT queue_id FROM acd_segments WHERE work_item_id=$1 AND kind='agent'",[f.intent.work_item_id])).rows[0].queue_id,f.queueId);
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM acd_work_items WHERE attributes->>'native_station_id'=$1",[f.context.stationId])).rows[0].n,1);
 }finally{await single.end();}
});

test('ambiguous direct handset Dial is never replayed and keeps ACD capacity reserved',async()=>{
 const f=await fixture({native:true});const provider=makeFakeProvider([{outcome:'ambiguous',response:{error:'timeout'}}]);
 await driveSaga(pool,f.saga.id,{provider});await driveSaga(pool,f.saga.id,{provider});
 assert.equal(provider.calls.length,1);assert.equal(provider.calls[0].operation,'manual_outbound_phone_dial');
 await pool.query("UPDATE acd_direct_intents SET created_at=now()-interval '3 minutes' WHERE id=$1",[f.intent.id]);
 await pool.query("UPDATE users SET telephony_credentials_id='browser-only-credential' WHERE id=$1",[f.agentId]);
 let checked=false;await sweepAbandonedDirectIntents(pool,{provider:{send:async()=>{checked=true;return{outcome:'accepted',response:{data:{ended:true}}};}}});
 assert.equal(checked,false,'Browser credential absence must not release deskphone capacity');
 assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[f.intent.reservation_id])).rows[0].state,'active');
});

test('definitively rejected handset Dial releases capacity without dialing the customer',async()=>{
 const f=await fixture({native:true});const provider=makeFakeProvider([{outcome:'failed',httpStatus:409,response:{error:'phone_not_idle'}}]);
 await driveSaga(pool,f.saga.id,{provider});
 assert.equal(provider.calls.length,1);
 assert.equal((await pool.query('SELECT state FROM acd_reservations WHERE id=$1',[f.intent.reservation_id])).rows[0].state,'released');
});

test('native intent retries cannot switch their authenticated endpoint or physical destination',async()=>{
 const f=await fixture({native:true});
 for(const patch of [{endpointId:randomUUID()},{number:'+15550002001'}]){
  await assert.rejects(reserveDirectVoice(pool,{agentId:f.agentId,requestId:f.requestId,target:f.context.target.destination,dialContext:{...f.context,nativeOrigination:{...f.context.nativeOrigination,...patch}}}),{status:409});
 }
});
