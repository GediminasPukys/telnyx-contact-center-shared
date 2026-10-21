// Physical-keypad origination enters the same durable call lifecycle as UI dialing.
import { randomUUID } from 'node:crypto';
import { resolveDialTarget, resolveOutboundIdentity, ownedVoiceNumber, isE164 } from '../telephony/dialing.mjs';
import { createWorkItem, applyTransition, openSegment } from './lifecycle.mjs';
import { tryReserveCapacity } from './capacity.mjs';
import { promoteReservation } from './reservations.mjs';
import { startManualOutboundSaga } from './sagas/manual-outbound.mjs';
import { driveSaga, applySagaEvent } from './saga-engine.mjs';
import { rejectUnreservedDirectCall } from './direct-capacity.mjs';
import { sameNativeDestination } from '../hardphones/native-dial-target.mjs';

export async function matchHandsetOriginator(db, event) {
  const p=event.payload || {};
  // Credential-connection parking reports physical origination as outgoing.
  // The parked state plus the provisioned connection identifies this path;
  // Call Control API calls carry Core headers and must never be admitted twice.
  if(event.eventType!=='call.initiated' || !['incoming','inbound','outgoing','outbound'].includes(p.direction)
    || p.state!=='parked' || !p.connection_id || !p.call_control_id
    || (p.custom_headers || []).some(h=>/^x-cc-/i.test(h.name))) return null;
  if (!(await db.query("SELECT to_regclass('hp_phones') AS phones")).rows[0]?.phones) return null;
  const phone=(await db.query(`SELECT p.*,s.id AS station_id,s.enabled AS station_enabled FROM hp_phones p
    JOIN cc_phone_stations s ON s.phone_id=p.id WHERE COALESCE(p.telnyx_connection_id,p.telnyx_credential_id)=$1`,[String(p.connection_id)])).rows[0];
  if(!phone) return null;
  const destination=String(p.to || '').replace(/^sips?:/i,'').split('@')[0];
  // An inbound call to the handset or its legacy DID is not keypad origination.
  if([phone.sip_username,phone.assigned_phone_number].includes(destination))return null;
  return phone;
}

export async function handsetCallingIdentity(db, phone, lease, target) {
  if(lease) return resolveOutboundIdentity(db,lease.agent_id,lease.outbound_identity || 'personal',{internal:target.internal});
  const number=phone.assigned_phone_number_id ? (await ownedVoiceNumber(phone.assigned_phone_number_id))?.number : process.env.TELNYX_MAIN_FROM_NUMBER;
  if(!isE164(number))throw Object.assign(Error('Configure a phone DID or TELNYX_MAIN_FROM_NUMBER'),{status:409});
  return {id:'phone:'+phone.id,kind:'phone',label:phone.phone_name || phone.label,number};
}

export async function applyHandsetOutbound(pool,provider,event) {
  const phone=await matchHandsetOriginator(pool,event);
  if(!phone)return null;
  const p=event.payload;const tx=await pool.connect();let sagaId;
  let released=false;
  const release=()=>{if(!released){released=true;tx.release();}};
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('cc:station-leases',0))");
    const existing=(await tx.query('SELECT owner_saga_id,work_item_id FROM acd_legs WHERE provider_call_id=$1',[p.call_control_id])).rows[0];
    if(existing){await tx.query('COMMIT');release();if(existing.owner_saga_id){
      await applySagaEvent(pool,{workItemId:existing.work_item_id,name:'leg.initiated',role:'agent_device',payload:{event_id:event.eventId,owner_saga_id:existing.owner_saga_id},provider,node:'handset:replay'});
      await driveSaga(pool,existing.owner_saga_id,{provider,node:'handset:replay'});
    }return {handled:true,outcome:'noop'};}
    if(!phone.station_enabled || phone.provisioning_state==='disabled')throw Object.assign(Error('Phone disabled'),{status:409});
    const lease=(await tx.query(`SELECT l.agent_id,l.endpoint_id,e.outbound_identity FROM cc_station_leases l
      JOIN cc_voice_endpoints e ON e.id=l.endpoint_id AND e.revoked_at IS NULL
      WHERE l.station_id=$1 AND l.purpose='work' AND l.expires_at>now() FOR UPDATE OF l`,[phone.station_id])).rows[0];
    // Match only the enrolled SIP connection + occupied station + exact dialed
    // destination. Freeze CLI/queue from the committed intent, never from a
    // mutable UI selection. The station lock serializes keypad/UI races.
    const pending=(await tx.query(`SELECT i.*,w.attributes,w.queue_id,s.id AS saga_id FROM acd_direct_intents i
      JOIN acd_work_items w ON w.id=i.work_item_id JOIN acd_sagas s ON s.work_item_id=w.id AND s.type='manual_outbound'
      WHERE w.attributes->>'native_station_id'=$1 AND w.attributes->'native_origination' IS NOT NULL
        AND w.attributes->'native_origination'<>'null'::jsonb AND i.state='pending' AND i.provider_call_id IS NULL
      ORDER BY i.created_at DESC LIMIT 1 FOR UPDATE OF i`,[phone.station_id])).rows[0];
    if(pending){
      if(!lease||lease.agent_id!==pending.agent_id||lease.endpoint_id!==pending.attributes.native_origination.endpointId||!sameNativeDestination(p.to,pending.attributes.native_origination.number))
        throw Object.assign(Error('Phone call does not match the pending CTI intent'),{status:409});
      const sent=await tx.query(`SELECT 1 FROM acd_commands WHERE saga_id=$1 AND operation='manual_outbound_phone_dial' AND status IN ('sent','accepted','ambiguous','confirmed')`,[pending.saga_id]);
      if(!sent.rowCount)throw Object.assign(Error('CTI dial command was not dispatched'),{status:409});
      await tx.query(`UPDATE acd_direct_intents SET provider_call_id=$2,provider_session_id=$3,state='dialing' WHERE id=$1`,[pending.id,p.call_control_id,p.call_session_id]);
      await tx.query(`INSERT INTO acd_legs(id,work_item_id,role,agent_id,provider_call_id,provider_session_id,owner_saga_id,state)
        VALUES($1,$2,'agent_device',$3,$4,$5,$6,'parked')`,[randomUUID(),pending.work_item_id,pending.agent_id,p.call_control_id,p.call_session_id,pending.saga_id]);
      await tx.query(`UPDATE acd_sagas SET data=data || jsonb_build_object('agentProviderCallId',$2::text,'agentProviderSessionId',$3::text) WHERE id=$1`,[pending.saga_id,p.call_control_id,p.call_session_id]);
      await tx.query(`UPDATE acd_work_items SET provider_session_id=$2,attributes=attributes || jsonb_build_object('handset_originated',true,'agent_device_call_control_id',$3::text) WHERE id=$1`,[pending.work_item_id,p.call_session_id,p.call_control_id]);
      await applyTransition(tx,{workItemId:pending.work_item_id,to:'active',eventType:'native_cti_outbound_started',actor:'phone:'+phone.id});
      await openSegment(tx,{workItemId:pending.work_item_id,kind:'agent',agentId:pending.agent_id,queueId:pending.queue_id});
      await tx.query('COMMIT');
      release(); // Never hold a pool slot while subsequent saga/provider I/O waits.
      // Real SIP evidence resolves even a lost/slow device HTTP response. Do
      // not leave an originated handset ringing until the command deadline.
      await applySagaEvent(pool,{workItemId:pending.work_item_id,name:'leg.initiated',role:'agent_device',payload:{event_id:event.eventId,owner_saga_id:pending.saga_id},provider,node:'handset:cti'});
      await driveSaga(pool,pending.saga_id,{provider,node:'handset:cti'});
      return {handled:true,outcome:'applied',workItemId:pending.work_item_id};
    }
    const raw=String(p.to || '').replace(/^sips?:/i,'');
    const number=raw.split('@')[0];
    // Credential-connection webhooks omit the sip: prefix from SIP destinations.
    const target=await resolveDialTarget(tx,/^[+0-9]+$/.test(number)?number:`sip:${raw}`,{callerId:lease?.agent_id});
    const identity=await handsetCallingIdentity(tx,phone,lease,target);
    const busy=(await tx.query(`SELECT 1 FROM acd_work_items w JOIN acd_legs l ON l.work_item_id=w.id
      WHERE w.attributes->>'native_station_id'=$1 AND l.role='agent_device' AND l.ended_at IS NULL LIMIT 1`,[phone.station_id])).rowCount;
    if(busy)throw Object.assign(Error('Phone already has an active call'),{status:409});
    const work=await createWorkItem(tx,{channel:'voice',direction:target.internal?'internal':'outbound',queueId:identity.queueId || null,
      customerAddress:target.destination,ccAddress:identity.number,providerSessionId:p.call_session_id,
      attributes:{voice_occupancy_kind:'manual_outbound',suppress_wrapup:true,handset_originated:true,native_station_id:phone.station_id,
        outbound_identity:identity.id,outbound_cli:identity.number,dial_target:target,agent_device_call_control_id:p.call_control_id},actor:'phone:'+phone.id});
    let reservationId=null;
    if(lease){
      reservationId=await tryReserveCapacity(tx,{agentId:lease.agent_id,workItemId:work.id,purpose:'manual_outbound',leaseMs:60000,actor:'phone:keypad'});
      if(!reservationId)throw Object.assign(Error('User busy'),{status:409});
      await promoteReservation(tx,{reservationId,to:'active',handlingSessionId:work.id,actor:'phone:keypad'});
    }
    if(target.userId){
      const targetReservation=await tryReserveCapacity(tx,{agentId:target.userId,workItemId:work.id,purpose:'direct_inbound',leaseMs:60000,actor:'phone:keypad'});
      if(!targetReservation)throw Object.assign(Error('Recipient busy'),{status:409});
      await promoteReservation(tx,{reservationId:targetReservation,to:'active',handlingSessionId:work.id,actor:'phone:keypad'});
      await tx.query("UPDATE acd_work_items SET attributes=attributes || jsonb_build_object('outbound_target_reservation',$2::text) WHERE id=$1",[work.id,targetReservation]);
    }
    await applyTransition(tx,{workItemId:work.id,to:'offered',eventType:'handset_outbound_prepared',actor:'phone:keypad'});
    await applyTransition(tx,{workItemId:work.id,to:'active',eventType:'handset_outbound_started',actor:'phone:keypad'});
    await openSegment(tx,{workItemId:work.id,kind:lease?'agent':'park',agentId:lease?.agent_id,queueId:identity.queueId});
    await tx.query(`INSERT INTO acd_legs(id,work_item_id,role,agent_id,provider_call_id,provider_session_id,state)
      VALUES($1,$2,'agent_device',$3,$4,$5,'parked')`,[randomUUID(),work.id,lease?.agent_id || null,p.call_control_id,p.call_session_id]);
    const queue=target.type==='queue'?(await tx.query('SELECT id,name FROM cc_queues WHERE id=$1',[target.queueId])).rows[0]:null;
    sagaId=(await startManualOutboundSaga(tx,{workItemId:work.id,agentId:lease?.agent_id || null,reservationId,
      directIntentId:null,agentProviderCallId:p.call_control_id,target:target.destination,fromNumber:identity.number,
      fromDisplayName:identity.label,connectionId:process.env.TELNYX_CALL_CONTROL_ID,handsetOriginated:true,internalQueue:queue})).sagaId;
    await tx.query('COMMIT');
  }catch(error){
    if(!released)await tx.query('ROLLBACK');
    release();
    if(!error.status)throw error;
    await rejectUnreservedDirectCall(pool,p,provider,{reason:error.message});
    return {handled:true,outcome:'applied',rejected:true};
  }finally{release();}
  await driveSaga(pool,sagaId,{provider,node:'handset:keypad'});
  return {handled:true,outcome:'applied'};
}
