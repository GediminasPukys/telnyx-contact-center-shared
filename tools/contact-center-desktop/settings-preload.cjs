const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopSettings',Object.freeze({
  read:()=>ipcRenderer.invoke('desktop:environments','read'),
  save:value=>ipcRenderer.invoke('desktop:environments','save',value),
  setDefault:id=>ipcRenderer.invoke('desktop:environments','default',{id}),
  remove:id=>ipcRenderer.invoke('desktop:environments','remove',{id}),
  connect:id=>ipcRenderer.invoke('desktop:environments','connect',{id}),
}));
