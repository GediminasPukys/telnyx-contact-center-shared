const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktopStatus',{read:()=>ipcRenderer.invoke('desktop:status')});
