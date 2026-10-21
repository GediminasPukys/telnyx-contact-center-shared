import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPolyAdapter, describePolyReports } from '../lib/headsets/adapters/poly-adapter.mjs';
import { polyFixture } from './helpers/headset-fixtures.mjs';
import { createHeadsetControlService } from '../lib/headsets/headset-control-service.mjs';
async function ready(t) { const f = polyFixture(), adapter = createPolyAdapter({ hid: f.hid }); let devices; adapter.onDevicesChange(d => { devices = d; }); await adapter.init(); await adapter.setSelectedDevice(devices[0].id); t.after(() => adapter.dispose()); return { ...f, adapter, getDevices: () => devices }; }
test('Poly writes USB telephony LED reports including hold and microphone mute', async t => {
  const f = await ready(t); await f.adapter.setSoftphoneState({ callId: 'c1', ringing: true }); assert.deepEqual(f.reports.at(-1), { id: 2, bytes: [2] });
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true, muted: true, held: true }); assert.deepEqual(f.reports.at(-1), { id: 2, bytes: [13] });
  await f.adapter.setSoftphoneState({}); assert.deepEqual(f.reports.at(-1), { id: 2, bytes: [0] });
});
test('Poly buttons answer, mute/unmute, hold/resume and hang up with no duplicate press', async t => {
  const f = await ready(t), commands = []; f.adapter.onCommand(c => commands.push(c));
  await f.adapter.setSoftphoneState({ callId: 'c1', ringing: true }); f.input(1); f.input(1);
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true }); f.input(3); f.input(7); f.input(3); f.input(1); f.input(0);
  assert.deepEqual(commands.map(c => c.type), ['answer', 'mute', 'hold', 'hold', 'mute', 'hangup']);
  assert.deepEqual(commands.filter(c => c.type === 'mute').map(c => c.muted), [true, false]);
});
test('Poly report layout respects padding and nested collection offsets', () => {
  const f = polyFixture(); const root = f.device.collections[0];
  root.outputReports[0].items.unshift({ reportSize: 3, reportCount: 1, isConstant: true });
  const layout = describePolyReports([{ children: [root] }]); assert.deepEqual(layout.outputs[0].fields.map(f => f.bit), [3, 4, 5, 6]);
});
test('Poly rejects mixed vendor output reports and never mistakes speaker-mute for microphone-mute', () => {
  const f = polyFixture(), root = f.device.collections[0]; root.outputReports[0].items[0].usages[2] = 0x080009;
  const layout = describePolyReports([root]); assert.equal(layout.outputs.length, 0); assert.equal(layout.capabilities.answer, false); assert.equal(layout.capabilities.muteIndicator, false);
});
test('Poly ignores malformed/truncated reports and initial zero cannot hang up or unmute a restored call', async t => {
  const f = await ready(t), commands = []; f.adapter.onCommand(c => commands.push(c));
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true, muted: true, held: true }); f.input(0); assert.equal(commands.length, 0);
});
test('Poly unplug closes control ownership without hanging up; dispose removes HID listeners', async t => {
  const f = await ready(t), commands = []; f.adapter.onCommand(c => commands.push(c));
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true }); f.hidEvents.disconnect({ device: f.device }); f.input(0);
  assert.equal(f.getDevices().length, 0); assert.equal(commands.length, 0); await f.adapter.dispose(); assert.equal(Object.keys(f.hidEvents).length, 0);
});
test('Poly permission cancellation and output failure remain visible and do not claim synchronization', async t => {
  const f = await ready(t); f.hid.requestDevice = async () => { throw new Error('NotAllowedError'); };
  await assert.rejects(f.adapter.requestPermission(), /NotAllowed/);
  f.device.sendReport = async () => { throw new Error('disconnected'); }; await assert.rejects(f.adapter.setSoftphoneState({ active: true }), /disconnected/); assert.equal(f.getDevices()[0].controlReady, false);
});
test('Poly GUI unmute/resume rebase observed absolute buttons for the next physical press', async t => {
 const f=await ready(t),commands=[]; f.adapter.onCommand(c=>commands.push(c));
 await f.adapter.setSoftphoneState({callId:'c',ringing:true}); f.input(1);
 await f.adapter.setSoftphoneState({callId:'c',active:true}); f.input(7);
 await f.adapter.setSoftphoneState({callId:'c',active:true,muted:true,held:true});
 await f.adapter.setSoftphoneState({callId:'c',active:true}); f.input(7);
 assert.equal(commands.filter(c=>c.type==='mute'&&c.muted).length,2);
 assert.equal(commands.filter(c=>c.type==='hold'&&c.held).length,2);
});
test('Poly GUI answer after idle report allows hardware hangup and another incoming answer', async t => {
 const f=await ready(t),commands=[]; f.adapter.onCommand(c=>commands.push(c)); f.input(0);
 await f.adapter.setSoftphoneState({callId:'c',active:true}); f.input(0);
 assert.equal(commands.at(-1).type,'hangup');
 await f.adapter.setSoftphoneState({}); await f.adapter.setSoftphoneState({callId:'r',ringing:true}); f.input(1);
 assert.equal(commands.at(-1).type,'answer');
});
test('Poly input echo during output synchronization never unmutes or resumes a restored call', async t => {
 const f=await ready(t),commands=[]; f.adapter.onCommand(c=>commands.push(c)); f.input(7);
 const send=f.device.sendReport; f.device.sendReport=async(...args)=>{f.input(0);await send(...args);};
 await f.adapter.setSoftphoneState({callId:'c',active:true,muted:true,held:true}); assert.equal(commands.length,0);
});
test('Poly disconnect during open cannot claim a removed device', async t => {
 const f=polyFixture(),adapter=createPolyAdapter({hid:f.hid}); t.after(()=>adapter.dispose()); let inventory,release;
 adapter.onDevicesChange(d=>{inventory=d;}); await adapter.init();
 f.device.open=()=>new Promise(resolve=>{release=()=>{f.device.opened=true;resolve();};});
 const selecting=adapter.setSelectedDevice(inventory[0].id); f.hidEvents.disconnect({device:f.device}); release(); await selecting;
 assert.equal(f.device.opened,false); assert.equal(inventory.length,0);
});
test('Poly late open after timeout closes its handle; reconnect is available for retry', async t => {
 const f=polyFixture(),adapter=createPolyAdapter({hid:f.hid,operationTimeoutMs:10}); t.after(()=>adapter.dispose()); let inventory,release;
 adapter.onDevicesChange(d=>{inventory=d;}); await adapter.init();
 f.device.open=()=>new Promise(resolve=>{release=()=>{f.device.opened=true;resolve();};});
 await assert.rejects(adapter.setSelectedDevice(inventory[0].id),/timed out/); release(); await new Promise(r=>setTimeout(r,0)); assert.equal(f.device.opened,false);
});
test('Poly unplug during an output write does not write subsequent reports', async t => {
 const f=polyFixture(),adapter=createPolyAdapter({hid:f.hid}); t.after(()=>adapter.dispose()); let inventory,release;
 f.device.collections[0].outputReports.push({reportId:3,items:[{reportSize:1,reportCount:1,usages:[0x080020]}]});
 adapter.onDevicesChange(d=>{inventory=d;}); await adapter.init(); await adapter.setSelectedDevice(inventory[0].id);
 const written=[]; f.device.sendReport=id=>{written.push(id);return new Promise(resolve=>{release=resolve;});};
 const writing=adapter.setSoftphoneState({callId:'c',active:true}); await new Promise(r=>setTimeout(r,0)); f.hidEvents.disconnect({device:f.device}); release();
 await assert.rejects(writing,/device changed/); assert.deepEqual(written,[2]);
});

test('Poly reuses an already-open reconnected handle and synchronizes LEDs', async t => {
 const f=polyFixture(), adapter=createPolyAdapter({hid:f.hid});t.after(()=>adapter.dispose());let inventory;
 adapter.onDevicesChange(d=>{inventory=d;});await adapter.init();
 f.device.opened=true;f.device.open=async()=>{throw Error('The device is already open.');};
 await adapter.setSelectedDevice(inventory[0].id);await adapter.setSoftphoneState({ringing:true});
 assert.equal(f.reports.at(-1).bytes[0],2);
});

test('Poly reconnect and manual selection cannot open the HID device concurrently', async t => {
 const f=polyFixture(),adapter=createPolyAdapter({hid:f.hid}),service=createHeadsetControlService({adapters:[adapter]});
 t.after(()=>service.dispose());let pending=false,opens=0;
 f.device.open=async()=>{assert.equal(pending,false,'only one open may run');assert.equal(f.device.opened,false);pending=true;opens++;await new Promise(r=>setTimeout(r,5));f.device.opened=true;pending=false;};
 await service.init();const key='poly:'+service.getDevices()[0].id;await service.selectDevice(key);
 f.device.opened=false;f.hidEvents.disconnect({device:f.device});f.hidEvents.connect({device:f.device});
 await service.selectDevice(key);await service.setSoftphoneState({});
 assert.equal(service.getSnapshot().selectedKey,key);assert.equal(service.getSnapshot().sync,'synced');assert.equal(opens,2);
});
