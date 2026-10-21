import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import vm from 'node:vm';import {EventEmitter} from 'node:events';
function fixture(run=async()=>({ok:true})){
 const handlers={},events=[],wc=new EventEmitter();wc.mainFrame={url:'https://tenant.test/signin'};wc.session={};wc.send=(...args)=>events.push(args);
 const window={webContents:wc,isDestroyed:()=>false,isMinimized:()=>true,restore:()=>events.push('restore'),show:()=>events.push('show'),focus:()=>events.push('focus'),loadURL:async url=>events.push(url)};
 const module={exports:{}};
 vm.runInNewContext(readFileSync(new URL('../tools/contact-center-desktop/auth-main.cjs',import.meta.url),'utf8'),{module,URL,AbortController,AbortSignal,require:name=>name==='electron'?{shell:{openExternal:()=>{}},app:{focus:()=>events.push('app-focus')}}:{signInWithBrowser:run}});
 const auth=module.exports({ipcMain:{handle:(id,fn)=>handlers[id]=fn},getWindow:()=>window,getConfig:()=>({appUrl:'https://tenant.test'})});
 return {auth,window,wc,events,handlers,event:{sender:wc,senderFrame:wc.mainFrame}};
}
test('only the current trusted main frame can start or cancel authentication',async()=>{
 const f=fixture();for(const event of [{sender:f.wc,senderFrame:{url:'https://tenant.test/signin'}},{sender:{},senderFrame:f.wc.mainFrame}]){
  await assert.rejects(f.handlers['desktop:google-signin'](event),/Untrusted/);assert.throws(()=>f.handlers['desktop:cancel-signin'](event),/Untrusted/);
 }
 f.wc.mainFrame.url='https://other.test/signin';await assert.rejects(f.handlers['desktop:google-signin'](f.event),/Untrusted/);
});
test('verified session navigates to phone picker on configured origin and restores/focuses application',async()=>{
 const f=fixture(async options=>{assert.equal(options.origin,'https://tenant.test');options.onStatus('completing');return {ok:true};});
 assert.deepEqual(JSON.parse(JSON.stringify(await f.handlers['desktop:google-signin'](f.event))),{ok:true});
 assert.deepEqual(f.events,[['desktop:signin-status','completing'],'https://tenant.test/signin/phone','restore','show','focus','app-focus']);assert.equal(f.auth.isBusy(),false);
});
test('cancellation and destroyed renderer abort sign-in and release the environment switch guard',async()=>{
 for(const close of [false,true]){
  const f=fixture(({signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  const pending=f.handlers['desktop:google-signin'](f.event);assert.equal(f.auth.isBusy(),true);
  await assert.rejects(f.handlers['desktop:google-signin'](f.event),/already running/);
  if(close)f.wc.emit('destroyed');else f.handlers['desktop:cancel-signin'](f.event);
  assert.equal((await pending).error,'cancelled');assert.equal(f.auth.isBusy(),false);assert.deepEqual(f.events,[]);assert.equal(f.wc.listenerCount('destroyed'),0);
 }
});

test('authentication failure never navigates or focuses an unauthenticated window',async()=>{
 const f=fixture(async()=>{throw Error('session verification failed');});
 assert.equal((await f.handlers['desktop:google-signin'](f.event)).error,'failed');assert.deepEqual(f.events,[]);assert.equal(f.auth.isBusy(),false);
});
