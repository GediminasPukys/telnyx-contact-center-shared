const {app,BrowserWindow,Menu,dialog,utilityProcess,ipcMain,powerMonitor,safeStorage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

let mainWindow,statusWindow,settingsWindow,worker,onboarding,auth,store,environments,config,changingEnvironment=false,rendererCallBusy=false,quitting=false,quitPromptPending=false,lastStatus={type:'status',relay:'not_configured',phones:[]};
const configPath=process.argv.find(a=>a.startsWith('--config='))?.slice(9)||process.env.CC_DESKTOP_CONFIG;
const appName='Telnyx Contact Center';
// Keep the prototype's encrypted enrollment and browser session on upgrade.
// Optional isolated profile for desktop acceptance/support; never shipped with a value.
const profileDirectory=process.env.CC_DESKTOP_USER_DATA_DIR || path.join(app.getPath('appData'),'Contact Center Desktop');
if(!path.isAbsolute(profileDirectory))throw Error('Desktop profile directory must be absolute');
app.setPath('userData',profileDirectory);
// safeStorage's macOS Keychain service is derived from this internal name.
// Preserve it so the branded bundle can decrypt existing enrollment secrets.
// The macOS menu and Dock name come from the packaged Info.plist.
app.setName('Contact Center Desktop');
const appIcon=path.join(__dirname,'assets','icon.png');
if(!app.requestSingleInstanceLock())app.exit(0);
app.on('second-instance',()=>{const w=mainWindow || settingsWindow;w?.show();w?.focus();});
// Replacing the remote window during Retry must not trigger Electron's default
// quit when that window briefly is the last one. The bridge also stays running
// after windows close; the application menu owns the explicit Quit action.
app.on('window-all-closed',()=>{});
function stopBridge(){
  if(quitting)return;
  quitting=true;auth?.cancel();onboarding?.stop();worker?.postMessage({type:'stop'});
  setTimeout(()=>app.exit(0),1500);
}
// OS/service shutdown must not leave an invisible confirmation blocking a restart.
process.on('SIGTERM',stopBridge);
process.on('SIGINT',stopBridge);
// Opt-in loopback debugging for acceptance testing, never enabled by default.
if(process.env.CC_DESKTOP_DEBUG_PORT){
  app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port',process.env.CC_DESKTOP_DEBUG_PORT);
}
const statusUrl=pathToFileURL(path.join(__dirname,'status.html')).href;
const settingsUrl=pathToFileURL(path.join(__dirname,'settings.html')).href;
const connectionErrorUrl=pathToFileURL(path.join(__dirname,'connection-error.html')).href;
function showSettings(){
  if(settingsWindow&&!settingsWindow.isDestroyed()){settingsWindow.show();settingsWindow.focus();return;}
  settingsWindow=new BrowserWindow({width:720,height:860,minWidth:580,minHeight:500,title:'Settings — '+appName,icon:appIcon,backgroundColor:'#111111',
    webPreferences:{preload:path.join(__dirname,'settings-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  settingsWindow.webContents.on('will-navigate',event=>event.preventDefault());
  settingsWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  settingsWindow.on('closed',()=>{settingsWindow=null;});
  settingsWindow.loadURL(settingsUrl);
}
function installMenu(){
  const state=environments.publicState();
  if(mainWindow&&!mainWindow.isDestroyed())mainWindow.setTitle(`${appName} — ${environments.getActive()?.name || ''}`);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:appName,submenu:[{role:'about',label:`About ${appName}`},{type:'separator'},
      {label:'Settings…',accelerator:'CmdOrCtrl+,',click:showSettings},
      {label:'Environment',submenu:state.environments.length?state.environments.map(env=>({label:env.name,type:'checkbox',checked:env.id===state.activeId,
        click:()=>switchEnvironment(env.id).catch(error=>dialog.showErrorBox('Could not switch environment',error.message))})):[{label:'Add an environment…',click:showSettings}]},
      {type:'separator'},{label:'Find and configure phones',enabled:!!state.activeId,click:()=>{mainWindow?.show();mainWindow?.webContents.send('desktop:open-discovery');}},
      {label:'CTI bridge status',click:showStatus},
      {label:'Start at login',type:'checkbox',checked:app.getLoginItemSettings().openAtLogin,click:item=>app.setLoginItemSettings({openAtLogin:item.checked})},
      {type:'separator'},{role:'quit',label:`Quit ${appName}`}]},
    {role:'editMenu'},{role:'viewMenu'},{role:'windowMenu'}
  ]));
}
function showStatus(){
  if(statusWindow&&!statusWindow.isDestroyed()){statusWindow.show();return;}
  statusWindow=new BrowserWindow({width:560,height:480,title:'Desktop CTI bridge',backgroundColor:'#111111',
    webPreferences:{preload:path.join(__dirname,'status-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  statusWindow.loadURL(statusUrl);
}
ipcMain.handle('desktop:status',event=>{
  if(event.senderFrame?.url!==statusUrl)throw Error('Untrusted status sender');
  return lastStatus;
});
async function saveConfig(next){store.write({...store.read(),config:next});config=next;}
async function startBridge(){
  if(!config.allowedPhoneIds?.length)return;
  (await import('./policy.mjs')).validateConfig(config);
  worker=utilityProcess.fork(path.join(__dirname,'bridge-worker.mjs'),[],{serviceName:'Contact Center CTI Bridge',
    env:{PATH:process.env.PATH||'',TMPDIR:app.getPath('temp'),HOME:app.getPath('home')},stdio:'pipe'});
  worker.on('message',message=>{
    if(message.type==='status')lastStatus=message;
    if(message.type==='error')lastStatus={...lastStatus,error:message.error};
    if(message.type==='event'&&process.env.CC_DESKTOP_EVENT_LOG)
      fs.appendFileSync(process.env.CC_DESKTOP_EVENT_LOG,JSON.stringify({at:new Date().toISOString(),...message.event})+'\n',{mode:0o600});
  });
  const started=worker;
  worker.on('exit',()=>{if(worker===started){worker=null;lastStatus={...lastStatus,relay:'offline',error:'CTI helper stopped'};}});
  worker.postMessage({type:'start',config});
}
async function restartBridge(){
  if(!worker)return startBridge();
  // Refresh enrollment without dropping the other phones' SIP flows.
  const id=require('node:crypto').randomUUID();
  await new Promise((resolve,reject)=>{
    const current=worker;
    const timer=setTimeout(()=>{current.removeListener('message',receive);reject(Error('Bridge configuration refresh timed out'));},15000);
    function receive(message){if(message.type!=='updated'||message.id!==id)return;clearTimeout(timer);current.removeListener('message',receive);message.error?reject(Error(message.error)):resolve();}
    current.on('message',receive);current.postMessage({type:'update',id,config});
  });
}
async function openContactCenter(){
  mainWindow?.destroy();
  rendererCallBusy=false;
  const environment=environments.getActive();
  const windowTitle=`${appName} — ${environment.name}`;
  mainWindow=new BrowserWindow({width:1500,height:1000,title:appName,icon:appIcon,backgroundColor:'#080808',
    webPreferences:{preload:path.join(__dirname,'desktop-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,partition:environment.partition}});
  const origin=new URL(config.appUrl).origin;
  const guard=(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();};
  mainWindow.webContents.on('will-navigate',guard);
  mainWindow.webContents.on('will-redirect',guard);
  mainWindow.on('page-title-updated',event=>{event.preventDefault();mainWindow.setTitle(`${appName} — ${environments.getActive().name}`);});
  mainWindow.setTitle(windowTitle);
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  require('./headset-permissions.cjs').installHeadsetPermissions({session:mainWindow.webContents.session,webContents:mainWindow.webContents,origin,
    chooseDevice:async devices=>{
      const result=await dialog.showMessageBox(mainWindow,{type:'question',title:'Choose a headset',message:'Choose a headset for call controls',
        buttons:[...devices.map(device=>device.name||'USB headset'),'Cancel'],cancelId:devices.length,noLink:true});
      return devices[result.response]||null;
    }});
  installMenu();
  mainWindow.on('close',event=>{if(!quitting){event.preventDefault();mainWindow.hide();showStatus();}});
  const openingWindow=mainWindow;
  try{await require('./load-contact-center.cjs').loadContactCenter(openingWindow,config.appUrl,{onError:failure=>{
    // Keep only the last bounded navigation diagnostic, without URL or secrets.
    try{fs.writeFileSync(path.join(profileDirectory,'last-navigation-error.json'),JSON.stringify({at:new Date().toISOString(),...failure}),{mode:0o600});}catch{}
  }});}catch{if(!openingWindow.isDestroyed())await openingWindow.loadURL(connectionErrorUrl);}
  if(openingWindow.isDestroyed())return;
  mainWindow.show();mainWindow.focus();app.focus({steal:true});
}
function assertSwitchAllowed(){
  require('./environments.cjs').assertCanSwitch({setupBusy:onboarding?.isBusy(),authBusy:auth?.isBusy(),callBusy:rendererCallBusy,phones:lastStatus.phones});
}
async function stopEnvironmentBridge(){
  const old=worker;if(!old)return;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{old.removeListener('exit',done);reject(Error('The bridge has not stopped. Try again when it is idle.'));},10000);
    function done(){clearTimeout(timer);resolve();}
    old.once('exit',done);old.postMessage({type:'stop'});
  });
}
async function switchEnvironment(id){
  if(changingEnvironment)throw Error('An environment change is already in progress.');
  const next=environments.get(id),previous=environments.getActive();
  if(previous?.id===id){mainWindow?.show();mainWindow?.focus();settingsWindow?.close();return;}
  assertSwitchAllowed();changingEnvironment=true;
  try{
    if(previous){
      const {response}=await dialog.showMessageBox({type:'warning',buttons:['Cancel','Switch environment'],defaultId:0,cancelId:0,
        message:`Switch from ${previous.name} to ${next.name}?`,detail:'This closes the current Contact Center session and stops its desktop bridge. Finish any calls first. Phones using this computer as their SIP proxy will be unavailable until you return. Phone settings are not moved to the new environment.'});
      if(response!==1)return;
    }
    assertSwitchAllowed();
    if(next.private.config.allowedPhoneIds?.length)(await import('./policy.mjs')).validateConfig(next.private.config);
    await stopEnvironmentBridge();
    onboarding.reset();environments.activate(id);config=store.read().config;
    lastStatus={type:'status',relay:'not_configured',phones:[]};
    try{await startBridge();await openContactCenter();settingsWindow?.close();}
    catch(error){
      if(previous){await stopEnvironmentBridge();environments.activate(previous.id);config=store.read().config;await startBridge();await openContactCenter();}
      throw error;
    }
  }finally{changingEnvironment=false;installMenu();}
}
ipcMain.handle('desktop:environments',async(event,action,value={})=>{
  if(event.sender!==settingsWindow?.webContents || event.senderFrame!==settingsWindow.webContents.mainFrame || event.senderFrame.url!==settingsUrl)throw Error('Untrusted settings sender');
  if(changingEnvironment)throw Error('An environment change is already in progress.');
  if(action==='save'){const id=environments.save(value);installMenu();return {id,state:environments.publicState()};}
  if(action==='default'){environments.setDefault(value.id);installMenu();}
  else if(action==='remove'){
    const target=environments.get(value.id);
    const {response}=await dialog.showMessageBox(settingsWindow,{type:'question',buttons:['Cancel','Remove'],defaultId:0,cancelId:0,message:`Remove ${target.name}?`,detail:'This removes its saved sign-in session from this computer. It does not delete data on the server.'});
    if(response===1){
      const partition=environments.remove(value.id);
      await require('electron').session.fromPartition(partition).clearStorageData();installMenu();
    }
  }else if(action==='connect')await switchEnvironment(value.id);
  else if(action!=='read'&&action!=='default')throw Error('Unknown settings action');
  return environments.publicState();
});
ipcMain.on('desktop:call-busy',(event,value)=>{
  if(event.sender===mainWindow?.webContents && event.senderFrame===mainWindow.webContents.mainFrame && new URL(event.senderFrame.url).origin===new URL(config.appUrl).origin && typeof value==='boolean')rendererCallBusy=value;
});
ipcMain.handle('desktop:connection-recovery',async(event,action)=>{
  if(event.sender!==mainWindow?.webContents || event.senderFrame!==mainWindow.webContents.mainFrame || event.senderFrame.url!==connectionErrorUrl)throw Error('Untrusted recovery request');
  if(action==='settings')showSettings();else if(action==='retry')await openContactCenter();
});
app.whenReady().then(async()=>{
  app.dock?.setIcon(appIcon);
  app.setAboutPanelOptions({applicationName:appName,applicationVersion:app.getVersion(),iconPath:appIcon});
  const encryptedStore=require('./secure-store.cjs')(path.join(app.getPath('userData'),'desktop-settings.enc'),safeStorage);
  let legacyConfig;
  if(configPath){
    if(process.platform!=='win32'&&(fs.statSync(configPath).mode&0o077))throw Error('Legacy configuration must have mode 0600');
    const imported=JSON.parse(fs.readFileSync(configPath,'utf8'));
    // An explicit legacy import is only used once. Later changes use OS storage.
    legacyConfig=imported;
  }
  environments=require('./environments.cjs').createEnvironmentStore(encryptedStore,legacyConfig);
  store=environments.scopedStore;config=store.read().config || {};
  auth=require('./auth-main.cjs')({ipcMain,getWindow:()=>mainWindow,getConfig:()=>config,isSwitching:()=>changingEnvironment});
  onboarding=require('./onboarding-main.cjs')({ipcMain,getWindow:()=>mainWindow,getConfig:()=>config,saveConfig,store,restartBridge,getStatus:()=>lastStatus,isSwitching:()=>changingEnvironment});
  installMenu();
  await startBridge();
  app.on('activate',()=>{if(mainWindow)mainWindow.show();else showSettings();});
  powerMonitor.on('resume',()=>{lastStatus={...lastStatus,error:'Computer resumed; checking phone connectivity. Use Find phones if the network changed.'};});
  if(config.appUrl)await openContactCenter();
  else showSettings();
}).catch(error=>{dialog.showErrorBox('Desktop startup failed',error.message);app.exit(1);});
app.on('before-quit',event=>{
  if(quitting)return;
  event.preventDefault();
  if(onboarding?.isBusy()){dialog.showErrorBox('Phone setup is running','Wait for phone setup to finish before quitting.');return;}
  if(changingEnvironment)return;
  if(!worker){stopBridge();return;}
  if(quitPromptPending)return;
  quitPromptPending=true;
  const active=lastStatus.phones.some(p=>p.call?.length);
  dialog.showMessageBox({type:'warning',buttons:['Keep running','Quit bridge'],defaultId:0,cancelId:0,
    message:active?'A phone call is still active.':'Stop the desktop CTI bridge?',
    detail:'Phones configured to use this computer as their SIP proxy lose registration and CTI while it is stopped. Closing the CC window keeps the bridge running.'})
    .then(({response})=>{quitPromptPending=false;if(response===1)stopBridge();})
    .catch(()=>{quitPromptPending=false;});
});
