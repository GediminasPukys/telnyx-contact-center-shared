import test from 'node:test';
import assert from 'node:assert/strict';
import { activatePhoneSetup, isAudioCodesFactoryAccount } from '../tools/contact-center-desktop/configure-phone.mjs';
const plan={kind:'audio',phone:{},desiredPassword:'test'};
test('reset 420HD placeholder account is recognized without accepting an existing SIP account',()=>{
  const phone={model:'420HD',admin_password:'1234'};
  const config={'voip/line/0/id':'0','voip/line/0/auth_name':'0','voip/line/1/id':'0','voip/line/1/auth_name':'0','provisioning/configuration/url':'','voip/signalling/sip/proxy_address':'0.0.0.0','voip/signalling/sip/sip_outbound_proxy/addr':'0.0.0.0'};
  assert.equal(isAudioCodesFactoryAccount(phone,config,false),true);
  assert.equal(isAudioCodesFactoryAccount(phone,config,true),false);
  assert.equal(isAudioCodesFactoryAccount({...phone,admin_password:'custom'},config,false),false);
  for(const [key,value]of Object.entries({'voip/line/1/id':'100','provisioning/configuration/url':'https://other.example/config','voip/signalling/sip/proxy_address':'sip.other.example','voip/signalling/sip/sip_outbound_proxy/addr':'192.168.1.1'}))assert.equal(isAudioCodesFactoryAccount(phone,{...config,[key]:value},false),false,key);
});
test('activation retries transient restart disconnect and requires two registered reads',async()=>{
  let reads=0,time=0;const phases=[],posts=[];
  const result=await activatePhoneSetup(plan,{onProgress:p=>phases.push(p),now:()=>time,sleep:async ms=>{time+=ms;},inspect:async()=>{
    reads++;
    if(reads===1)return {idle:true,session:{send:async(path,options)=>{
      if(options?.method==='POST'){posts.push(options.body);throw Error('ECONNRESET');}
      return {raw:'<form name="rebootform"><input name="REBOOT" value="0"></form><script>action="../mainform.cgi/reboot.htm"</script>'};
    }}};
    if(reads===2)throw Error('ECONNREFUSED');
    return {registered:reads>=4};
  }});
  assert.equal(result.registered,true);assert.equal(reads,5);assert.deepEqual(posts,['REBOOT=2']);assert.ok(phases.includes('waiting_for_phone'));
});
test('verification-only never sends reboot and reports a bounded pending result',async()=>{
  let time=0;await assert.rejects(activatePhoneSetup(plan,{verifyOnly:true,timeoutMs:8000,now:()=>time,sleep:async ms=>{time+=ms;},inspect:async()=>({registered:false})}),/activation_pending/);
  assert.ok(time>=8000&&time<=11000);
});
test('activation immediately surfaces an admin password or identity mismatch',async()=>{
  await assert.rejects(activatePhoneSetup(plan,{verifyOnly:true,inspect:async()=>{throw Error('auth_failed');}}),/auth_failed/);
});
test('transient web-stack failure after import is retried before a single reboot POST',async()=>{
  let reads=0,time=0,posts=0;
  await activatePhoneSetup(plan,{now:()=>time,sleep:async ms=>{time+=ms;},inspect:async()=>{
    if(++reads===1)throw Error('socket hang up');
    return {idle:true,registered:true,session:{send:async(path,opts)=>{
      if(opts?.method==='POST'){posts++;return {};}
      return {raw:'<form name="rebootform"><input name="REBOOT" value="0"></form><script>action="../mainform.cgi/reboot.htm"</script>'};
    }}};
  }});
  assert.equal(posts,1);assert.equal(reads,4);
});
