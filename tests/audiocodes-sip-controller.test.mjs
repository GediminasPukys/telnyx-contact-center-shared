import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSipFrames, encodeSip, header, cseq, SequenceSpace, withDirection } from '../lib/hardphones/sip-controller/protocol.mjs';
import { SipPhoneSession } from '../lib/hardphones/sip-controller/session.mjs';
import { anchorPhoneRoute, removeLocalRoute } from '../lib/hardphones/sip-controller/routing.mjs';
const request=(method,n=1,body='')=>({start:`${method} sip:phone@test SIP/2.0`,headers:[['From','<sip:remote@test>;tag=remote'],['To','<sip:phone@test>'],['Call-ID','test-dialog'],['CSeq',`${n} ${method}`],['Contact','<sip:remote@test>']],body});
const answer=(m,code=200,body='')=>({...structuredClone(m),start:`SIP/2.0 ${code} OK`,headers:m.headers.map(([k,v])=>[k,k==='To'?v+';tag=phone':k==='Contact'?'<sip:phone@test>':v]),body});
const sdp='v=0\r\no=peer 1 2 IN IP4 127.0.0.1\r\ns=call\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\na=sendrecv\r\n';

test('a post-restart registrar probe cannot conceal a missing registration binding',()=>{
 const phone=[],provider=[];const s=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:m=>phone.push(m),toProvider:m=>provider.push(m)});
 const options=request('OPTIONS',11);options.headers.push(['Via','SIP/2.0/TCP phone;branch=z9hG4bK-probe']);
 s.observe('phone',options);
 assert.equal(provider.length,0);assert.equal(phone[0].start,'SIP/2.0 503 Service Unavailable');
 for(const key of ['via','from','call-id','cseq'])assert.equal(header(phone[0],key),header(options,key));
 assert.match(header(phone[0],'to'),/;tag=/);assert.equal(header(phone[0],'retry-after'),'15');
 assert.equal(s.snapshot().registration,'unknown');
 const register=request('REGISTER',12);s.observe('phone',register);s.observe('provider',answer(register,401));
 s.observe('phone',options);assert.equal(phone.at(-1).start,'SIP/2.0 503 Service Unavailable');
 s.observe('phone',register);s.observe('provider',answer(register));
 s.observe('phone',options);assert.equal(provider.at(-1),options);assert.equal(s.snapshot().registration,'registered');s.close();
});

test('provider and in-dialog OPTIONS are not intercepted by registration recovery',()=>{
 const phone=[],provider=[];const s=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:m=>phone.push(m),toProvider:m=>provider.push(m)});
 const options=request('OPTIONS');s.observe('provider',options);assert.equal(phone.at(-1),options);
 const dialog=request('OPTIONS',2);dialog.headers=dialog.headers.map(([k,v])=>[k,k==='To'?`${v};tag=dialog`:v]);
 s.observe('phone',dialog);assert.equal(provider.at(-1),dialog);s.close();
});

test('TCP framing handles fragmented bodies, pipelined messages and keepalives',()=>{
 const first=encodeSip(request('INVITE',1,'abcdef')),second=encodeSip(request('OPTIONS',2));
 const partial=decodeSipFrames(Buffer.from('\r\n'+first.slice(0,-2)));assert.equal(partial.messages.length,0);
 const done=decodeSipFrames(Buffer.concat([partial.buffer,Buffer.from(first.slice(-2)+second)]));assert.equal(done.messages.length,2);assert.equal(done.messages[0].body,'abcdef');assert.equal(done.buffer.length,0);
});
test('rejects ambiguous or unbounded SIP frames',()=>{
 assert.throws(()=>decodeSipFrames(Buffer.from('X\r\nContent-Length: 0\r\nl: 5\r\n\r\n')),/invalid_sip_length/);
 assert.throws(()=>decodeSipFrames(Buffer.from('X\r\nContent-Length: 262145\r\n\r\n')),/too_large/);
 assert.throws(()=>decodeSipFrames(Buffer.alloc(65537,65)),/too_large/);
});
test('injected CSeq does not collide with later provider requests or ACK retransmissions',()=>{
 const space=new SequenceSpace();assert.equal(space.translate(10,'INVITE'),10);assert.equal(space.allocate(),11);
 assert.equal(space.translate(11,'INVITE'),12);assert.equal(space.translate(11,'ACK'),12);assert.equal(space.translate(11,'CANCEL'),12);
 assert.equal(space.translate(11,'INVITE'),12);assert.equal(space.original(12,'INVITE'),11);
});
test('media mutation preserves destination and advances SDP version',()=>{
 const muted=withDirection(sdp,'sendonly',3);assert.match(muted,/o=peer 1 3 /);assert.match(muted,/m=audio 4000/);assert.match(muted,/a=sendonly/);assert.doesNotMatch(muted,/sendrecv/);
});
test('Answer waits for initial INVITE 200; NOTIFY uses the exact dialog and stale references fail closed',async()=>{
 const toPhone=[],toProvider=[];const session=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:m=>toPhone.push(structuredClone(m)),toProvider:m=>toProvider.push(m)});
 const invite=request('INVITE',42,sdp);session.observe('provider',invite);session.observe('phone',answer(invite,180));
 const callRef=session.snapshot().call[0].Ref;await assert.rejects(session.control('answer',{callRef:'stale'}),/changed/);
 const pending=session.control('answer',{callRef});const notify=toPhone.at(-1);assert.equal(header(notify,'from'),'<sip:remote@test>;tag=remote');assert.equal(header(notify,'to'),'<sip:phone@test>;tag=phone');assert.equal(header(notify,'call-id'),'test-dialog');assert.equal(cseq(notify).number,43);
 session.observe('phone',answer(notify));assert.equal(session.snapshot().call[0].CallState,'ringing');
 session.observe('phone',answer(invite,200,sdp));assert.equal(session.snapshot().call[0].CallState,'connected');
 let completed=false;pending.then(()=>completed=true);await new Promise(r=>setTimeout(r,60));assert.equal(completed,false,'Answer must wait for the provider ACK before accepting another command');
 session.observe('provider',request('ACK',42));await pending;
 const mute=session.control('mute',{callRef});await new Promise(r=>setImmediate(r));const reinvite=toPhone.at(-1);session.observe('phone',answer(reinvite,200,withDirection(sdp,'recvonly',3)));await mute;
 assert.equal(header(reinvite,'contact'),`<${[...session.dialogs.values()][0].providerTarget}>`,'Mute must not redirect subsequent handset requests to the handset proxy identity');
 assert.equal(session.snapshot().call[0].Muted,true);assert.equal(cseq(toPhone.at(-1)).method,'ACK');assert.equal(toProvider.length,2,'Injected responses stay local');session.close();
});
test('a rejected injected INVITE is ACKed in its own transaction without changing mute state',async()=>{
 const sent=[];const s=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:m=>sent.push(structuredClone(m)),toProvider:()=>{}});
 const invite=request('INVITE',42,sdp);s.observe('provider',invite);s.observe('phone',answer(invite,200,sdp));s.observe('provider',request('ACK',42));
 const pending=s.control('mute',{callRef:s.snapshot().call[0].Ref});await new Promise(r=>setImmediate(r));const reinvite=sent.at(-1);
 s.observe('phone',answer(reinvite,500));
 await assert.rejects(pending,/phone_sip_500/);
 const ack=sent.at(-1);assert.equal(cseq(ack).method,'ACK');assert.equal(cseq(ack).number,cseq(reinvite).number);assert.equal(header(ack,'via'),header(reinvite,'via'));assert.equal(s.snapshot().call[0].Muted,false);s.close();
});
test('unknown/multiple calls and disconnected flows cannot be controlled',async()=>{
 const s=new SipPhoneSession({phone:{},host:'127.0.0.1',port:5070,toPhone:()=>{},toProvider:()=>{}});
 s.observe('provider',request('INVITE'));const r=s.snapshot().call[0].Ref;
 const other=request('INVITE');other.headers=other.headers.map(([k,v])=>[k,k==='Call-ID'?'other':v]);s.observe('provider',other);
 await assert.rejects(s.control('answer',{callRef:r}),/changed/);s.close();assert.equal(s.snapshot().ok,false);
});

test('injected provider requests retain the incoming Telnyx route set',()=>{
 const upstream=[];const s=new SipPhoneSession({phone:{id:'p',sip_username:'phone'},host:'127.0.0.1',port:5070,toPhone:()=>{},toProvider:m=>upstream.push(m)});
 const invite=request('INVITE',12,sdp);invite.headers.push(['Record-Route','<sip:edge.example:5060;lr>'],['Record-Route','<sip:core.internal:5060;lr>']);
 s.observe('provider',invite);s.observe('phone',answer(invite,200,sdp));
 const dialog=[...s.dialogs.values()][0];
 const bye=s.request(dialog,'BYE',10,'',[],'provider');
 assert.deepEqual(bye.headers.filter(([k])=>k==='Route').map(([,v])=>v),['<sip:edge.example:5060;lr>','<sip:core.internal:5060;lr>']);
 assert.equal(header(bye,'from'),'<sip:phone@test>;tag=phone');
 assert.equal(header(bye,'to'),'<sip:remote@test>;tag=remote');s.close();
});
test('handset routing stays on the LAN controller without exposing its local route upstream',()=>{
 const incoming=request('INVITE',5,sdp);
 incoming.headers.push(['Record-Route','<sip:edge.example;lr>'],['Record-Route','<sip:core.example;lr>']);
 anchorPhoneRoute(incoming,'192.168.50.45',5070);
 const routes=incoming.headers.filter(([k])=>k==='Record-Route').map(([,v])=>v);
 assert.deepEqual(routes,['<sip:192.168.50.45:5070;lr;transport=tcp>','<sip:edge.example;lr>','<sip:core.example;lr>']);
 const hold=request('INVITE',6,sdp);hold.headers.push(...routes.map(v=>['Route',v]));
 removeLocalRoute(hold,'192.168.50.45',5070);
 assert.deepEqual(hold.headers.filter(([k])=>k==='Route').map(([,v])=>v),routes.slice(1));
 const outgoingResponse=answer(request('INVITE',7,sdp));outgoingResponse.headers.push(['Record-Route','<sip:edge.example;lr>']);
 anchorPhoneRoute(outgoingResponse,'192.168.50.45',5070);
 assert.equal(outgoingResponse.headers.filter(([k])=>k==='Record-Route').at(-1)[1],routes[0]);
 removeLocalRoute(incoming,'192.168.50.45',5070);
 assert.equal(incoming.headers.some(([,v])=>v.includes('192.168.50.45')),false);
 const echoed=answer(request('INVITE',8,sdp));
 echoed.headers.push(['Record-Route','<sip:192.168.50.45:5070;transport=tcp;lr>,<sip:edge.example;lr>']);
 removeLocalRoute(echoed,'192.168.50.45',5070);
 assert.equal(header(echoed,'record-route'),'<sip:edge.example;lr>');
});

test('out-of-dialog REFER waits for a matching handset INVITE and never treats 202 as a call',async()=>{
 const phone=[],provider=[];const s=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:m=>phone.push(structuredClone(m)),toProvider:m=>provider.push(m)});
 const register=request('REGISTER');s.observe('phone',register);s.observe('provider',answer(register));
 const params={number:'1002',intentId:'test-intent',expiresAt:Date.now()+10000};
 const pending=s.control('dial',params);const refer=phone.at(-1);assert.equal(cseq(refer).method,'REFER');assert.equal(header(refer,'refer-to'),'<sip:1002@sip.telnyx.com>');
 s.observe('phone',answer(refer,202));let resolved=false;pending.then(()=>resolved=true);await new Promise(r=>setImmediate(r));assert.equal(resolved,false);
 const invite=request('INVITE',2,sdp);invite.start='INVITE sip:1002@sip.telnyx.com SIP/2.0';s.observe('phone',invite);
 assert.equal((await pending).ok,true);assert.equal(s.snapshot().call[0].Type,'outgoing');assert.equal(provider.at(-1).start,invite.start);
 s.end([...s.dialogs.values()][0]);assert.equal((await s.control('dial',params)).reason,'dial_intent_already_dispatched');s.close();
});
test('handset rejection and socket loss resolve Dial without claiming origination',async()=>{
 for(const rejected of [true,false]){
  const phone=[];const s=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:m=>phone.push(structuredClone(m)),toProvider:()=>{}});
  const register=request('REGISTER');s.observe('phone',register);s.observe('provider',answer(register));
  const pending=s.control('dial',{number:'1002',intentId:'test',expiresAt:Date.now()+10000});
  if(rejected)s.observe('phone',answer(phone.at(-1),403));else s.close();
  const result=await pending;assert.equal(result.ok,false);assert.equal(result.definitive,rejected);assert.equal(s.snapshot().call.length,0);s.close();
 }
});
test('cancel an outgoing early dialog without needing a remote To tag',async()=>{
 const upstream=[];const s=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:()=>{},toProvider:m=>upstream.push(structuredClone(m))});
 const invite=request('INVITE',7,sdp);invite.headers.push(['Via','SIP/2.0/TCP phone;branch=z9hG4bK-original']);s.observe('phone',invite);
 const cancel=s.control('hangup',{callRef:s.snapshot().call[0].Ref});const message=upstream.at(-1);
 assert.equal(cseq(message).method,'CANCEL');assert.equal(cseq(message).number,7);assert.equal(header(message,'via'),header(invite,'via'));
 s.observe('provider',answer(message));s.observe('provider',answer(invite,487));await cancel;assert.equal(s.snapshot().call.length,0);s.close();
});

test('outgoing SIP digest challenge does not terminate the logical handset call',()=>{
 const s=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:()=>{},toProvider:()=>{}});
 const invite=request('INVITE',10,sdp);s.observe('phone',invite);s.observe('provider',answer(invite,407));
 assert.equal(s.snapshot().call[0].CallState,'dialing');
 s.observe('phone',request('ACK',10));const retry=request('INVITE',11,sdp);s.observe('phone',retry);s.observe('provider',answer(retry,200,sdp));
 assert.equal(s.snapshot().call[0].CallState,'connected');s.close();
});

test('HTTP native Dial confirms only the matching outgoing SIP INVITE, without an incoming callback',async()=>{
 let requested=0;const frames=[];
 const s=new SipPhoneSession({phone:{id:'p'},host:'127.0.0.1',port:5070,toPhone:m=>frames.push(m),toProvider:()=>{},originate:async()=>{requested++;return{ok:true};}});
 const register=request('REGISTER');s.observe('phone',register);s.observe('provider',answer(register));frames.length=0;
 const pending=s.control('dial',{number:'1005',intentId:'http-dial',expiresAt:Date.now()+10000});let resolved=false;pending.then(()=>resolved=true);
 await new Promise(r=>setImmediate(r));assert.equal(requested,1);assert.equal(resolved,false);assert.equal(frames.length,0);
 const invite=request('INVITE',2,sdp);invite.start='INVITE sip:1005@sip.telnyx.com SIP/2.0';s.observe('phone',invite);
 assert.equal((await pending).ok,true);assert.equal(s.snapshot().call[0].Type,'outgoing');s.close();
});
