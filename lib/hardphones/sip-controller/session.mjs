import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { header, setHeader, cseq, responseCode, tag, uri, direction, withDirection, SequenceSpace } from './protocol.mjs';
import { nativeDialTarget, sameNativeDestination } from '../native-dial-target.mjs';

// One registered phone / one upstream TCP flow. Media remains phone <-> Telnyx.
// Only this flow's actual SIP dialogs can be controlled; no out-of-dialog keys.
export class SipPhoneSession {
  constructor({ phone, host, port, toPhone, toProvider, originate, onEvent = () => {} }) {
    Object.assign(this, { phone, host, port, toPhone, toProvider, originate, onEvent });
    this.dialogs = new Map(); this.registered = false; this.closed = false;this.originations=new Map();
  }
  record(name, d, extra = {}) { this.onEvent({ name, phoneId: this.phone.id, callRef: d?.ref, ...extra }); }
  observe(side, m) {
    const code = responseCode(m), seq = cseq(m), id = header(m, 'call-id');
    if (code) this.record('sip_response',this.dialogs.get(id),{side,method:seq.method,code});
    if (seq.method === 'REGISTER') {
      if(side==='phone'&&!code){this.phoneContact=uri(header(m,'contact'));this.phoneAor=uri(header(m,'from'));}
      if (code >= 200 && side === 'provider') this.registered = code === 200;
      return this.forward(side, m);
    }
    // A new TCP flow does not restore the provider's old registration binding.
    // AudioCodes can probe the registrar with OPTIONS after a bridge restart;
    // forwarding a 200 here keeps that stale binding until its normal expiry.
    // Report the missing registration so registrar keep-alive triggers REGISTER.
    // Once REGISTER succeeds, all probes pass through normally.
    if (side === 'phone' && !code && seq.method === 'OPTIONS' && !this.registered && !tag(header(m,'to'))) {
      const response={start:'SIP/2.0 503 Service Unavailable',
        headers:m.headers.filter(([k])=>['via','from','to','call-id','cseq'].includes(k.toLowerCase())).map(([k,v])=>[k,v]),body:''};
      setHeader(response,'To',`${header(m,'to')};tag=${randomUUID()}`);
      setHeader(response,'Retry-After','15');
      this.toPhone(response);this.record('registration_required');return;
    }
    const origin=this.originations.get(id);
    if(side==='phone'&&origin){
      if(code&&seq.method==='REFER'){
        if(code>=300)origin.reject(Object.assign(Error(`phone_sip_${code}`),{definitive:true}));
        return;
      }
      if(!code&&seq.method==='NOTIFY'){
        this.toPhone({start:'SIP/2.0 200 OK',headers:m.headers.filter(([k])=>['via','from','to','call-id','cseq'].includes(k.toLowerCase())),body:''});
        this.record('origination_notify',null,{code:Number(m.body.match(/SIP\/2.0 (\d+)/)?.[1])||null});return;
      }
    }
    let d = this.dialogs.get(id);
    if (!d && !code && seq.method === 'INVITE' && !tag(header(m,'to'))) {
      if (this.dialogs.size >= 8) throw Error('sip_dialog_limit');
      d = { id, ref: randomUUID(), incoming: side === 'provider', state: side === 'provider' ? 'proceeding' : 'dialing', muted: false,
        toPhone: new SequenceSpace(), toProvider: new SequenceSpace(), pending: new Map(), providerPending: new Map(), awaitingAck: new Set(), busy: false,
        providerAddress: header(m, side === 'provider' ? 'from' : 'to'), phoneAddress: header(m, side === 'phone' ? 'from' : 'to'),
        providerTarget: side === 'provider' ? uri(header(m,'contact')) : uri(header(m,'to')),
        phoneTarget: side === 'phone' ? uri(header(m,'contact')) : m.start.split(' ')[1], bornAt: Date.now() };
      this.dialogs.set(id, d); this.record('dialog_created',d);
      if(side==='phone')for(const pending of this.originations.values())if(!pending.finished&&sameNativeDestination(m.start.split(' ')[1],pending.number))pending.resolve({ok:true,callRef:d.ref});
    }
    if (!d) return this.forward(side,m);
    if(!code)this.record('sip_request',d,{side,method:seq.method});
    // A UAS follows Record-Route in request order; a UAC reverses the response
    // order. Telnyx Contact can be a private address and requires this route set.
    if (side === 'provider' && seq.method === 'INVITE' && !d.providerRoutes &&
        ((!code && !tag(header(m,'to'))) || (code >= 200 && code < 300 && !d.incoming))) {
      const routes=m.headers.filter(([k])=>k.toLowerCase()==='record-route').map(([,v])=>v);
      d.providerRoutes=code ? routes.reverse() : routes;
    }
    const pending = side === 'phone' ? d.pending : d.providerPending;
    if (code && pending.has(`${seq.number} ${seq.method}`)) {
      const p = pending.get(`${seq.number} ${seq.method}`);
      if (code >= 200) {
        if(seq.method==='INVITE'&&code>=300){
          const ack=structuredClone(p.request);
          ack.start=ack.start.replace(/^INVITE /,'ACK ');ack.body='';
          setHeader(ack,'CSeq',`${seq.number} ACK`);
          setHeader(ack,'To',header(m,'to'));
          ack.headers=ack.headers.filter(([k])=>k.toLowerCase()!=='content-type');
          (side==='phone'?this.toPhone:this.toProvider)(ack);
        }
        if (side === 'phone' && seq.method === 'INVITE' && code < 300) {
          this.toPhone(this.request(d,'ACK',seq.number));
          // A 200 is insufficient: check the negotiated media direction.
          if (p.mute !== undefined) {
            const accepted = p.mute ? direction(m.body) === 'recvonly' : direction(m.body) === 'sendrecv';
            if (accepted) d.muted = p.mute;
            else { p.reject(Error('phone_rejected_media_direction')); return; }
          }
        }
        if (code < 300) p.resolve(m); else p.reject(Error(`phone_sip_${code}`));
      }
      return;
    }
    if (seq.method === 'INVITE') {
      if (side === 'phone' && code === 180 && d.state === 'proceeding') d.state = 'ringing';
      const originalSide = code ? (side === 'phone' ? 'provider' : 'phone') : side;
      if (!code || (code >= 180 && code < 300)) {
        if (side === 'phone') {
          d.phoneAddress = header(m, code ? 'to' : 'from');
          d.phoneTarget = uri(header(m,'contact')) || d.phoneTarget;
        } else {
          d.providerAddress = header(m, code ? 'to' : 'from');
          d.providerTarget = uri(header(m,'contact')) || d.providerTarget;
        }
      }
      if (m.body) {
        if (side === 'provider') d.providerSdp = m.body;
        else d.phoneSdp = m.body;
      }
      if (!code) {
        d.offers ||= new Map();
        d.offers.set(`${originalSide}:${seq.number}`, direction(m.body));
      } else if (code >= 200 && code < 300) {
        const space = side === 'phone' ? d.toPhone : d.toProvider;
        const original = space.original(seq.number, seq.method) ?? seq.number;
        const offered = d.offers?.get(`${originalSide}:${original}`) || 'sendrecv';
        d.awaitingAck.add(`${originalSide}:${original}`);
        d.state = offered === 'sendonly' || offered === 'inactive' ? 'held' : 'connected';
        this.record('dialog_confirmed',d,{state:d.state,direction:offered});
      } else if (code >= 300 && ![401,407].includes(code) && ['proceeding','ringing','dialing'].includes(d.state)) {
        this.end(d);
      }
    }
    if (!code && seq.method === 'BYE') this.end(d);
    if (!code && seq.method === 'ACK') d.awaitingAck.delete(`${side}:${seq.number}`);
    // Each peer sees its own CSeq space even after locally injected requests.
    if (!code) {
      const space = side === 'provider' ? d.toPhone : d.toProvider;
      setHeader(m, 'CSeq', `${space.translate(seq.number,seq.method)} ${seq.method}`);
    } else {
      const space = side === 'phone' ? d.toPhone : d.toProvider;
      const original = space.original(seq.number,seq.method);
      if (original !== undefined) setHeader(m,'CSeq',`${original} ${seq.method}`);
    }
    if (!code && seq.method === 'INVITE' && side === 'provider' && !d.initialInvite) d.initialInvite = structuredClone(m);
    if (!code && seq.method === 'INVITE' && side === 'phone' && !d.initialOutgoingInvite) d.initialOutgoingInvite = structuredClone(m);
    this.forward(side,m);
  }
  forward(side,m) { (side === 'phone' ? this.toProvider : this.toPhone)(m); }
  end(d) {
    d.state = 'ended'; this.record('dialog_ended',d);
    // Retain transaction mappings for retransmissions, but bound their lifetime.
    const timer = setTimeout(() => this.dialogs.delete(d.id), 32000); timer.unref?.();
  }
  request(d,method,number,body='',extra=[],to='phone') {
    return {start:`${method} ${to==='phone'?d.phoneTarget:d.providerTarget} SIP/2.0`,headers:[
      ['Via',`SIP/2.0/TCP ${this.host}:${this.port};branch=z9hG4bK-${randomUUID()};rport`],
      ['From',to==='phone'?d.providerAddress:d.phoneAddress],['To',to==='phone'?d.phoneAddress:d.providerAddress],
      ['Call-ID',d.id],['CSeq',`${number} ${method}`],['Max-Forwards','70'],
      ...(to==='provider' ? (d.providerRoutes||[]).map(value=>['Route',value]) : []),
      // A target-refresh INVITE changes the handset's remote target. Preserve
      // the provider Contact: Record-Route already keeps the controller in-path.
      // Advertising the phone's own proxy Contact here loops subsequent hold
      // INVITEs back towards the LAN instead of the provider dialog.
      ['Contact',to==='phone'?`<${d.providerTarget}>`:`<sip:${this.phone.sip_username}@${this.host}:${this.port};transport=tcp>`],
      ...extra,...(body?[['Content-Type','application/sdp']]:[]),['Content-Length','0']],body};
  }
  async send(d,method,{body='',headers=[],mute,to='phone',contentType}={}) {
    const number = (to==='phone'?d.toPhone:d.toProvider).allocate(), key = `${number} ${method}`;
    const pending=to==='phone'?d.pending:d.providerPending;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(Error('phone_command_timeout')),8000);
      const finish = fn => value => { clearTimeout(timer); fn(value); };
      const message=this.request(d,method,number,body,headers,to);if(contentType)setHeader(message,'Content-Type',contentType);
      pending.set(key,{resolve:finish(resolve),reject:finish(reject),mute,request:structuredClone(message)});
      (to==='phone'?this.toPhone:this.toProvider)(message);
      // Keep a completed injected INVITE transaction for retransmitted 200/ACK.
      setTimeout(() => pending.delete(key),32000).unref?.();
    });
  }
  async until(d,predicate) {
    const deadline=Date.now()+8000;
    while(!predicate()) {
      if(this.closed || d.state==='ended' || Date.now()>deadline) throw Error('phone_state_not_confirmed');
      await delay(50);
    }
  }
  snapshot() {
    return {ok:!this.closed,reachable:!this.closed,registration:this.registered?'registered':'unknown',
      call:[...this.dialogs.values()].filter(d=>d.state!=='ended').map(d=>({Ref:d.ref,CallState:d.state,Muted:d.muted,
        Type:d.incoming?'incoming':'outgoing',RemotePartyNumber:uri(d.providerAddress).replace(/^sips?:/,'').split('@')[0],
        LocalPartyNumber:this.phone.extension || '',RemotePartyName:''}))};
  }
  async control(action,params) {
    if(action==='status') return this.snapshot();
    if(action==='dial')return this.dial(params);
    const active=[...this.dialogs.values()].filter(d=>d.state!=='ended');
    const d=active.find(d=>d.ref===params.callRef);
    if(this.closed || !d || active.length!==1 || d.busy) throw Error('phone_call_changed_or_busy');
    const cancelling=action==='hangup'&&['proceeding','ringing','dialing'].includes(d.state);
    if(!cancelling&&(!tag(d.providerAddress)||!tag(d.phoneAddress))) throw Error('phone_dialog_not_ready');
    d.busy=true;
    try {
      if(action==='answer') {
        if(d.state!=='ringing') throw Error('phone_not_ringing');
        await this.send(d,'NOTIFY',{headers:[['Event','talk'],['Subscription-State','active']]});
        await this.until(d,()=>d.state==='connected'&&!d.awaitingAck.size);
      } else if(action==='hold'||action==='resume') {
        if(d.state!==(action==='hold'?'connected':'held')) throw Error('invalid_phone_state');
        await this.send(d,'NOTIFY',{headers:[['Event',action==='hold'?'hold':'talk'],['Subscription-State','active']]});
        await this.until(d,()=>d.state===(action==='hold'?'held':'connected')&&!d.awaitingAck.size);
        // Reapply receive-only media after the handset resumes a muted call.
        if(action==='resume'&&d.muted) await this.setMute(d,true);
      } else if(action==='mute'||action==='unmute') {
        if(d.state!=='connected') throw Error('phone_not_connected');
        await this.setMute(d,action==='mute');
      } else if(action==='send_dtmf') {
        if(d.state!=='connected'||!/^[0-9*#A-D]{1,32}$/.test(params.digits||'')) throw Error('invalid_dtmf');
        for(const digit of params.digits) await this.send(d,'INFO',{to:'provider',body:`Signal=${digit}\r\nDuration=160\r\n`,contentType:'application/dtmf-relay'});
      } else if(action==='hangup') {
        if(cancelling && (d.incoming?d.initialInvite:d.initialOutgoingInvite)) {
          const cancel=structuredClone(d.incoming?d.initialInvite:d.initialOutgoingInvite);cancel.start=cancel.start.replace(/^INVITE /,'CANCEL ');cancel.body='';
          cancel.headers=cancel.headers.filter(([k])=>k.toLowerCase()!=='content-type');
          const n=cseq(cancel).number;setHeader(cancel,'CSeq',`${n} CANCEL`);
          (d.incoming?d.pending:d.providerPending).set(`${n} CANCEL`,{resolve:()=>{},reject:()=>{}});
          (d.incoming?this.toPhone:this.toProvider)(cancel);
          await this.until(d,()=>d.state==='ended');return this.snapshot();
        }
        if(!['connected','held'].includes(d.state)) throw Error('phone_not_connected');
        await this.send(d,'BYE');
        await this.send(d,'BYE',{to:'provider'});
        this.end(d);
      } else throw Error('unsupported_sip_control');
      this.record('control_confirmed',d,{action}); return this.snapshot();
    } finally { d.busy=false; }
  }
  async dial({number,intentId,expiresAt}){
    nativeDialTarget(number);
    if(this.closed||!this.registered||!this.phoneContact) return {ok:false,reason:'phone_not_registered',definitive:true};
    if([...this.dialogs.values()].some(d=>d.state!=='ended')||[...this.originations.values()].some(p=>!p.finished))return {ok:false,reason:'phone_not_idle',definitive:true};
    if(!intentId||!Number.isFinite(expiresAt)||expiresAt<Date.now())return {ok:false,reason:'dial_intent_expired',definitive:true};
    const id=`cti-${intentId}@${this.host}`,target=number.startsWith('sip:')?number:`sip:${number}@sip.telnyx.com`;
    if(this.originations.has(id))return {ok:false,reason:'dial_intent_already_dispatched'};
    return new Promise(resolve=>{
      const finish=result=>{clearTimeout(timer);pending.finished=true;resolve(result);};
      const pending={number,finished:false,resolve:finish,reject:e=>finish({ok:false,reason:e.message,definitive:e.definitive===true})};
      // Legacy HTTPS management performs several certificate-checked reads
      // before Dial. Keep that preflight inside the intent's bounded lifetime.
      const timer=setTimeout(()=>finish({ok:false,reason:'phone_origination_unconfirmed'}),Math.min(this.originate?28000:8000,expiresAt-Date.now()));
      this.originations.set(id,pending);setTimeout(()=>this.originations.delete(id),60000).unref?.();
      if(this.originate){
        Promise.resolve().then(()=>this.originate(this.phone,{number,intentId,expiresAt,
          canDial:()=>!pending.finished&&!this.closed&&this.registered&&![...this.dialogs.values()].some(d=>d.state!=='ended')})).then(result=>{
          this.record('origination_http_requested',null,{intentId,accepted:result.ok,reason:result.reason});
          if(!result.ok)finish(result);
        }).catch(pending.reject);
        return;
      }
      try{this.toPhone({start:`REFER ${this.phoneContact} SIP/2.0`,headers:[
        ['Via',`SIP/2.0/TCP ${this.host}:${this.port};branch=z9hG4bK-${randomUUID()};rport`],
        ['From',`<sip:cti@${this.host}>;tag=${randomUUID()}`],['To',`<${this.phoneAor}>`],
        ['Call-ID',id],['CSeq','1 REFER'],['Max-Forwards','70'],
        ['Contact',`<sip:cti@${this.host}:${this.port};transport=tcp>`],['Refer-To',`<${target}>`],['Referred-By',`<${this.phoneAor}>`]],body:''});}catch(e){pending.reject(e);}
      this.record('origination_refer_sent',null,{intentId});
    });
  }
  async setMute(d,muted) {
    if(!d.providerSdp) throw Error('phone_media_not_ready');
    await this.until(d,()=>!d.awaitingAck.size);
    const version = Math.max(Number(d.providerSdp.match(/^o=\S+ \S+ (\d+)/m)?.[1]) || 0,d.sdpVersion || 0)+1;
    d.sdpVersion=version;
    await this.send(d,'INVITE',{body:withDirection(d.providerSdp,muted?'sendonly':'sendrecv',version),mute:muted});
  }
  close() {
    this.closed=true;this.registered=false;
    for(const p of this.originations.values())if(!p.finished)p.reject(Error('phone_disconnected'));
    for(const d of this.dialogs.values()) for(const p of [...d.pending.values(),...d.providerPending.values()]) p.reject(Error('phone_disconnected'));
  }
}
