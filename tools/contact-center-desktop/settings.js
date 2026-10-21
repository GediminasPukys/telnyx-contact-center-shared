const api=window.desktopSettings,$=id=>document.getElementById(id);
let state,editing=null,busy=false;
function message(text=''){$('message').textContent=text;}
function errorText(error){return String(error?.message || 'Could not update settings.').replace(/^Error invoking remote method '[^']+': Error: /,'');}
async function run(action){
  if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);message();
  try{await action();}catch(error){message(errorText(error));}
  finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
function reset(){editing=null;$('environment-form').reset();$('url').readOnly=false;$('cancel').hidden=true;$('form-title').textContent='Add an environment';$('save').textContent=state?.environments.length?'Save environment':'Save and connect';$('default').checked=!state?.environments.length;}
function button(label,action,kind=''){const b=document.createElement('button');b.textContent=label;b.className=kind;b.addEventListener('click',()=>run(action));return b;}
function render(){
  const list=$('environments');list.replaceChildren();list.setAttribute('aria-busy','false');$('list-section').hidden=!state.environments.length;
  $('heading').textContent=state.environments.length?'Your environments':'Welcome to Contact Center';
  $('intro').textContent=state.environments.length?'Choose where you work. Your default environment opens when the app starts.':'Enter your organization’s Contact Center address to get started. You can add more environments later in Settings.';
  for(const env of state.environments){
    const row=document.createElement('article');row.className=`environment${env.id===state.activeId?' active':''}`;
    const identity=document.createElement('div');identity.className='identity';
    const name=document.createElement('div');name.className='name';name.textContent=env.name;
    const url=document.createElement('div');url.className='url';url.textContent=env.url;
    const badges=document.createElement('div');badges.className='badges';
    for(const [show,text,cls] of [[env.id===state.activeId,'Active',''],[env.id===state.defaultId,'Opens at startup','default-badge']])if(show){const badge=document.createElement('span');badge.className=`badge ${cls}`;badge.textContent=text;badges.append(badge);}
    identity.append(name,url,badges);const actions=document.createElement('div');actions.className='row-actions';
    actions.append(button(env.id===state.activeId?'Open':'Connect',async()=>{state=await api.connect(env.id);render();},'primary'));
    actions.append(button('Edit',async()=>{editing=env.id;$('name').value=env.name;$('url').value=env.url;$('url').readOnly=true;$('default').checked=state.defaultId===env.id;$('form-title').textContent='Edit environment';$('save').textContent='Save changes';$('cancel').hidden=false;$('name').focus();}));
    if(env.id!==state.defaultId)actions.append(button('Make default',async()=>{state=await api.setDefault(env.id);render();}));
    if(env.id!==state.activeId)actions.append(button('Remove',async()=>{state=await api.remove(env.id);reset();render();},'danger'));
    row.append(identity,actions);list.append(row);
  }
}
$('environment-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  const first=!state.environments.length;
  const result=await api.save({id:editing,name:$('name').value,url:$('url').value,makeDefault:$('default').checked});
  state=result.state;reset();render();
  if(first){state=await api.connect(result.id);render();}else message('Environment saved. Choose Connect to open it.');
});});
$('cancel').addEventListener('click',()=>{reset();message();});
run(async()=>{state=await api.read();render();reset();});
