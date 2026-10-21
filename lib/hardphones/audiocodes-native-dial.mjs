import { inspectAudioCodes } from './audiocodes-provisioning.mjs';
import { readDeviceForm, deviceAttributes } from './device-web.mjs';
import { nativeDialTarget } from './native-dial-target.mjs';

// The 420HD/440HD directory UI exposes this authenticated form. A successful
// POST is only acceptance; the SIP controller must observe the outgoing INVITE.
export async function dialAudioCodes(phone, {number, expiresAt, canDial=()=>true}, {inspect=inspectAudioCodes}={}) {
  let dispatched=false;
  try {
    nativeDialTarget(number);
    if (!phone.admin_password || !phone.certificate_fingerprint || phone.settings?.management_protocol==='http')
      throw Error('phone_https_credentials_required');
    const device=await inspect(phone,{certificate_fingerprint:phone.certificate_fingerprint});
    if (!device.idle || !device.registered) throw Error('phone_not_idle');
    const name=phone.model==='420HD'?'dial.htm':phone.model==='440HD'?'Dial.htm':null;
    if (!name) throw Error('unsupported_device_model');
    const path=`/mainform.cgi/${name}`;
    const page=await device.session.send(path);
    const tag=[...page.raw.matchAll(/<form\b([^>]*)>/gi)].map(m=>deviceAttributes(m[1])).find(a=>a.name==='DIAL');
    if (tag?.method?.toUpperCase()!=='POST' || tag.action!==name) throw Error('unsupported_device_form');
    const fields=readDeviceForm(page.raw,'DIAL');
    if (!fields.has('number')) throw Error('unsupported_device_form');
    fields.set('number',number);
    if (!Number.isFinite(expiresAt) || expiresAt<Date.now()) throw Error('dial_intent_expired');
    if (!canDial()) throw Error('phone_state_changed');
    dispatched=true;
    const result=await device.session.send(path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:fields.toString()});
    if (/PASSWORD ERROR|permission denied/i.test(result.raw)) return {ok:false,reason:'auth_failed',definitive:true};
    return {ok:true};
  } catch(error) {return {ok:false,reason:error.message,definitive:!dispatched};}
}
