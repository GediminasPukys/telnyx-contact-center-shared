const {randomUUID}=require('node:crypto');
const LEGACY_PARTITION='persist:contact-center-desktop';

function normalizeUrl(value) {
  if(typeof value!=='string' || value.length>2048)throw Error('Enter a Contact Center address.');
  let text=value.trim();
  if(!text)throw Error('Enter a Contact Center address.');
  if(!text.includes('://'))text=`https://${text}`;
  let url;try{url=new URL(text);}catch{throw Error('Enter a valid Contact Center address.');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:' && !(local && url.protocol==='http:')) || url.username || url.password || url.search || url.hash || url.pathname!=='/')
    throw Error('Use the HTTPS site address without a page path, credentials or query. HTTP is allowed only for localhost.');
  return url.origin;
}

function createEnvironmentStore(store,legacyConfig) {
  let data=store.read() || {};
  if(data.environmentVersion!==1) {
    const config=data.config || legacyConfig;
    const environments=[];
    if(config?.appUrl) {
      const url=normalizeUrl(config.appUrl),id=randomUUID();
      environments.push({id,name:['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)?'Dev':'Contact Center',
        url,partition:LEGACY_PARTITION,private:{...data,config:{computerId:randomUUID(),...config,appUrl:url}}});
    }
    data={environmentVersion:1,environments,defaultId:environments[0]?.id || null};
    store.write(data);
  }
  let activeId=data.defaultId;
  function find(id){const env=data.environments.find(e=>e.id===id);if(!env)throw Error('Environment not found.');return env;}
  function commit(next){store.write(next);data=next;}
  return {
    publicState:()=>({environments:data.environments.map(({id,name,url})=>({id,name,url})),defaultId:data.defaultId,activeId}),
    getActive:()=>activeId?find(activeId):null,
    get:find,
    activate(id){find(id);activeId=id;},
    save({id,name,url,makeDefault=false}={}) {
      name=typeof name==='string'?name.trim():'';
      if(!name || name.length>64 || /[\x00-\x1f\x7f]/.test(name))throw Error('Enter an environment name (up to 64 characters).');
      url=normalizeUrl(url);
      const old=id?find(id):null;
      if(data.environments.some(e=>e.id!==id && e.url===url))throw Error('This Contact Center address is already saved.');
      if(old && old.url!==url)throw Error('Add a new environment to use a different URL. Sessions and phone credentials are kept separate.');
      if(!old && data.environments.length>=20)throw Error('You can save up to 20 environments.');
      const env=old?{...old,name}:{id:randomUUID(),name,url,private:{config:{appUrl:url,computerId:randomUUID()}}};
      if(!env.partition)env.partition=`persist:contact-center-${env.id}`;
      commit({...data,environments:old?data.environments.map(e=>e.id===id?env:e):[...data.environments,env],
        defaultId:!data.defaultId || makeDefault?env.id:data.defaultId});
      return env.id;
    },
    setDefault(id){find(id);commit({...data,defaultId:id});},
    remove(id){
      const env=find(id);
      if(id===activeId)throw Error('Switch to another environment before removing this one.');
      if(env.private.config?.allowedPhoneIds?.length || Object.keys(env.private.backups || {}).length)
        throw Error('This environment has enrolled phones or recovery copies. Release its phones and ask an administrator to archive its enrollment before removing it.');
      const environments=data.environments.filter(e=>e.id!==id);
      commit({...data,environments,defaultId:data.defaultId===id?environments[0]?.id || null:data.defaultId});
      return env.partition;
    },
    // The existing onboarding code only sees the active environment's secrets.
    scopedStore:{
      read:()=>activeId?structuredClone(find(activeId).private):{},
      write(value){
        if(!activeId)throw Error('Select a Contact Center environment first.');
        const current=find(activeId);
        if(value.config?.appUrl!==current.url)throw Error('Environment address cannot change during phone enrollment.');
        commit({...data,environments:data.environments.map(e=>e.id===activeId?{...e,private:structuredClone(value)}:e)});
      },
    },
  };
}
function assertCanSwitch({setupBusy,authBusy,callBusy,phones=[]}) {
  if(setupBusy)throw Error('Wait for phone setup or discovery to finish before switching environments.');
  if(authBusy)throw Error('Finish or cancel sign-in before switching environments.');
  if(callBusy || phones.some(p=>p.call?.length))throw Error('Finish all calls before switching environments.');
}
module.exports={normalizeUrl,createEnvironmentStore,assertCanSwitch};
