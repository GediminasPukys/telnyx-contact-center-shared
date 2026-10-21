import test from 'node:test';
import assert from 'node:assert/strict';
import {localNetworks,scanAddresses,parseNeighbors,detectVendor,discoverPhones} from '../tools/contact-center-desktop/discovery.mjs';
import {PhoneOnboarding,FACTORY_CREDENTIALS} from '../tools/contact-center-desktop/phone-onboarding.mjs';
import {validateDesktopDevice,desktopMayConfigure} from '../lib/telephony/desktop-enrollment.mjs';
import {buildConfigForPhone} from '../lib/hardphones/config-generators.mjs';
const iface={address:'192.168.7.10',netmask:'255.255.255.248',family:'IPv4',internal:false};
test('discovery only scans directly connected private LANs, excluding VPN and public addresses',()=>{
  const nets=localNetworks({en0:[iface],utun0:[{...iface,address:'10.0.0.1'}],en1:[{...iface,address:'8.8.8.8'}],lo0:[{...iface,internal:true}]});
  assert.equal(nets.length,1);assert.deepEqual(scanAddresses(nets),['192.168.7.9','192.168.7.11','192.168.7.12','192.168.7.13','192.168.7.14']);
});
test('ARP parser accepts macOS shortened octets and Windows neighbors without DNS lookup',()=>{
  assert.deepEqual(parseNeighbors('? (192.168.50.27) at 0:90:8f:00:00:02 on en0'),[{ip:'192.168.50.27',mac:'00908f000002'}]);
  assert.equal(parseNeighbors('  192.168.1.5     00-15-65-00-00-01 dynamic')[0].mac,'001565000001');
  assert.equal(parseNeighbors('? (10.0.0.2) at (incomplete)').length,0);
});
test('discovery performs no authentication and follows no redirect supplied by a LAN device',async()=>{
  const calls=[];
  const result=await discoverPhones({interfaces:{en0:[iface]},readNeighbors:async()=>[],request:async(p,path,opts)=>{
    calls.push({p,path,opts});return {raw:'Polycom VVX',headers:{location:'https://attacker.invalid'},status:302};
  }});
  assert.equal(result.phones.length,5);assert.ok(calls.every(c=>c.path==='/'&&!c.opts.headers&&!c.p.admin_password));
});
test('one documented factory attempt, password fallback, no retry loop',async()=>{
  const attempts=[];const flow=new PhoneOnboarding({authenticate:async(p,password)=>{attempts.push(password);if(password!=='custom')throw Error('auth_failed');return {...p,model:'T22P'};}});
  flow.discovered([{candidateId:'one',mac:'001565000001',vendor:'yealink'}]);
  assert.deepEqual(await flow.login('one'),{needsPassword:true});
  assert.deepEqual(await flow.login('one'),{needsPassword:true});
  assert.equal((await flow.login('one',{password:'custom'})).phone.model,'T22P');
  assert.deepEqual(attempts,['admin','custom']);
  await assert.rejects(flow.login('unknown'),/discover_phone_again/);
});
test('factory success and remembered credentials do not ask for a password',async()=>{
  const attempts=[];const flow=new PhoneOnboarding({authenticate:async(p,password)=>{attempts.push(password);return p;}});
  flow.discovered([{candidateId:'one',vendor:'audiocodes',mac:'00908f000001'}]);
  assert.equal((await flow.login('one')).usedDefault,true);
  assert.equal((await flow.login('one',{remembered:'saved'})).usedDefault,false);
  assert.deepEqual(attempts,['1234','saved']);assert.equal(FACTORY_CREDENTIALS.polycom.username,'Polycom');
});
test('rescanning does not repeat a failed factory password attempt',async()=>{
  let attempts=0;const flow=new PhoneOnboarding({authenticate:async()=>{attempts++;throw Error('auth_failed');}});
  flow.discovered([{candidateId:'first',vendor:'polycom',mac:'0004f2000001'}]);await flow.login('first');
  flow.discovered([{candidateId:'second',vendor:'polycom',mac:'0004f2000001'}]);await flow.login('second');
  assert.equal(attempts,1);
});
test('vendor detection works without an ARP table for both AudioCodes login pages',()=>{
  for(const raw of ['<meta http-equiv=refresh content=0;URL=mainform.cgi?go=mainframe.htm>','<meta content="0;URL=mainform.cgi/index.htm">'])assert.equal(detectVendor({raw,headers:{}}),'audiocodes');
  assert.equal(detectVendor({raw:'',headers:{location:'/servlet?p=login&q=loginForm&jumpto=status'}}),'yealink');
});
test('server refuses invalid identity, another owner and another controller even for administrators',()=>{
  const phone={mac:'00908f000001',vendor:'audiocodes',model:'420HD',ip_address:'192.168.1.20',localHost:'192.168.1.10'};
  assert.doesNotThrow(()=>validateDesktopDevice(phone));
  assert.throws(()=>validateDesktopDevice({...phone,ip_address:'169.254.169.254'}));
  assert.throws(()=>validateDesktopDevice({...phone,model:'unknown'}));
  assert.throws(()=>desktopMayConfigure(phone,{enabled:true,owner_id:'other'},{id:'me'},false),/assign/);
  assert.throws(()=>desktopMayConfigure({...phone,local_bridge_id:'office'},{enabled:true},{id:'me',desktopBridgeId:'home'},true),/another controller/);
});
test('periodic provisioning applies the configured common admin password, including desktop phones',()=>{
  const previous=process.env.TELNYX_PHONE_ADMIN_PASSWORD;process.env.TELNYX_PHONE_ADMIN_PASSWORD='server-wide-secret';
  try {for(const [vendor,model]of [['audiocodes','420HD'],['audiocodes','440HD'],['polycom','VVX 300'],['yealink','T22P']]){
    const cfg=buildConfigForPhone({vendor,model,mac:'00908f000001',admin_password:'phone-secret',settings:{cti_mode:'desktop_bridge',sip_controller_host:'192.168.1.10'}},vendor==='polycom'?'registration':'mac-config');
    assert.ok(cfg.body.includes('server-wide-secret'),model);assert.ok(!cfg.body.includes('phone-secret'),model);
  }}
  finally{if(previous===undefined)delete process.env.TELNYX_PHONE_ADMIN_PASSWORD;else process.env.TELNYX_PHONE_ADMIN_PASSWORD=previous;}
});
test('desktop Polycom uses TCP by default while preserving an explicit transport policy',()=>{
  const phone={vendor:'polycom',model:'VVX 300',mac:'0004f2000001',settings:{cti_mode:'desktop_bridge'}};
  const config=(settings)=>buildConfigForPhone({...phone,settings},'registration').body;
  assert.match(config(phone.settings),/reg\.1\.server\.1\.transport="TCPOnly"/);
  assert.match(config({...phone.settings,transport:'tls'}),/reg\.1\.server\.1\.transport="TLS"/);
  assert.match(config({...phone.settings,transport:'udp'}),/reg\.1\.server\.1\.transport="UDPOnly"/);
  assert.match(config({}),/reg\.1\.server\.1\.transport="UDPOnly"/);
});
test('reset enrolled phone falls back once to documented factory password after auth rejection',async()=>{
  const attempts=[];const flow=new PhoneOnboarding({authenticate:async(p,password)=>{attempts.push(password);if(password!=='1234')throw Error('auth_failed');return p;}});
  flow.discovered([{candidateId:'reset',vendor:'audiocodes',mac:'00908f000002'}]);
  assert.equal((await flow.login('reset',{remembered:'managed'})).usedDefault,true);
  assert.deepEqual(attempts,['managed','1234']);
});
test('network and identity errors never trigger a factory-password retry',async()=>{
  for(const error of ['request_timeout','device_mac_mismatch','certificate_changed']){
    let attempts=0;const flow=new PhoneOnboarding({authenticate:async()=>{attempts++;throw Error(error);}});
    flow.discovered([{candidateId:'x',vendor:'audiocodes'}]);
    await assert.rejects(flow.login('x',{remembered:'managed'}),new RegExp(error));assert.equal(attempts,1);
  }
});
