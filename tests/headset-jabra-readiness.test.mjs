import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jabraFixture, tick } from './helpers/headset-fixtures.mjs';

async function ready(t) { const f = jabraFixture(); t.after(() => f.adapter.dispose()); await f.adapter.init(); await f.adapter.setSelectedDevice('a'); return f; }
test('Jabra reconnect initializes SDK with the active muted held call without emitting initial commands', async t => {
 const f = await ready(t), commands = []; f.adapter.onCommand(c => commands.push(c));
 await f.adapter.setSoftphoneState({callId:'c', active:true, muted:true, held:true});
 f.control.onDisconnect.emit(); await f.adapter.setSelectedDevice('a');
 assert.deepEqual(f.initialStates.at(-1), {ongoingCalls:1,muted:true,onHold:true});
 assert.equal(commands.length,0); assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
 f.control.muteState.emit('unmuted'); f.control.holdState.emit('not-on-hold');
 assert.deepEqual(commands.map(c=>[c.type,c.muted??c.held]),[['mute',false],['hold',false]]);
});
test('Jabra hardware hangup and rejection do not repeat SDK end/reject when WebRTC publishes idle', async t => {
 const f = await ready(t);
 await f.adapter.setSoftphoneState({callId:'c',active:true}); f.control.ongoingCalls.emit(0);
 f.control.endCall = async()=>{throw new Error('SDK has no ongoing calls');};
 await f.adapter.setSoftphoneState({});
 await f.adapter.setSoftphoneState({callId:'r',ringing:true}); f.rings.at(-1)(false); await tick();
 f.control.rejectIncomingCall=async()=>{throw new Error('SDK has no incoming call');};
 await f.adapter.setSoftphoneState({});
});
test('Jabra hardware mute followed by GUI unmute sends the new state to hardware', async t => {
 const f = await ready(t); await f.adapter.setSoftphoneState({callId:'c',active:true});
 f.control.muteState.emit('muted'); await f.adapter.setSoftphoneState({callId:'c',active:true,muted:true});
 assert.equal(f.calls.filter(c=>c[0]==='mute').length,0);
 await f.adapter.setSoftphoneState({callId:'c',active:true,muted:false}); assert.equal(f.calls.at(-1)[0],'unmute');
});
test('Jabra disconnect while starting a call cannot write mute/hold to a replacement control', async t => {
 const f = await ready(t); let release; f.control.startCall=()=>new Promise(resolve=>{release=resolve;});
 const operation=f.adapter.setSoftphoneState({callId:'c',active:true,muted:true,held:true}); await tick();
 f.control.onDisconnect.emit(); release(); await assert.rejects(operation,/control changed/);
 assert(!f.calls.some(c=>['mute','hold'].includes(c[0])));
});
test('Jabra extension discovery does not request WebHID permission; fallback pairing keeps the gesture', async t => {
 const f = await ready(t); await f.adapter.requestPermission(); assert(!f.calls.some(c=>c[0]==='pair'));
 f.api.transportContext='web-hid'; const permission=f.adapter.requestPermission(); assert.equal(f.calls.at(-1)[0],'pair'); await permission;
});
test('Identical Jabra devices without serials remain separately selectable', async t => {
 const f = await ready(t); let inventory; f.adapter.onDevicesChange(value=>{inventory=value;});
 f.api.deviceAdded.emit({name:'Jabra Link',productId:1}); f.api.deviceAdded.emit({name:'Jabra Link',productId:1});
 assert.equal(inventory.length,3); assert.equal(new Set(inventory.map(d=>d.id)).size,3);
});
test('Jabra defers mute while held and resumes before replaying the latest microphone state', async t => {
 const f=await ready(t); await f.adapter.setSoftphoneState({callId:'c',active:true,held:true});
 const before=f.calls.length; const mute=f.control.mute; f.control.mute=async()=>{throw new Error('cannot change mute while on hold');};
 await f.adapter.setSoftphoneState({callId:'c',active:true,held:true,muted:true}); assert.equal(f.calls.length,before);
 f.control.mute=mute;await f.adapter.setSoftphoneState({callId:'c',active:true,muted:true});
 assert.deepEqual(f.calls.slice(before).map(c=>c[0]),['resume','mute']);
});
test('Jabra SDK automatic teardown on disconnect still clears local subscriptions and control', async t => {
 const f=await ready(t);f.control.teardown=()=>{throw new Error('Easy Call Control instance already torn down.');};
 f.control.onDisconnect.emit();assert.equal(f.adapter.getDevice().controlReady,false);assert.equal(f.control.muteState.count,0);
});
test('Jabra ring timeout leaves GUI able to answer without rejecting the expired SDK offer again', async t => {
 const f=jabraFixture({incomingRingTimeoutMs:1});t.after(()=>f.adapter.dispose());await f.adapter.init();await f.adapter.setSelectedDevice('a');
 const commands=[];f.adapter.onCommand(c=>commands.push(c));await f.adapter.setSoftphoneState({callId:'r',ringing:true});f.rings.at(-1)(false);await tick();
 assert.equal(commands.length,0);await f.adapter.setSoftphoneState({callId:'r',active:true});assert(f.calls.some(c=>c[0]==='start'));assert(!f.calls.some(c=>c[0]==='accept'));
});
test('Jabra ring test cancellation needs no duplicate reject; hardware test answer cleans up SDK call', async t => {
 const f=await ready(t);
 const rejected=f.adapter.sendTestCommand('ring');f.rings.at(-1)(false);await rejected;assert(!f.calls.some(c=>c[0]==='reject'));
 const answered=f.adapter.sendTestCommand('ring');f.rings.at(-1)(true);await answered;assert.equal(f.calls.at(-1)[0],'end');
});
test('Jabra removed while the factory is pending cannot claim a disconnected control',async t=>{
 const f=jabraFixture();t.after(()=>f.adapter.dispose());let release;
 f.sdk.EasyCallControlFactory=class {supportsEasyCallControl(){return true;} createMultiCallControl(){return new Promise(resolve=>{release=()=>resolve(f.control);});}};
 await f.adapter.init();const selecting=f.adapter.setSelectedDevice('a');f.api.deviceRemoved.emit(f.device);release();await selecting;
 assert.equal(f.adapter.getDevice(),null);assert(f.calls.some(c=>c[0]==='teardown'));
});
