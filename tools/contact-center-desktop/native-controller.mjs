import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { polycomDriver } from '../../lib/hardphones/drivers/polycom.mjs';
import { yealinkDriver } from '../../lib/hardphones/drivers/yealink.mjs';
import { nativePhoneState, nativeActionAllowed } from '../../lib/telephony/native-phone-state.mjs';
import { nativeDialTarget, sameNativeDestination } from '../../lib/hardphones/native-dial-target.mjs';

const events = new Set(['incoming','outgoing','connected','ended','held','resumed','muted','unmuted']);
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
// Expose only known OS error codes, never driver messages containing addresses,
// authentication headers or other private response details.
const networkError=error=>String(error||'').match(/\b(EHOSTUNREACH|ENETUNREACH|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|ECONNRESET)\b/)?.[1];
export class YealinkObservation {
  constructor(){this.calls=new Map();this.ended=new Set();this.known=false;this.revision=0;}
  event(event,id,remote='',local=''){
    if(!events.has(event)||!/^\d{1,10}$/.test(id||''))return false;
    if(event==='ended'){
      this.calls.delete(id);this.ended.add(id);if(this.ended.size>256)this.ended.delete(this.ended.values().next().value);
      this.known=true;this.revision++;return true;
    }
    if(this.ended.has(id))return false;
    let call=this.calls.get(id);
    if(!call){
      if(!['incoming','outgoing'].includes(event))return false;
      call={Ref:id,Type:event,Muted:null,RemotePartyNumber:remote.slice(0,128),LocalPartyNumber:local.slice(0,128)};
      this.calls.set(id,call);
    }
    if(['incoming','outgoing'].includes(event)&&call.CallState)return false;
    if(event==='muted'||event==='unmuted')call.Muted=event==='muted';
    else call.CallState={incoming:'ringing',outgoing:'dialing',connected:'active',held:'held',resumed:'active'}[event];
    this.known=true;this.revision++;return true;
  }
  snapshot(){return {call:[...this.calls.values()].map(c=>({...c})),callStateKnown:this.known};}
}

// Device passwords live only in the private desktop configuration and this utility
// process. Neither the remote renderer nor the read-only status window receives them.
export async function startNativeController({getPhones,host,port,onEvent=()=>{},confirmationTimeoutMs=6000,drivers={polycom:polycomDriver,yealink:yealinkDriver}}){
  const observations=new Map(),snapshots=new Map(),queues=new Map();let stopped=false,polling=false;
  const serial=(id,fn)=>{const next=(queues.get(id)||Promise.resolve()).catch(()=>{}).then(fn);queues.set(id,next);return next.finally(()=>{if(queues.get(id)===next)queues.delete(id);});};
  const observation=id=>{if(!observations.has(id))observations.set(id,new YealinkObservation());return observations.get(id);};
  async function read(phone){
    const driver=drivers[phone.vendor];if(!driver)return {ok:false,reason:'unsupported_vendor'};
    const result=await driver.status(phone);
    const line=(Array.isArray(result.line)?result.line:[result.line]).find(Boolean);
    const snapshot={ok:result.ok,reachable:result.reachable,reason:result.reason,
      networkError:result.ok?undefined:networkError(result.error),
      registration:result.registration||line?.RegistrationStatus||null,
      call:result.call||[],callStateKnown:result.ok&&result.callStateKnown!==false};
    if(phone.vendor==='yealink'&&!result.ok)observation(phone.id).known=false;
    if(phone.vendor==='yealink')Object.assign(snapshot,observation(phone.id).snapshot(),{callStateKnown:result.ok&&observation(phone.id).known});
    snapshots.set(phone.id,snapshot);return snapshot;
  }
  function snapshot(id){const cached=snapshots.get(id);return cached?{...cached,...(observations.has(id)?{...observation(id).snapshot(),callStateKnown:cached.ok&&observation(id).known}:{})}:{ok:false,callStateKnown:false,call:[]};}
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://desktop');
    const phones=await getPhones();const phone=phones.find(p=>p.vendor==='yealink'&&url.pathname===`/phone-events/${p.id}`);
    // Tokens are per handset, bounded to an explicitly configured LAN address.
    if(req.method!=='GET'||req.url.length>2048||!phone||req.socket.remoteAddress!==phone.ip_address||!equal(url.searchParams.get('token'),phone.event_token)){
      res.writeHead(404);res.end();return;
    }
    const event=url.searchParams.get('event'),callRef=url.searchParams.get('id');
    const accepted=observation(phone.id).event(event,callRef,url.searchParams.get('remote')||'',url.searchParams.get('local')||'');
    if(accepted)onEvent({name:'yealink_device_event',phoneId:phone.id,event,callRef});
    else onEvent({name:'yealink_event_rejected',phoneId:phone.id,event:events.has(event)?event:'unknown',validCallRef:/^\d{1,10}$/.test(callRef||'')});
    res.writeHead(accepted?200:400,{'Cache-Control':'no-store'});res.end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  server.requestTimeout=5000;server.headersTimeout=5000;
  async function command({phoneId,action,callRef,digits,number,intentId,expiresAt}){
    return serial(phoneId,async()=>{
      const phone=(await getPhones()).find(p=>p.id===phoneId);if(!phone)return {ok:false,reason:'phone_not_authorized'};
      if(action==='status')return read(phone);
      if(action==='dial'){
        nativeDialTarget(number);
        const current=await read(phone),state=nativePhoneState(current,{callStateKnown:current.callStateKnown});
        if(!current.ok || state.status!=='idle')return {ok:false,reason:'phone_not_idle',definitive:true};
        if(!intentId || expiresAt<Date.now())return {ok:false,reason:'dial_intent_expired',definitive:true};
        const result=await drivers[phone.vendor].dial(phone,number);
        onEvent({name:'native_dial_requested',phoneId,intentId,accepted:result.ok});
        if(result.ok && phone.vendor==='yealink'){
          const deadline=Date.now()+confirmationTimeoutMs;
          while(Date.now()<deadline){
            const call=[...observation(phoneId).calls.values()].find(c=>c.Type==='outgoing'&&sameNativeDestination(c.RemotePartyNumber,number));
            if(call)return {ok:true,callRef:call.Ref};
            await new Promise(r=>setTimeout(r,100));
          }
          return {ok:false,reason:'phone_origination_unconfirmed'};
        }
        return result.ok?{ok:true}: {ok:false,reason:result.reason||'dial_unconfirmed',definitive:result.definitive===true};
      }
      // Polycom re-reads the exact call in its shared driver before mutation.
      // Yealink uses device callbacks plus a fresh reachability/registration check.
      const current=phone.vendor==='polycom'?snapshot(phone.id):await read(phone),state=nativePhoneState(current,{callStateKnown:current.callStateKnown});
      if(!current.ok||!nativeActionAllowed(state,action)||state.callRef!==callRef)return {ok:false,reason:'call_state_changed'};
      if(phone.vendor==='yealink'&&['mute','unmute'].includes(action)&&state.isMuted===(action==='mute'))return {ok:true};
      const driver=drivers[phone.vendor],before=phone.vendor==='yealink'?observation(phoneId).revision:0;
      const result=action==='send_dtmf'?await driver.sendDtmf(phone,digits,{callRef})
        :['mute','unmute'].includes(action)?await driver.mute(phone,action==='mute',{callRef})
        :await driver[action](phone,{callRef});
      if(!result.ok)return {ok:false,reason:result.reason||'device_command_failed'};
      // An HTTP 200 from Action URI is only acceptance. Confirm the operation
      // using a new event from the physical phone; never invent mute/hold state.
      if(phone.vendor==='yealink'&&action!=='send_dtmf'){
        const deadline=Date.now()+confirmationTimeoutMs;
        while(Date.now()<deadline){
          const observed=observation(phoneId),next=nativePhoneState(observed.snapshot(),{callStateKnown:observed.known});
          const confirmed=action==='hangup'?!observed.calls.has(callRef):next.callRef===callRef&&
            (action==='answer'||action==='resume'?next.status==='active':action==='hold'?next.isHeld:next.isMuted===(action==='mute'));
          if(observed.revision>before&&confirmed){onEvent({name:'native_command_confirmed',phoneId,action,callRef});return {ok:true};}
          await new Promise(r=>setTimeout(r,100));
        }
        observation(phoneId).known=false; // A lost toggle acknowledgement must not permit a blind retry.
        return {ok:false,reason:'device_confirmation_timeout'};
      }
      onEvent({name:'native_command_accepted',phoneId,action,callRef});return {ok:true};
    });
  }
  async function poll(){
    if(stopped||polling)return;polling=true;
    try{const phones=await getPhones();
      for(const id of snapshots.keys())if(!phones.some(p=>p.id===id)){snapshots.delete(id);observations.delete(id);}
      await Promise.allSettled(phones.map(p=>serial(p.id,()=>read(p))));
    }finally{polling=false;}
  }
  const timer=setInterval(()=>void poll(),5000);
  return {command,snapshot,eventPort:server.address().port,refresh:poll,stop:async()=>{stopped=true;clearInterval(timer);server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
