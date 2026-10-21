import { polycomDriver } from '../../lib/hardphones/drivers/polycom.mjs';
import { audioCodesSession, parseAudioCodesStatus } from '../../lib/hardphones/audiocodes-provisioning.mjs';
import { yealinkLegacySession, parseYealinkStatus } from '../../lib/hardphones/yealink-provisioning.mjs';
import { deviceTableText } from '../../lib/hardphones/device-web.mjs';
import { normalizeMac } from '../../lib/hardphones/config-generators.mjs';

// Public manufacturer defaults, NOT customer credentials. One attempt per
// candidate per discovery session; no lists of guessed passwords or retries.
export const FACTORY_CREDENTIALS = Object.freeze({
  polycom:{username:'Polycom',password:'456'}, // UCS REST HTTP Basic; web UI role is Admin.
  audiocodes:{username:'admin',password:'1234'},
  yealink:{username:'admin',password:'admin'},
});
const table = deviceTableText;

export async function authenticatePhone(candidate, password, {poly=polycomDriver, audioSession=audioCodesSession, yealinkSession=yealinkLegacySession}={}) {
  const target={...candidate,admin_user:FACTORY_CREDENTIALS[candidate.vendor]?.username,admin_password:password,
    settings:{management_protocol:candidate.protocol}};
  let result;
  if(candidate.vendor==='polycom') {
    const info=await poly.deviceInfo(target);
    if(!info.ok) throw Error(info.reason==='auth_failed'?'auth_failed':info.httpStatus===404?'rest_api_disabled':info.reason);
    const d=info.data?.data;
    const status=await poly.status(target);
    result={mac:normalizeMac(d?.MACAddress),model:d?.ModelNumber,firmware:d?.FirmwareRelease,
      certificate_fingerprint:info.certificate_fingerprint,registered:JSON.stringify(status.line||'').toLowerCase().includes('registered'),
      idle:status.ok && Array.isArray(status.call) && !status.call.length};
    if(!/^VVX\s*300$/i.test(result.model||''))throw Error('unsupported_device_model');
    result.model='VVX 300';
  } else if(candidate.vendor==='audiocodes') {
    const session=await audioSession(target);
    const page=await session.send('/mainform.cgi/info.htm');
    result={mac:normalizeMac(table(page.raw,'MAC Address')),model:table(page.raw,'Model Name'),firmware:table(page.raw,'Firmware Version'),
      certificate_fingerprint:session.fingerprint,...parseAudioCodesStatus((await session.send('/voip_status.cgi')).raw)};
    if(!['420HD','440HD'].includes(result.model))throw Error('unsupported_device_model');
  } else if(candidate.vendor==='yealink') {
    const session=await yealinkSession(target);
    result={...parseYealinkStatus((await session.send('/servlet?p=status&q=load')).raw),model:'T22P',idle:null};
    if(!/^7\.73\./.test(result.firmware))throw Error('unsupported_device_model');
  } else throw Error('unsupported_device_vendor');
  if(!result.mac || (candidate.mac && candidate.mac!==result.mac))throw Error('device_mac_mismatch');
  return {...target,...result};
}
export class PhoneOnboarding {
  constructor({authenticate=authenticatePhone}={}) {this.authenticate=authenticate;this.candidates=new Map();this.attempted=new Set();}
  discovered(phones) {this.candidates=new Map(phones.map(p=>[p.candidateId,p]));return phones;}
  async login(id,{password,remembered}={}) {
    const p=this.candidates.get(id);if(!p)throw Error('discover_phone_again');
    if(password!==undefined && (typeof password!=='string'||!password||password.length>128))throw Error('invalid_password');
    const key=`${p.mac || p.ip_address}:${p.vendor}`;
    const factory=FACTORY_CREDENTIALS[p.vendor]?.password;
    // A previously enrolled phone may have been factory-reset. Try its one
    // documented factory credential only after an explicit authentication failure.
    const choices=password!==undefined?[password]:[remembered,...(!this.attempted.has(key)&&factory!==remembered?[factory]:[])].filter(Boolean);
    for(const secret of choices) {
      const usingDefault=secret===factory;
      if(usingDefault)this.attempted.add(key);
      try {
        const phone=await this.authenticate(p,secret);
        this.candidates.set(id,{...phone,authenticated:true});
        return {phone,usedDefault:usingDefault};
      } catch(error) {
        if(error.message!=='auth_failed')throw error;
      }
    }
    return {needsPassword:true};
  }
}
