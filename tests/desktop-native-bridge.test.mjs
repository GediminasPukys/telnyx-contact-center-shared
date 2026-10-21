import test from 'node:test';import assert from 'node:assert/strict';
import {YealinkObservation,startNativeController} from '../tools/contact-center-desktop/native-controller.mjs';
import {validateConfig,registryPhones,validateCommand} from '../tools/contact-center-desktop/policy.mjs';
import {nativePhoneState} from '../lib/telephony/native-phone-state.mjs';

test('Yealink events track real call identity and do not resurrect terminated calls',()=>{
 const o=new YealinkObservation();assert.equal(nativePhoneState(o.snapshot()).status,'unknown');
 assert.equal(o.event('connected','2'),false);assert.equal(o.event('incoming','2','peer'),true);
 assert.equal(nativePhoneState(o.snapshot()).status,'ringing');o.event('connected','2');
 assert.equal(o.snapshot().call[0].Muted,null);o.event('muted','2');assert.equal(o.snapshot().call[0].Muted,true);
 o.event('held','2');assert.equal(nativePhoneState(o.snapshot()).status,'held');o.event('resumed','2');o.event('unmuted','2');
 assert.equal(nativePhoneState(o.snapshot()).status,'active');assert.equal(o.snapshot().call[0].Muted,false);
 o.event('incoming','3');assert.equal(nativePhoneState(o.snapshot()).status,'unknown');
 o.event('ended','2');o.event('ended','3');assert.equal(nativePhoneState(o.snapshot()).status,'idle');
 assert.equal(o.event('connected','2'),false);assert.equal(o.event('incoming','2'),false);assert.equal(o.event('incoming','bad/id'),false);
});
test('native registry binds private credentials to the exact locally allowed identity',()=>{
 const local={id:'p',vendor:'polycom',model:'VVX 300',mac:'0004f2000001',ip_address:'127.0.0.1',admin_password:'test-only',certificate_fingerprint:Array(32).fill('AB').join(':')};
 const row={phone_id:'p',vendor:local.vendor,model:local.model,mac:local.mac,ip:local.ip_address,sip_username:'phone1',cti_mode:'desktop_bridge'};
 const phones=registryPhones([row],['p'],[local]);assert.equal(phones.length,1);
 for(const patch of [{ip:'127.0.0.2'},{vendor:'yealink'},{mac:'001565000001'},{model:'other'}])assert.equal(registryPhones([{...row,...patch}],['p'],[local]).length,0);
 assert.equal(registryPhones([row],['p']).length,0);
 assert.throws(()=>validateCommand({phone_id:'p',host:'127.0.0.1',vendor:'yealink',action:'status'},phones),/authorized/);
 const cfg={appUrl:'http://localhost:3130',relayUrl:'ws://127.0.0.1:3131',bridgeId:'test',bridgeToken:'a'.repeat(64),sipHost:'127.0.0.1',sipPort:5070,eventPort:5071,allowedPhoneIds:['p'],nativePhones:[local]};
 assert.doesNotThrow(()=>validateConfig(cfg));assert.throws(()=>validateConfig({...cfg,nativePhones:[{...local,certificate_fingerprint:null}]}),/certificate/);
});
test('native dispatcher rejects stale references and strips device secrets from status',async()=>{
 const phone={id:'p',vendor:'polycom',ip_address:'127.0.0.1',admin_password:'secret'};let actions=0;
 const controller=await startNativeController({getPhones:async()=>[phone],host:'127.0.0.1',port:0,drivers:{polycom:{status:async()=>({ok:true,reachable:true,admin_password:'secret',call:[{Ref:'42',CallState:'active'}],line:{RegistrationStatus:'registered'}}),hold:async()=>{actions++;return {ok:true};}}}});
 try{await controller.refresh();assert.equal((await controller.command({phoneId:'p',action:'hold',callRef:'old'})).ok,false);assert.equal(actions,0);
 assert.equal((await controller.command({phoneId:'p',action:'hold',callRef:'42'})).ok,true);assert.equal(actions,1);assert.equal(nativePhoneState(controller.snapshot('p')).status,'active');
 assert.equal((await controller.command({phoneId:'p',action:'status'})).admin_password,undefined);
 }finally{await controller.stop();}
});
test('Yealink callback rejects unknown tokens and confirms mutations from hardware events',async()=>{
 const phone={id:'y',vendor:'yealink',ip_address:'127.0.0.1',event_token:'a'.repeat(64)};let url;
 const driver={status:async()=>({ok:true,registration:'registered',callStateKnown:false}),answer:async()=>{await fetch(url+'&event=connected&id=4');return {ok:true};}};
 const c=await startNativeController({getPhones:async()=>[phone],host:'127.0.0.1',port:0,drivers:{yealink:driver}});
 url=`http://127.0.0.1:${c.eventPort}/phone-events/y?token=${phone.event_token}`;
 try{assert.equal((await fetch(url.replace(phone.event_token,'b'.repeat(64))+'&event=incoming&id=4')).status,404);
 assert.equal((await fetch(url+'&event=incoming&id=4')).status,200);
 assert.equal((await c.command({phoneId:'y',action:'answer',callRef:'4'})).ok,true);
 assert.equal(nativePhoneState(c.snapshot('y')).status,'active');
 }finally{await c.stop();}
});
test('backend routes all three desktop vendors through the authenticated bridge',async()=>{
 const{resolveCtiDriver}=await import('../lib/hardphones/cti.mjs');
 for(const vendor of ['polycom','yealink','audiocodes'])assert.equal(resolveCtiDriver({vendor,settings:{cti_mode:'desktop_bridge'}}).vendor,'local-bridge');
 assert.equal(nativePhoneState({call:[],callStateKnown:false}).status,'unknown');
});
test('lost Yealink mute confirmation blocks a second toggle instead of assuming success',async()=>{
 const phone={id:'y',vendor:'yealink',ip_address:'127.0.0.1',event_token:'a'.repeat(64)};let toggles=0;
 const c=await startNativeController({getPhones:async()=>[phone],host:'127.0.0.1',port:0,confirmationTimeoutMs:100,
 drivers:{yealink:{status:async()=>({ok:true,registration:'registered'}),mute:async()=>{toggles++;return {ok:true};}}}});
 const url=`http://127.0.0.1:${c.eventPort}/phone-events/y?token=${phone.event_token}`;
 try{await fetch(url+'&event=incoming&id=4');await fetch(url+'&event=connected&id=4');
 assert.equal((await c.command({phoneId:'y',action:'mute',callRef:'4'})).reason,'device_confirmation_timeout');
 assert.equal(nativePhoneState(c.snapshot('y')).status,'unknown');
 assert.equal((await c.command({phoneId:'y',action:'mute',callRef:'4'})).ok,false);assert.equal(toggles,1);
 }finally{await c.stop();}
});

test('native Dial rejects an unknown or busy handset and expired intent before any physical command',async()=>{
 let state='active',dialed=0;const phone={id:'p',vendor:'polycom'};
 const c=await startNativeController({getPhones:async()=>[phone],host:'127.0.0.1',port:0,drivers:{polycom:{status:async()=>({ok:true,call:state==='idle'?[]:[{Ref:'42',CallState:state}]}),dial:async()=>{dialed++;return{ok:true};}}}});
 const dial={phoneId:'p',action:'dial',number:'1002',intentId:'intent',expiresAt:Date.now()+10000};
 try{
  assert.equal((await c.command(dial)).definitive,true);assert.equal(dialed,0);state='idle';
  assert.equal((await c.command({...dial,expiresAt:0})).reason,'dial_intent_expired');assert.equal(dialed,0);
  assert.equal((await c.command(dial)).ok,true);assert.equal(dialed,1);
 }finally{await c.stop();}
});

test('native status reports allowlisted network diagnostics without driver secrets',async()=>{
 let error='connect EHOSTUNREACH private-host:443 token=secret';
 const phone={id:'p',vendor:'polycom'};
 const c=await startNativeController({getPhones:async()=>[phone],host:'127.0.0.1',port:0,
  drivers:{polycom:{status:async()=>({ok:false,reachable:false,reason:'phone_unreachable',error})}}});
 try{
  const first=await c.command({phoneId:'p',action:'status'});
  assert.equal(first.networkError,'EHOSTUNREACH');assert.equal(JSON.stringify(first).includes('secret'),false);
  error='Authorization: Bearer secret';
  assert.equal((await c.command({phoneId:'p',action:'status'})).networkError,undefined);
 }finally{await c.stop();}
});
