const {contextBridge,ipcRenderer}=require('electron');
// Deliberately no generic invoke, URL, filesystem or network API.
contextBridge.exposeInMainWorld('contactCenterDesktop',Object.freeze({
  version:3,
  reportCallBusy:value=>{if(typeof value==='boolean')ipcRenderer.send('desktop:call-busy',value);},
  recoverConnection:action=>{if(['settings','retry'].includes(action))return ipcRenderer.invoke('desktop:connection-recovery',action);},
  signInGoogle:()=>ipcRenderer.invoke('desktop:google-signin'),
  cancelSignIn:()=>ipcRenderer.invoke('desktop:cancel-signin'),
  onSignInStatus:callback=>{const listener=(_event,status)=>callback(status);ipcRenderer.on('desktop:signin-status',listener);return()=>ipcRenderer.removeListener('desktop:signin-status',listener);},
  nearby:()=>ipcRenderer.invoke('desktop:nearby'),
  discover:()=>ipcRenderer.invoke('desktop:discover'),
  authenticate:(candidateId,password)=>ipcRenderer.invoke('desktop:authenticate',{candidateId,password}),
  verify:candidateId=>ipcRenderer.invoke('desktop:verify',{candidateId}),
  onSetupProgress:callback=>{const listener=(_event,progress)=>callback(progress);ipcRenderer.on('desktop:setup-progress',listener);return()=>ipcRenderer.removeListener('desktop:setup-progress',listener);},
  configure:candidateId=>ipcRenderer.invoke('desktop:configure',{candidateId}),
  onDiscoveryRequested:callback=>{const listener=()=>callback();ipcRenderer.on('desktop:open-discovery',listener);return()=>ipcRenderer.removeListener('desktop:open-discovery',listener);},
}));
