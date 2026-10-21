const {shell,app} = require('electron');
const {signInWithBrowser} = require('./auth-flow.cjs');

module.exports = function({ipcMain,getWindow,getConfig,isSwitching = () => false}) {
  let running;
  function trusted(event) {
    const window = getWindow(), origin = new URL(getConfig().appUrl).origin;
    if (!window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) {
      throw Error('Untrusted sign-in request');
    }
    return {window,origin};
  }
  const cancel = () => running?.abort(Object.assign(Error('Sign-in cancelled'),{code:'CANCELLED'}));
  ipcMain.handle('desktop:cancel-signin',event => {trusted(event);cancel();});
  ipcMain.handle('desktop:google-signin',async event => {
    const {window,origin} = trusted(event);
    if (isSwitching()) throw Error('Wait for the environment change to finish');
    if (running) throw Error('Sign-in is already running');
    running = new AbortController();
    const signal = AbortSignal.any([running.signal,AbortSignal.timeout(300000)]);
    window.webContents.once('destroyed',cancel);
    try {
      await signInWithBrowser({origin,session:window.webContents.session,openExternal:shell.openExternal,signal,
        onStatus:status => {if (!window.isDestroyed()) window.webContents.send('desktop:signin-status',status);},
      });
      if (window.isDestroyed()) return {ok:false};
      await window.loadURL(`${origin}/signin/phone`);
      if (window.isMinimized()) window.restore();
      window.show();window.focus();app.focus({steal:true});
      return {ok:true};
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      return {ok:false,error:reason?.code === 'CANCELLED' ? 'cancelled' : reason?.name === 'TimeoutError' ? 'expired' : 'failed'};
    } finally {
      window.webContents.removeListener('destroyed',cancel);
      running = null;
    }
  });
  return {isBusy:() => !!running,cancel};
};
