import net from 'node:net';
import { nativeDialTarget } from '../../lib/hardphones/native-dial-target.mjs';

export const ACTIONS = new Set(['status','dial','answer','hold','resume','mute','unmute','hangup','send_dtmf']);
export function validateConfig(config) {
  const app=new URL(config.appUrl), relay=new URL(config.relayUrl);
  const loopback=url=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(app.protocol!=='https:'&&!(app.protocol==='http:'&&loopback(app)))throw Error('app_requires_https');
  if(relay.protocol!=='wss:'&&!(relay.protocol==='ws:'&&loopback(relay)))throw Error('bridge_requires_wss');
  if(app.username||app.password||relay.username||relay.password||relay.search)throw Error('credentials_in_url');
  if(!net.isIPv4(config.sipHost)||!Number.isInteger(config.sipPort)||config.sipPort<1024||config.sipPort>65535)throw Error('invalid_sip_listener');
  if(!config.bridgeId||typeof config.bridgeToken!=='string'||config.bridgeToken.length<32)throw Error('bridge_credentials_required');
  if(!Array.isArray(config.allowedPhoneIds)||!config.allowedPhoneIds.length)throw Error('explicit_phone_allowlist_required');
  if(config.nativePhones){
    if(!Array.isArray(config.nativePhones))throw Error('invalid_native_phones');
    if(!Number.isInteger(config.eventPort)||config.eventPort<1024||config.eventPort>65535||config.eventPort===config.sipPort)throw Error('invalid_event_listener');
    for(const p of config.nativePhones){
      if(!config.allowedPhoneIds.includes(p.id)||!['polycom','yealink','audiocodes'].includes(p.vendor)||!net.isIPv4(p.ip_address)||!p.admin_password||!/^[a-f0-9]{12}$/.test(p.mac))throw Error('invalid_native_phone');
      if(['polycom','audiocodes'].includes(p.vendor)&&!/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(p.certificate_fingerprint||''))throw Error('phone_certificate_required');
      if(p.vendor==='audiocodes'&&(!['420HD','440HD'].includes(p.model)||p.settings?.management_protocol==='http'))throw Error('unsupported_audiocodes_transport');
      if(p.vendor==='yealink'&&(p.model!=='T22P'||!/^\w{32,128}$/.test(p.event_token||'')||p.settings?.management_protocol!=='http'))throw Error('unsupported_yealink_transport');
    }
  }
  return config;
}
export function registryPhones(rows,allowed,nativePhones=[]) {
  return rows.filter(p=>allowed.includes(p.phone_id)&&p.cti_mode==='desktop_bridge'&&net.isIPv4(p.ip)
    &&/^[a-zA-Z0-9_.-]+$/.test(p.sip_username||''))
    .flatMap(p=>{
      const base={id:p.phone_id,vendor:p.vendor,mac:p.mac,model:p.model,ip_address:p.ip,sip_username:p.sip_username,extension:p.extension};
      const local=nativePhones.find(n=>n.id===p.phone_id&&n.ip_address===p.ip&&n.vendor===p.vendor&&n.model===p.model&&n.mac===p.mac);
      return local?[{...local,...base}]:p.vendor==='audiocodes'&&['420HD','440HD'].includes(p.model)?[base]:[];
    });
}
export function validateCommand(command,phones) {
  const phone=phones.find(p=>p.id===command.phone_id);
  if(!phone||command.host!==phone.ip_address||command.vendor!==phone.vendor)throw Error('phone_not_authorized');
  if(!ACTIONS.has(command.action))throw Error('unsupported_desktop_action');
  const payload=command.payload||{};
  if(command.action==='dial'){
    nativeDialTarget(payload.number);
    if(!/^[0-9a-f-]{36}$/i.test(payload.intentId||'') || !Number.isFinite(payload.expiresAt) || payload.expiresAt<Date.now() || payload.expiresAt>Date.now()+60000)throw Error('invalid_dial_intent');
  } else if(command.action!=='status'&&!/^[a-zA-Z0-9:_-]{1,128}$/.test(payload.callRef||''))throw Error('call_reference_required');
  if(command.action==='send_dtmf'&&!/^[0-9*#A-D]{1,32}$/.test(payload.digits||''))throw Error('invalid_dtmf');
  return {phoneId:phone.id,action:command.action,callRef:payload.callRef,digits:payload.digits, ...(command.action==='dial'?{number:payload.number,intentId:payload.intentId,expiresAt:payload.expiresAt}:{})};
}
