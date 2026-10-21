import { randomBytes } from 'node:crypto';
import { polycomDriver } from '../../lib/hardphones/drivers/polycom.mjs';
import { inspectAudioCodes, parseAudioCodesConfiguration } from '../../lib/hardphones/audiocodes-provisioning.mjs';
import { inspectYealink, yealinkProvisioningForm, encryptYealinkFields } from '../../lib/hardphones/yealink-provisioning.mjs';
import { readDeviceForm, decodeDeviceHtml } from '../../lib/hardphones/device-web.mjs';
import { FACTORY_CREDENTIALS } from './phone-onboarding.mjs';

const events={AUIncomingCall:'incoming',AUCallOut:'outgoing',AUEstablished:'connected',AUTerminated:'ended',AUMissedCall:'ended',AURejectIncomingCall:'ended',AUHold:'held',AUUnHold:'resumed',AUMute:'muted',AUUnMute:'unmuted'};
const cfgValues=text=>Object.fromEntries(text.split(/\r?\n/).flatMap(line=>{const m=line.match(/^([^#=]+?)\s*=\s*(.*)$/);return m?[[m[1].trim(),m[2]]]:[];}));
export function isAudioCodesFactoryAccount(phone, config, registered) {
  // A reset 420HD has an enabled placeholder account "0", not an empty ID.
  // Only accept the complete observed factory state; a real account called 0
  // or a phone with another provisioning server must still require migration.
  return phone.model==='420HD' && phone.admin_password===FACTORY_CREDENTIALS.audiocodes.password
    && registered===false && config['voip/line/0/id']==='0'
    && config['voip/line/0/auth_name']==='0'
    && config['provisioning/configuration/url']===''
    && ['voip/signalling/sip/proxy_address','voip/signalling/sip/sip_outbound_proxy/addr'].every(k=>config[k]==='0.0.0.0')
    && Object.entries(config).filter(([k])=>/^voip\/line\/\d+\/(id|auth_name)$/.test(k)).every(([,v])=>v===''||v==='0');
}
async function polyRead(phone,keys){
  // device.*.set are write-only switches, not readable configuration values.
  keys=keys.filter(k=>!k.endsWith('.set'));
  const values={};for(let i=0;i<keys.length;i+=6){const read=await polycomDriver.getConfig(phone,keys.slice(i,i+6));if(!read.ok)throw Error(read.reason);Object.assign(values,read.data.data);}return values;
}
async function polyWrite(phone,values){
  const entries=Object.entries(values);for(let i=0;i<entries.length;i+=6){const result=await polycomDriver.setConfig(phone,{'device.set':'1',...Object.fromEntries(entries.slice(i,i+6))});if(!result.ok)throw Error(result.reason);}
}
async function audioUpload(session,model,text) {
  const upload=new FormData();upload.set('TYPE','6');upload.set('upname',new Blob([text],{type:'text/plain'}),'desktop-setup.cfg');
  const req=new Request('http://localhost',{method:'POST',body:upload});
  const response=await session.send(model==='420HD'?'/mainform.cgi/auto_config.htm':'/mainform.cgi/Auto_Config.htm',
    {method:'POST',headers:{'Content-Type':req.headers.get('content-type')},body:Buffer.from(await req.arrayBuffer())});
  const confirm=readDeviceForm(response.raw,'confirmform');if(!confirm.has('upmode'))throw Error('unsupported_device_form');
  confirm.set('upmode','1');
  await session.send(model==='420HD'?'/mainform.cgi/manu_config.htm':'/mainform.cgi/Manu_Config.htm',
    {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:confirm.toString()});
}

// The caller MUST persist the returned backup with OS encryption before apply.
// Plans contain secrets and must never cross the remote-renderer preload.
export async function planPhoneSetup(phone,prepared,{sipHost,eventPort=5071}={}) {
  phone={...phone,...prepared.phone,ip_address:phone.ip_address};
  const desiredPassword=prepared.managedAdminPassword;
  if(!desiredPassword)throw Error('Managed administrator password is missing');
  if(phone.vendor==='audiocodes') {
    const inspected=await inspectAudioCodes(phone,{certificate_fingerprint:phone.certificate_fingerprint});
    if(!inspected.idle)throw Error('phone_has_active_call');
    const previous=parseAudioCodesConfiguration((await inspected.session.send('/mainform.cgi/manu_config.htm')).raw);
    const values=cfgValues(prepared.config);
    if(previous['voip/line/0/id']&&previous['voip/line/0/id']!==phone.sip_username&&!isAudioCodesFactoryAccount(phone,previous,inspected.registered))throw Error('The phone has another SIP account. Ask an administrator to migrate it first.');
    values['system/password']=desiredPassword;
    // Device exports redact authentication fields. For a matching CC account,
    // recover its current credentials from the authoritative server plan.
    const backup=Object.fromEntries(Object.keys(values).map(k=>[k,previous[k]??'']));
    if(previous['voip/line/0/id']===phone.sip_username){backup['voip/line/0/auth_name']=phone.sip_username;backup['voip/line/0/auth_password']=values['voip/line/0/auth_password'];}
    backup['system/password']=phone.admin_password;
    return {phone,kind:'audio',values,backup,desiredPassword};
  }
  if(phone.vendor==='polycom') {
    const status=await polycomDriver.status(phone);
    if(!status.ok || !Array.isArray(status.call)||status.call.length)throw Error('phone_has_active_call');
    const values={...prepared.bootstrap,...Object.fromEntries([...prepared.config.matchAll(/([\w.]+)="([^"]*)"/g)]
      .filter(m=>/^(reg\.|apps\.restapi|voIpProt\.)/.test(m[1])).map(m=>[m[1],decodeDeviceHtml(m[2])]))};
    const old=await polyRead(phone,Object.keys(values));
    const backup={...Object.fromEntries(Object.keys(values).filter(k=>k.endsWith('.set')).map(k=>[k,'1'])),...Object.fromEntries(Object.entries(old).map(([k,v])=>[k,String(v.Value ?? '')]))};
    if(backup['reg.1.auth.userId']&&backup['reg.1.auth.userId']!==phone.sip_username)throw Error('The phone has another SIP account. Ask an administrator to migrate it first.');
    if(backup['reg.1.auth.userId']===phone.sip_username)backup['reg.1.auth.password']=values['reg.1.auth.password'];
    if(backup['device.prov.serverName']&&backup['device.prov.serverName']!==values['device.prov.serverName'])throw Error('The phone uses another provisioning server. Ask an administrator to migrate it first.');
    if(backup['device.prov.user']===values['device.prov.user'])backup['device.prov.password']=values['device.prov.password'];
    return {phone,kind:'poly',values,backup,desiredPassword};
  }
  if(phone.vendor==='yealink') {
    const status=await inspectYealink(phone,null);
    const {session}=status;
    const forms={};
    for(const name of ['remotecontrl','actionurl'])forms[name]=Object.fromEntries(yealinkProvisioningForm((await session.send(`/servlet?p=features-${name}&q=load`)).raw));
    // This legacy firmware cannot establish idle from a read-only API. Changes
    // to callback URLs are safe; SIP reconfiguration requires an unused account.
    const accountPage=await session.send('/servlet?p=account-register&q=load&acc=0');
    const account=Object.fromEntries(yealinkProvisioningForm(accountPage.raw));
    const config=cfgValues(prepared.config);
    const alreadyConfigured=account.AccountUserName===prepared.phone.sip_username && account.AccountRegisterName===prepared.phone.sip_username && status.registered;
    if(!alreadyConfigured&&!status.allAccountsDisabled)throw Error('device_idle_state_unavailable');
    const token=phone.event_token || randomBytes(32).toString('hex');phone.event_token=token;
    const values={remotecontrl:{...forms.remotecontrl,AURILimitIP:sipHost},actionurl:{...forms.actionurl}};
    for(const [key,event]of Object.entries(events))values.actionurl[key]=`http://${sipHost}:${eventPort}/phone-events/${phone.id}?token=${token}&event=${event}&id=$call_id&remote=$remote&local=$local`;
    return {phone,kind:'yealink',values,backup:forms,...(!alreadyConfigured?{account:{...account,AccountEnable:'1',AccountLabel:config['account.1.label'],AccountUserName:prepared.phone.sip_username,AccountRegisterName:prepared.phone.sip_username,AccountPassword:config['account.1.password'],server1:'sip.telnyx.com'},accountBackup:account}:{}),
      legacy:true,desiredPassword};
  }
  throw Error('unsupported_device_vendor');
}
export async function applyPhoneSetup(plan,{restore=false,onProgress=()=>{}}={}) {
  let phone={...plan.phone};const values=restore?plan.backup:plan.values;
  const targetPassword=restore?plan.phone.admin_password:plan.desiredPassword;
  if(restore)phone.admin_password=plan.desiredPassword;
  if(plan.kind==='poly') {
    let status=await polycomDriver.status(phone);
    if(restore&&status.reason==='auth_failed'){phone.admin_password=plan.phone.admin_password;status=await polycomDriver.status(phone);}
    if(!status.ok||!Array.isArray(status.call)||status.call.length)throw Error('phone_has_active_call');
    await polyWrite(phone,values);
    const read=await polyRead(phone,Object.keys(values));
    // UCS intentionally redacts passwords from config/get. Verify public
    // settings and authenticate with the managed password independently.
    if(Object.entries(values).filter(([k])=>!k.endsWith('.set')&&!/password/i.test(k)).some(([k,v])=>String(read[k]?.Value ?? '')!==String(v)))throw Error('device_readback_mismatch');
    if(phone.admin_password!==targetPassword){const changed=await polycomDriver.setConfig(phone,{'device.set':'1','device.auth.localAdminPassword.set':'1','device.auth.localAdminPassword':targetPassword});if(!changed.ok)throw Error(changed.reason);}
    const verified=await polycomDriver.deviceInfo({...phone,admin_password:targetPassword});if(!verified.ok)throw Error('administrator_password_verification_failed');
    return {verified:true};
  }
  if(plan.kind==='audio') {
    let inspected;
    try{inspected=await inspectAudioCodes(phone,{certificate_fingerprint:phone.certificate_fingerprint});}
    catch(e){if(!restore||e.message!=='auth_failed')throw e;phone.admin_password=plan.phone.admin_password;inspected=await inspectAudioCodes(phone,{certificate_fingerprint:phone.certificate_fingerprint});}
    if(!inspected.idle)throw Error('phone_has_active_call');
    const text=Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n';
    await audioUpload(inspected.session,phone.model,text);
    phone.admin_password=targetPassword;
    onProgress("checking_settings");
    // Applying can restart networking. Read back with a bounded recovery window.
    const readbackDeadline=Date.now()+120000;
    for(let attempt=0;attempt<12&&Date.now()<readbackDeadline;attempt++) {
      try {const fresh=await inspectAudioCodes(phone,{certificate_fingerprint:phone.certificate_fingerprint});
        const current=parseAudioCodesConfiguration((await fresh.session.send('/mainform.cgi/manu_config.htm')).raw);
        const keys=['voip/line/0/id','voip/line/0/description','voip/signalling/sip/sip_outbound_proxy/addr','voip/signalling/sip/sip_outbound_proxy/port'];
        if(keys.every(k=>!Object.hasOwn(values,k)||current[k]===values[k]))return {verified:true,registered:fresh.registered};
      }catch{ /* Phone may be restarting its network stack. */ }
      await new Promise(r=>setTimeout(r,1500));
    }
    throw Error('device_readback_mismatch');
  }
  if(plan.kind==='yealink') {
    let inspected;
    try{inspected=await inspectYealink(phone,null);}catch(e){if(!restore||e.message!=='auth_failed')throw e;phone.admin_password=plan.phone.admin_password;inspected=await inspectYealink(phone,null);}
    const {session}=inspected;
    for(const [name,fields]of Object.entries(values)) {
      const page=await session.send(`/servlet?p=features-${name}&q=load`);
      const fresh=yealinkProvisioningForm(page.raw);
      for(const key of name==='remotecontrl'?['AURILimitIP']:Object.keys(events))fresh.set(key,fields[key]||'');
      await session.send(`/servlet?p=features-${name}&q=write`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:fresh.toString(),expectedRedirect:`/servlet?p=features-${name}&q=load`});
      const read=yealinkProvisioningForm((await session.send(`/servlet?p=features-${name}&q=load`)).raw);
      for(const key of name==='remotecontrl'?['AURILimitIP']:Object.keys(events))if(read.get(key)!==fresh.get(key))throw Error('device_readback_mismatch');
    }
    if(plan.account) {
      const fields=restore?plan.accountBackup:plan.account;
      const page=await session.send('/servlet?p=account-register&q=load&acc=0');
      const form=yealinkProvisioningForm(page.raw);for(const key of ['AccountEnable','AccountLabel','AccountUserName','AccountRegisterName','AccountPassword','server1'])form.set(key,fields[key]||'');
      const n=page.raw.match(/var g_rsa_n = "([a-f0-9]+)"/i)?.[1],e=page.raw.match(/var g_rsa_e = "([a-f0-9]+)"/i)?.[1];
      const secret=form.get('AccountPassword');form.set('AccountPassword','');
      for(const [k,v]of Object.entries(encryptYealinkFields(n,e,`rand=${Math.random()};AccountPassword=${secret};sessionid=${session.id};`)))form.set(k,v);
      await session.send('/servlet?p=account-register&q=write&acc=0',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString(),expectedRedirect:'/servlet?p=account-register&q=load&acc=0'});
      const check=yealinkProvisioningForm((await session.send('/servlet?p=account-register&q=load&acc=0')).raw);
      if(check.get('AccountUserName')!==fields.AccountUserName)throw Error('device_readback_mismatch');
    }
    if(phone.admin_password!==targetPassword){
      const page=await session.send('/servlet?p=security&q=load');
      const form=yealinkProvisioningForm(page.raw);form.set('mode','admin');
      for(const key of ['editOldPassword','editNewPassword','editConfirmPassword'])form.set(key,'');
      const n=page.raw.match(/var g_rsa_n = "([a-f0-9]+)"/i)?.[1],e=page.raw.match(/var g_rsa_e = "([a-f0-9]+)"/i)?.[1];
      for(const [k,v]of Object.entries(encryptYealinkFields(n,e,`rand=${Math.random()};editOldPassword=${phone.admin_password};editNewPassword=${targetPassword};sessionid=${session.id};`)))form.set(k,v);
      await session.send('/servlet?p=security&q=write',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString(),expectedRedirect:'/servlet?p=security&q=load'});
    }
    await session.send('/servlet?p=login&q=logout',{expectedRedirect:'/servlet?p=login&q=loginForm'}).catch(()=>{});
    await inspectYealink({...phone,admin_password:targetPassword},null);
    return {verified:true,legacy:true,notice:'T22P uses legacy local HTTP management. Confirm Allow remote control on the phone if prompted.'};
  }
  throw Error('unsupported_device_vendor');
}

// AudioCodes imports persist SIP settings before applying them to the running
// stack. Activate only after CC enrollment and the desktop listener are ready.
export async function activatePhoneSetup(plan,{verifyOnly=false,onProgress=()=>{},inspect=inspectAudioCodes,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,timeoutMs=240000}={}) {
  if(plan.kind!=='audio')return {verified:true};
  const phone={...plan.phone,admin_password:plan.desiredPassword};
  if(!verifyOnly) {
    // Imports can briefly restart the web stack after a successful readback.
    // Retry only reads here; never replay a reboot POST with an unknown outcome.
    const readyDeadline=now()+90000;let inspected,page;
    while(!page) {
      onProgress('preparing_restart');
      try {
        inspected=await inspect(phone,{certificate_fingerprint:phone.certificate_fingerprint});
        if(inspected.lines && (!inspected.lines.length || inspected.lines.some(line=>!line.state)))throw Error('device_not_ready');
        if(!inspected.idle)throw Error('phone_has_active_call');
        page=await inspected.session.send('/mainform.cgi/reboot.htm');
      } catch(error) {
        if(!['ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ETIMEDOUT','request_timeout','socket hang up','device_not_ready'].includes(error.code||error.message)||now()>=readyDeadline)throw error;
        onProgress('waiting_for_phone');await sleep(3000);
      }
    }
    const form=readDeviceForm(page.raw,'rebootform');
    if(!form.has('REBOOT')||!page.raw.match(/action="\.\.\/mainform\.cgi\/reboot\.htm"/i))throw Error('unsupported_device_form');
    form.set('REBOOT','2');onProgress('restarting');
    try {await inspected.session.send('/mainform.cgi/reboot.htm',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});}
    catch(error){if(!['ECONNRESET','ECONNREFUSED','request_timeout','socket hang up'].includes(error.code||error.message))throw error;}
    // A reboot may close the HTTP socket before returning its response.
    await sleep(10000);
  }
  const deadline=now()+timeoutMs;let stable=0,lastReason='sip_registration_pending';
  while(now()<deadline){
    try{const fresh=await inspect(phone,{certificate_fingerprint:phone.certificate_fingerprint});
      onProgress('registering');stable=fresh.registered?stable+1:0;
      if(stable>=2)return {verified:true,registered:true};
      lastReason='sip_registration_pending';
    }catch(error){
      stable=0;lastReason=error.code||error.message;
      if(['auth_failed','device_mac_mismatch','certificate_changed','unsupported_device_model'].includes(lastReason))throw error;
      onProgress('waiting_for_phone');
    }
    await sleep(3000);
  }
  const error=Error('activation_pending');error.causeCode=lastReason;throw error;
}
