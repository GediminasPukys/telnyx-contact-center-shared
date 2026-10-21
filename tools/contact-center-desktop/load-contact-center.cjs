const retryable=new Set(['ERR_FAILED','ERR_ABORTED','ERR_CONNECTION_REFUSED','ERR_CONNECTION_RESET','ERR_CONNECTION_CLOSED','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED','ERR_TIMED_OUT','ERR_NAME_NOT_RESOLVED']);
const errorCode=error=>`${error?.code||''} ${error?.message||''}`.match(/\bERR_[A-Z_]+\b/)?.[0]||'UNKNOWN';

// Startup can overlap an OS permission prompt or a same-origin application
// redirect. Retry transient navigation failures, but never certificate errors.
async function loadContactCenter(window,url,{onError=()=>{},wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const wc=window.webContents,origin=new URL(url).origin;
  let completed=false;
  const finished=()=>{try{completed=new URL(wc.getURL()).origin===origin;}catch{completed=false;}};
  wc.on('did-finish-load',finished);
  try{
    for(let attempt=0;attempt<3;attempt++){
      if(window.isDestroyed())return;
      try{await window.loadURL(url);return;}
      catch(error){
        const code=errorCode(error);onError({code,attempt:attempt+1});
        if(window.isDestroyed())return;
        if(!retryable.has(code) || attempt===2)throw error;
        await wait(750*(attempt+1));
        // A canceled original navigation may already have been replaced by a
        // successful redirect. Do not replace that page with an error screen.
        if(completed)return;
      }
    }
  }finally{wc.removeListener('did-finish-load',finished);}
}
module.exports={loadContactCenter};
