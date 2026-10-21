import { discoverPhones,localNetworks,inNetwork } from './discovery.mjs';
import { PhoneOnboarding } from './phone-onboarding.mjs';
import { planPhoneSetup,applyPhoneSetup,activatePhoneSetup } from './configure-phone.mjs';
const flow=new PhoneOnboarding();let busy=false;
process.parentPort.on('message',async({data:m})=>{
  if(busy)return process.parentPort.postMessage({id:m.id,error:'Setup is already in progress'});
  busy=true;
  try {
    let result;
    if(m.method==='discover'){result=await discoverPhones({readNeighbors:async()=>m.args.neighbors || []});flow.discovered(result.phones);}
    else if(m.method==='login') {
      const candidate=flow.candidates.get(m.args.id);
      if(!candidate||!localNetworks().some(n=>inNetwork(candidate.ip_address,n)&&n.host===candidate.localHost))throw Error('network_changed');
      result=await flow.login(m.args.id,m.args);
    } else if(m.method==='plan') {
      const p=flow.candidates.get(m.args.id);if(!p?.authenticated)throw Error('Authenticate the phone first');
      result=await planPhoneSetup({...p,event_token:m.args.eventToken},m.args.prepared,m.args.config);
    } else if(m.method==='apply'){result=await applyPhoneSetup(m.args.plan,{restore:m.args.restore===true,onProgress:phase=>process.parentPort.postMessage({id:m.id,progress:phase})});if(!m.args.restore){const p=flow.candidates.get(m.args.plan.phone.candidateId);if(p)p.admin_password=m.args.plan.desiredPassword;}}
    else if(m.method==='activate')result=await activatePhoneSetup(m.args.plan,{verifyOnly:m.args.verifyOnly,onProgress:phase=>process.parentPort.postMessage({id:m.id,progress:phase})});
    else throw Error('Unknown setup action');
    process.parentPort.postMessage({id:m.id,result});
  }catch(e){process.parentPort.postMessage({id:m.id,error:e.message});}finally{busy=false;}
});
