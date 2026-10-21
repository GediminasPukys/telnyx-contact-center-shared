const {utilityProcess}=require('electron');
const path=require('node:path');
const {randomUUID}=require('node:crypto');

module.exports=function onboarding({ipcMain,getWindow,getConfig,saveConfig,store,restartBridge,getStatus,isSwitching=()=>false}) {
  let helper,sequence=0,operation=false,discovered=[],scannedAt=null,progress=null,pendingActivation=null;const pending=new Map();
  let requests=0;
  const phases=new Set(['preparing','saving','checking_settings','connecting_bridge','preparing_restart','restarting','waiting_for_phone','registering','complete','pending','failed']);
  function report(phase,detail={}) {
    if(!phases.has(phase))return;
    progress={...progress,...detail,phase,updatedAt:new Date().toISOString()};
    const w=getWindow();if(w&&!w.isDestroyed())w.webContents.send('desktop:setup-progress',progress);
  }
  function rpc(method,args={}) {
    if(!helper){helper=utilityProcess.fork(path.join(__dirname,'onboarding-worker.mjs'),[],{serviceName:'Local phone discovery',stdio:'pipe'});
      helper.on('message',m=>{const p=pending.get(m.id);if(p&&m.progress){report(m.progress);return;}if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);}});
      const current=helper;
      helper.on('exit',()=>{if(helper!==current)return;helper=null;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Phone setup helper stopped'));}pending.clear();});}
    const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Phone setup timed out. Check the phone before retrying.'));},method==='activate'?420000:method==='apply'?300000:180000);pending.set(id,{resolve,reject,timer});helper.postMessage({id,method,args});});
  }
  async function server(body) {
    const w=getWindow(),config=getConfig();
    const response=await w.webContents.session.fetch(new URL('/api/telephony/desktop',config.appUrl).href,{method:'POST',headers:{'Content-Type':'application/json','Origin':new URL(config.appUrl).origin},body:JSON.stringify(body),credentials:'include',redirect:'error'});
    const data=await response.json();if(!response.ok)throw Error(data.error || 'Sign in to Contact Center');return data;
  }
  async function inventory() {
    const response=await getWindow().webContents.session.fetch(new URL('/api/telephony/stations',getConfig().appUrl).href,{credentials:'include',redirect:'error'});
    if(!response.ok)throw Error('Sign in to Contact Center first');return response.json();
  }
  const publicPhone=p=>({candidateId:p.candidateId,mac:p.mac,vendor:p.vendor,model:p.model,ip:p.ip_address,authenticated:!!p.authenticated,registered:p.registered,
    legacy:p.vendor==='yealink',name:p.model||({polycom:'Poly / Polycom',audiocodes:'AudioCodes',yealink:'Yealink'})[p.vendor]});
  function trusted(event) {
    const w=getWindow();if(!w || event.sender!==w.webContents || event.senderFrame!==w.webContents.mainFrame || new URL(event.senderFrame.url).origin!==new URL(getConfig().appUrl).origin)throw Error('Untrusted desktop request');
  }
  function handle(name,fn,{mutation=true}={}){ipcMain.handle(name,async(event,args)=>{
    trusted(event);
    if(isSwitching())throw Error('Wait for the environment change to finish');
    if(mutation&&operation)throw Error('Phone setup is already in progress');
    if(mutation)operation=true;
    requests++;
    try{await inventory();return await fn(args);}catch(error){if(name==='desktop:configure'&&progress?.phase!=='failed')report('failed');throw error;}finally{requests--;if(mutation)operation=false;}
  });}
  handle('desktop:nearby',()=>({phones:discovered.map(publicPhone),scannedAt,progress}),{mutation:false});
  handle('desktop:discover',async()=>{
    const {neighbors}=await import('./discovery.mjs');
    const config=getConfig(),cached=(config.nativePhones||[]).map(p=>({ip:p.ip_address,mac:p.mac}));
    // macOS can hide ARP entries from GUI applications. Enrolled addresses are
    // discovery hints only: every candidate must respond, and authenticated
    // identity plus the pinned certificate are checked before configuration.
    const result=await rpc('discover',{neighbors:[...await neighbors(),...cached]});
    const learned=await neighbors();
    discovered=result.phones.map(p=>({...p,mac:learned.find(n=>n.ip===p.ip_address)?.mac||p.mac}));
    scannedAt=new Date().toISOString();
    for(const p of discovered){const known=config.nativePhones?.find(n=>n.mac===p.mac&&n.vendor===p.vendor);if(known)p.model=known.model;}
    return {...result,phones:discovered.map(publicPhone),scannedAt};
  });
  handle('desktop:authenticate',async args=>{
    const candidate=discovered.find(p=>p.candidateId===args?.candidateId);if(!candidate)throw Error('Discover the phone again');
    const old=getConfig().nativePhones?.find(p=>p.mac===candidate.mac&&p.vendor===candidate.vendor);
    if(old?.certificate_fingerprint && old.certificate_fingerprint!==candidate.certificate_fingerprint)throw Error('The phone certificate changed. Ask an administrator to verify it.');
    const result=await rpc('login',{id:args.candidateId,password:args.password,remembered:old?.admin_password});
    if(result.needsPassword)return {needsPassword:true};
    Object.assign(candidate,result.phone,{authenticated:true});return {phone:publicPhone(candidate)};
  });
  handle('desktop:configure',async args=>{
    const p=discovered.find(p=>p.candidateId===args?.candidateId);if(!p?.authenticated)throw Error('Authenticate the phone first');
    if(getStatus().phones?.some(p=>p.call?.length))throw Error('Finish all phone calls before changing desktop configuration');
    progress=null;report('preparing',{candidateId:p.candidateId,startedAt:new Date().toISOString()});
    let config=getConfig();
    if(config.sipHost && config.sipHost!==p.localHost && config.allowedPhoneIds?.length)throw Error('This desktop is configured on another network. Release its phones before moving its controller.');
    const enrollment=await server({action:'enroll',computerId:config.computerId || randomUUID(),computerName:require('node:os').hostname(),bridgeId:config.bridgeId,bridgeToken:config.bridgeToken});
    // Existing imported enrollment retains its working relay route.
    config={...config,...enrollment,relayUrl:config.relayUrl || enrollment.relayUrl,sipHost:p.localHost,sipPort:5070,eventPort:5071};
    await saveConfig(config);
    const prepared=await server({action:'prepare',bridgeId:config.bridgeId,bridgeToken:config.bridgeToken,phone:{mac:p.mac,vendor:p.vendor,model:p.model,ip_address:p.ip_address,localHost:p.localHost}});
    let plan,applied=false,finishing=false,committed=false;
    const previousConfig=config;
    try {
      plan=await rpc('plan',{id:args.candidateId,prepared,eventToken:config.nativePhones?.find(n=>n.mac===p.mac)?.event_token,config:{sipHost:config.sipHost,eventPort:config.eventPort}});
      const saved=store.read()||{};saved.backups={...saved.backups,[plan.phone.id]:{at:new Date().toISOString(),plan}};store.write(saved);
      applied=true;report('saving');const result=await rpc('apply',{plan});
      const nativePhone={...plan.phone,admin_password:plan.desiredPassword,authenticated:undefined,candidateId:undefined,localHost:undefined,protocol:undefined};
      config={...config,allowedPhoneIds:[...new Set([...(config.allowedPhoneIds||[]),nativePhone.id])],nativePhones:[...(config.nativePhones||[]).filter(n=>n.id!==nativePhone.id),nativePhone]};
      await saveConfig(config);
      // Keep the newly verified credentials if the server commit response is
      // lost. Rolling hardware back after an uncertain commit splits ownership.
      finishing=true;
      await server({action:'finish',phoneId:prepared.phone.id,setupToken:prepared.setupToken,success:true});
      committed=true;pendingActivation={plan,candidateId:p.candidateId,extension:prepared.phone.extension};
      report('connecting_bridge');await restartBridge();
      await rpc('activate',{plan});
      pendingActivation=null;report('complete');
      return {ok:true,phone:publicPhone(p),extension:prepared.phone.extension,notice:result.notice};
    } catch(error) {
      // Never turn an uncertain commit into a second destructive configuration.
      const reason=/^[a-zA-Z0-9 _.:;-]{1,160}$/.test(error.message)?error.message:'setup_failed';
      console.warn('[phone-setup]',JSON.stringify({phase:progress?.phase,model:p.model,reason}));
      if(committed){report('pending',{lastPhase:progress?.phase});return {pending:true,phone:publicPhone(p),extension:prepared.phone.extension};}
      if(finishing){report('failed');throw Error('Settings were saved on the phone, but Contact Center could not confirm enrollment. Ask an administrator to check the saved recovery point.');}
      report('failed');
      let restored=!applied;
      if(applied&&plan){try{await rpc('apply',{plan,restore:true});restored=true;}catch{ /* Encrypted restore point retained for support. */ }}
      if(restored){await saveConfig(previousConfig);await server({action:'finish',phoneId:prepared.phone.id,setupToken:prepared.setupToken,success:false}).catch(()=>{});}
      throw Error(restored?error.message:`${error.message}. Automatic restore could not be verified; an encrypted recovery copy is saved on this computer.`);
    }
  });
  handle('desktop:verify',async args=>{
    const pending=pendingActivation;
    if(!pending || args?.candidateId!==pending.candidateId)throw Error('No activation check is pending');
    const available=await inventory();
    if(!available.stations?.some(s=>s.phone_id===pending.plan.phone.id))throw Error('Phone is not available to this account');
    try {
      report('connecting_bridge',{startedAt:new Date().toISOString(),verificationOnly:true});await restartBridge();
      await rpc('activate',{plan:pending.plan,verifyOnly:true});
      pendingActivation=null;report('complete');
      return {ok:true,extension:pending.extension};
    }catch(error){console.warn('[phone-setup] activation check',/^[a-z_]+$/.test(error.message)?error.message:'activation_not_confirmed');report('pending');return {pending:true,extension:pending.extension};}
  });
  return {stop(){helper?.kill();},isBusy:()=>operation||requests>0,
    reset(){helper?.kill();helper=null;discovered=[];scannedAt=null;progress=null;pendingActivation=null;}};
};
