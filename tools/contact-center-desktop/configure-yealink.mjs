// Explicit administrator setup for the certified T22P firmware. Changes only
// Action URI source restriction and callback URLs; SIP registration is untouched.
import fs from 'node:fs';
import { validateConfig } from './policy.mjs';
import { inspectYealink,yealinkProvisioningForm } from '../../lib/hardphones/yealink-provisioning.mjs';
const [mode,configPath,backupPath]=process.argv.slice(2);
if(!['configure','restore'].includes(mode)||!configPath||!backupPath)throw Error('Usage: node configure-yealink.mjs configure|restore private-config.json private-backup.json');
if(process.platform!=='win32'&&(fs.statSync(configPath).mode&0o077))throw Error('Private configuration must have mode 0600');
const config=validateConfig(JSON.parse(fs.readFileSync(configPath)));
const fields={AUIncomingCall:'incoming',AUCallOut:'outgoing',AUEstablished:'connected',AUTerminated:'ended',AUMissedCall:'ended',AURejectIncomingCall:'ended',AUHold:'held',AUUnHold:'resumed',AUMute:'muted',AUUnMute:'unmuted'};
const backup=mode==='restore'?JSON.parse(fs.readFileSync(backupPath)):{};
if(mode==='configure'&&fs.existsSync(backupPath))throw Error('Backup already exists; do not overwrite the restore point');
for(const phone of config.nativePhones.filter(p=>p.vendor==='yealink')){
 const inspected=await inspectYealink(phone,null);const session=inspected.session;
 const forms={};for(const name of ['remotecontrl','actionurl'])forms[name]=yealinkProvisioningForm((await session.send(`/servlet?p=features-${name}&q=load`)).raw);
 if(mode==='configure'){
  backup[phone.id]={AURILimitIP:forms.remotecontrl.get('AURILimitIP'),...Object.fromEntries(Object.keys(fields).map(k=>[k,forms.actionurl.get(k)]))};
  fs.writeFileSync(backupPath,JSON.stringify(backup,null,2),{mode:0o600});
 }
 if(!backup[phone.id])throw Error('Missing phone backup');
 forms.remotecontrl.set('AURILimitIP',mode==='configure'?config.sipHost:backup[phone.id].AURILimitIP||'');
 for(const[key,event]of Object.entries(fields))forms.actionurl.set(key,mode==='restore'?backup[phone.id][key]||'':`http://${config.sipHost}:${config.eventPort}/phone-events/${phone.id}?token=${phone.event_token}&event=${event}&id=$call_id&remote=$remote&local=$local`);
 for(const[name,form]of Object.entries(forms)){
  await session.send(`/servlet?p=features-${name}&q=write`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form.toString(),expectedRedirect:`/servlet?p=features-${name}&q=load`});
  const readback=yealinkProvisioningForm((await session.send(`/servlet?p=features-${name}&q=load`)).raw);
  for(const key of name==='remotecontrl'?['AURILimitIP']:Object.keys(fields))if(readback.get(key)!==form.get(key))throw Error('Device configuration readback mismatch');
 }
 console.log({model:phone.model,operation:mode,verified:true});
}
