import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { nativePhoneState, nativeActionAllowed } from '../lib/telephony/native-phone-state.mjs';
import { PHONE_MODEL_CATALOG, modelCatalogEntry } from '../lib/hardphones/model-catalog.mjs';
const observe=(state,extra={})=>nativePhoneState({call:[{CallHandle:'42',CallState:state,...extra}]});
test('incoming, outgoing, connected and held device observations expose appropriate controls',()=>{
 const ringing=observe('Ringing',{Type:'Incoming'});assert.equal(ringing.status,'ringing');assert.ok(nativeActionAllowed(ringing,'answer'));assert.equal(nativeActionAllowed(ringing,'hold'),false);
 const outgoing=observe('RingBack',{Type:'Outgoing'});assert.equal(outgoing.status,'dialing');assert.equal(nativeActionAllowed(outgoing,'answer'),false);assert.ok(nativeActionAllowed(outgoing,'hangup'));
 const active=observe('Connected',{Muted:'1',RemotePartyNumber:'+15555550100'});assert.equal(active.status,'active');assert.equal(active.isMuted,true);assert.ok(nativeActionAllowed(active,'hold'));assert.ok(nativeActionAllowed(active,'send_dtmf'));
 const held=observe('Held');assert.equal(held.status,'held');assert.ok(nativeActionAllowed(held,'resume'));assert.equal(nativeActionAllowed(held,'mute'),false);assert.equal(nativeActionAllowed(held,'send_dtmf'),false);
});
test('unknown, ambiguous, idle and unidentifiable calls cannot be controlled',()=>{
 for(const state of [nativePhoneState({call:null}),nativePhoneState({call:null},{callStateKnown:false}),observe('UnrecognizedState'),nativePhoneState({call:[{CallState:'Connected'}]}),nativePhoneState({call:[{Ref:'1',CallState:'Connected'},{Ref:'2',CallState:'Ringing'}]})]){
  for(const action of ['answer','hangup','hold','resume','mute','unmute','send_dtmf','dial','transfer'])assert.equal(nativeActionAllowed(state,action),false);
 }
 assert.equal(nativePhoneState({call:null},{callStateKnown:false}).status,'unknown');
});
test('ended observations are excluded; mute absence remains unknown',()=>{
 assert.equal(observe('Disconnected').status,'idle');assert.equal(observe('Connected').isMuted,null);assert.equal(observe('Connected',{Muted:'0'}).isMuted,false);
});
test('all shared catalog images have corresponding compact thumbnails and previews',()=>{
 let count=0;
 for(const [vendor,models] of Object.entries(PHONE_MODEL_CATALOG))for(const [model,entry] of Object.entries(models)){
  if(!entry.image)continue;
  const shared=modelCatalogEntry(vendor,model);
  for(const file of [shared.image,shared.thumbnail,shared.preview])assert.ok(existsSync(new URL('../public'+file,import.meta.url)),file);
  count++;
 }
 assert.ok(count>=60);
 assert.equal(modelCatalogEntry('Polycom','VVX300').thumbnail,modelCatalogEntry('poly','VVX 300').thumbnail);
 assert.equal(modelCatalogEntry('Yealink','SIP-T22P').model,'T22P');
 assert.equal(modelCatalogEntry('AudioCodes','440 HD').model,'440HD');
 assert.equal(modelCatalogEntry('polycom','Rove 40').image,null);
 assert.equal(modelCatalogEntry('polycom','not-a-real-model'),null);
});
