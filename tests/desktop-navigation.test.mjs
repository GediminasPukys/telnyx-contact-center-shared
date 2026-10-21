import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {loadContactCenter} from '../tools/contact-center-desktop/load-contact-center.cjs';
const fake=load=>{const wc=new EventEmitter();wc.getURL=()=> 'https://cc.example.test/';return {webContents:wc,loadURL:load,isDestroyed:()=>false};};
test('transient startup failure retries and records only the error code',async()=>{
 let calls=0;const failures=[];const w=fake(async()=>{if(++calls===1)throw Error('ERR_NETWORK_CHANGED at https://private.example/token');});
 await loadContactCenter(w,'https://cc.example.test',{wait:async()=>{},onError:e=>failures.push(e)});
 assert.equal(calls,2);assert.deepEqual(failures,[{code:'ERR_NETWORK_CHANGED',attempt:1}]);assert.equal(w.webContents.listenerCount('did-finish-load'),0);
});
test('Electron generic ERR_FAILED startup error retries; unknown programming errors do not',async()=>{
 for(const [message,count] of [['ERR_FAILED (-2) loading http://localhost:3000',2],['TypeError in application',1]]){
  let calls=0;const w=fake(async()=>{if(++calls===1)throw Object.assign(Error(message),{code:-2});});
  const result=loadContactCenter(w,'https://cc.example.test',{wait:async()=>{}});
  if(count===1)await assert.rejects(result,/TypeError/);else await result;
  assert.equal(calls,count);
 }
});
test('successful redirected navigation is not replaced after original load aborts',async()=>{
 let calls=0;const w=fake(async()=>{calls++;throw Error('ERR_ABORTED');});
 await loadContactCenter(w,'https://cc.example.test',{wait:async()=>w.webContents.emit('did-finish-load')});assert.equal(calls,1);
});
test('persistent network failure is bounded and TLS failure is never retried',async()=>{
 for(const [code,count] of [['ERR_CONNECTION_REFUSED',3],['ERR_CERT_AUTHORITY_INVALID',1]]){
  let calls=0;const w=fake(async()=>{calls++;throw Error(code);});
  await assert.rejects(loadContactCenter(w,'https://cc.example.test',{wait:async()=>{}}),new RegExp(code));
  assert.equal(calls,count);assert.equal(w.webContents.listenerCount('did-finish-load'),0);
 }
});
