import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeadsetControlService, normalizeSoftphoneState } from '../lib/headsets/headset-control-service.mjs';
import { fakeAdapter, tick, jabraFixture, eposFixture } from './helpers/headset-fixtures.mjs';

async function serviceFixture(t) {
  const a = fakeAdapter(), b = fakeAdapter('epos');
  const service = createHeadsetControlService({ adapters: [a, b], operationTimeoutMs: 25 });
  t.after(() => service.dispose()); await service.init(); a.devices([{}]); b.devices([{}]);
  return { a, b, service };
}
test('no implicit selection or state fanout; nonselected controls cannot act on a call', async t => {
  const { a, b, service } = await serviceFixture(t); const commands = []; service.onCommand(c => commands.push(c));
  await service.setSoftphoneState({}); assert.equal(a.sent.length + b.sent.length, 0);
  await service.selectDevice('jabra:a');
  await service.setSoftphoneState({ callId: 'c1', active: true });
  b.command({ type: 'mute', muted: true }); a.command({ type: 'mute', muted: true }); await tick();
  assert.equal(b.sent.length, 0); assert.equal(commands.length, 1); assert.equal(commands[0].vendor, 'jabra');
});
test('normalizes call IDs and values', () => {
  assert.deepEqual(normalizeSoftphoneState({ callId: 7, active: 1, muted: false, remoteDisplayName: ' Alice ' }), { callId: '7', active: true, ringing: false, muted: false, held: false, direction: null, remoteDisplayName: 'Alice', remoteNumber: null });
});
test('dedupes duplicate events but preserves rapid mute/unmute intent', async t => {
  const { a, service } = await serviceFixture(t); const commands = []; service.onCommand(c => commands.push(c));
  await service.selectDevice('jabra:a'); await service.setSoftphoneState({ callId: 'c1', active: true });
  a.command({ type: 'mute', muted: true }); a.command({ type: 'mute', muted: true }); a.command({ type: 'mute', muted: false });
  await tick(); assert.deepEqual(commands.map(c => c.muted), [true, false]);
});
test('stale call and stale device events are fenced, including a queued command', async t => {
  const { a, service } = await serviceFixture(t); const commands = []; service.onCommand(c => commands.push(c));
  await service.selectDevice('jabra:a'); await service.setSoftphoneState({ callId: 'c1', active: true });
  a.command({ type: 'hangup', callId: 'old' }); a.command({ type: 'hangup', deviceId: 'other' });
  a.command({ type: 'hangup' }); await service.setSoftphoneState({ callId: 'c2', active: true }); await tick();
  assert.equal(commands.length, 0);
});
test('selection and destructive test actions are unavailable during an outgoing attempt', async t => {
  const { service } = await serviceFixture(t); await service.selectDevice('jabra:a');
  await service.setSoftphoneState({ callId: 'dialing', direction: 'outgoing' });
  await assert.rejects(service.selectDevice('epos:a'), /Finish/); await assert.rejects(service.sendTestCommand('ring'), /no call/);
});
test('audio-only EPOS enumeration cannot be selected for controls', async t => {
  const { b, service } = await serviceFixture(t); b.devices([{ connectionState: 'audio-only', controlReady: false }]);
  await assert.rejects(service.selectDevice('epos:a'), /not ready/);
});
test('inactive vendor disconnect never clears selected device; same-device reconnect restores current state', async t => {
  const { a, b, service } = await serviceFixture(t); await service.selectDevice('jabra:a');
  await service.setSoftphoneState({ callId: 'c1', active: true, muted: true });
  b.devices([]); assert.equal(service.getDevice().vendor, 'jabra');
  a.devices([]); assert.equal(service.getSnapshot().sync, 'disconnected');
  a.devices([{}]); await tick(); assert.equal(service.getSnapshot().sync, 'synced'); assert.equal(a.sent.at(-1).muted, true);
});
test('a saved explicit choice restores only the same device and replays an already ringing call', async t => {
  const a = fakeAdapter(), b = fakeAdapter('epos');
  const service = createHeadsetControlService({ adapters: [a, b], initialSelectedKey: 'epos:saved' });
  t.after(() => service.dispose()); await service.init();
  await service.setSoftphoneState({ callId: 'incoming', ringing: true });
  a.devices([{}]); b.devices([{}]); await tick();
  assert.equal(service.getDevice(), null); assert.equal(a.sent.length + b.sent.length, 0);
  b.devices([{ id: 'saved' }]); await tick();
  assert.equal(service.getSnapshot().sync, 'synced'); assert.deepEqual(b.selected, ['saved']);
  assert.equal(b.sent.at(-1).callId, 'incoming'); assert.equal(b.sent.at(-1).ringing, true);
});
test('disconnect during saved-device restoration cannot publish a false synchronized state', async t => {
  const a = fakeAdapter(); let finishSelection;
  a.setSelectedDevice = () => new Promise(resolve => { finishSelection = resolve; });
  const service = createHeadsetControlService({ adapters: [a], initialSelectedKey: 'jabra:a' });
  t.after(() => service.dispose()); await service.init(); a.devices([{}]); await tick();
  a.devices([]); finishSelection(); await tick();
  assert.equal(service.getSnapshot().sync, 'disconnected'); assert.equal(a.sent.length, 0);
});
test('sync errors are visible and a later update retries; failed init does not block another vendor', async t => {
  const { a, service } = await serviceFixture(t); await service.selectDevice('jabra:a');
  a.setSoftphoneState = async () => { throw new Error('write failed'); };
  await service.setSoftphoneState({ callId: 'c1', active: true }); assert.equal(service.getSnapshot().sync, 'error');
  a.setSoftphoneState = async () => {}; await service.setSoftphoneState({ callId: 'c1', active: true }); assert.equal(service.getSnapshot().sync, 'synced');
  const bad = fakeAdapter('poly'); bad.init = async () => { throw new Error('missing'); };
  const good = fakeAdapter(); let inits = 0; good.init = async () => { inits++; };
  const isolated = createHeadsetControlService({ adapters: [bad, good] }); await isolated.init(); await isolated.init(); assert.equal(inits, 1); await isolated.dispose();
});
test('queued old state snapshots cannot overwrite a newer call', async t => {
  const { a, service } = await serviceFixture(t); await service.selectDevice('jabra:a'); a.sent.length = 0;
  await Promise.all([service.setSoftphoneState({ callId: 'old', ringing: true }), service.setSoftphoneState({ callId: 'new', active: true })]);
  assert.deepEqual(a.sent.map(s => s.callId), ['new']);
});
test('revoke/dispose fences commands and preserves the WebRTC call', async t => {
  const { a, service } = await serviceFixture(t); let commands = 0; service.onCommand(() => commands++);
  await service.selectDevice('jabra:a'); await service.setSoftphoneState({ callId: 'c1', active: true });
  a.command({ type: 'hangup' }); await service.setEnabled(false); await tick(); assert.equal(commands, 0);
  await service.dispose(); a.command({ type: 'answer' }); assert.equal(commands, 0);
});

test('Jabra publishes a device inventory and losing a different device preserves active control', async t => {
  const f = jabraFixture(); t.after(() => f.adapter.dispose()); await f.adapter.init(); await f.adapter.setSelectedDevice('a');
  f.api.deviceAdded.emit({ name: 'Second', serialNumber: 'b' }); f.api.deviceRemoved.emit({ serialNumber: 'b' });
  assert.equal(f.adapter.getDevice().id, 'a'); await f.adapter.setSoftphoneState({ callId: 'c1', active: true }); assert.ok(f.calls.some(c => c[0] === 'start'));
});
test('Jabra GUI state uses incoming/active/mute/hold/end; own synchronous events are not actions', async t => {
  const f = jabraFixture(); const commands = []; t.after(() => f.adapter.dispose()); f.adapter.onCommand(c => commands.push(c));
  f.api.transportContext = 'web-hid';
  await f.adapter.init(); await f.adapter.setSelectedDevice('a'); await f.adapter.requestPermission();
  await f.adapter.setSoftphoneState({ callId: 'c1', ringing: true });
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true, muted: true, held: true });
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true }); await f.adapter.setSoftphoneState({}); await tick();
  assert.deepEqual(f.calls.map(c => c[0]), ['pair', 'ring', 'accept', 'mute', 'hold', 'resume', 'unmute', 'end']); assert.equal(commands.length, 0);
});
test('Jabra hardware answer, mute, hold and hangup are mapped with call identity', async t => {
  const f = jabraFixture(), commands = []; t.after(() => f.adapter.dispose()); f.adapter.onCommand(c => commands.push(c));
  await f.adapter.init(); await f.adapter.setSelectedDevice('a'); await f.adapter.setSoftphoneState({ callId: 'c1', ringing: true });
  f.rings[0](true); await tick();
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true });
  f.control.muteState.emit('muted'); f.control.holdState.emit('on-hold'); f.control.ongoingCalls.emit(1); f.control.ongoingCalls.emit(0);
  assert.deepEqual(commands.map(c => c.type), ['answer', 'mute', 'hold', 'hangup']); assert.ok(commands.every(c => c.callId === 'c1' && c.deviceId === 'a'));
});
test('Jabra rejects from hardware but ignores stale ringing resolution after call replacement', async t => {
  const f = jabraFixture(), commands = []; t.after(() => f.adapter.dispose()); f.adapter.onCommand(c => commands.push(c));
  await f.adapter.init(); await f.adapter.setSelectedDevice('a'); await f.adapter.setSoftphoneState({ callId: 'c1', ringing: true });
  f.rings[0](false); await tick(); assert.equal(commands[0].type, 'reject'); commands.length = 0;
  await f.adapter.setSoftphoneState({ callId: 'c2', ringing: true }); const stale = f.rings.at(-1);
  await f.adapter.setSoftphoneState({ callId: 'c3', ringing: true }); stale(true); await tick(); assert.equal(commands.length, 0);
});
test('Jabra partial failure does not start a second hardware call on retry', async t => {
  const f = jabraFixture(); t.after(() => f.adapter.dispose()); await f.adapter.init(); await f.adapter.setSelectedDevice('a');
  const mute = f.control.mute; f.control.mute = async () => { throw new Error('USB busy'); };
  await assert.rejects(f.adapter.setSoftphoneState({ callId: 'c1', active: true, muted: true }), /USB busy/);
  f.control.mute = mute; await f.adapter.setSoftphoneState({ callId: 'c1', active: true, muted: true }); assert.equal(f.calls.filter(c => c[0] === 'start').length, 1);
});
test('Jabra disconnect removes subscriptions and emits unavailable control', async t => {
  const f = jabraFixture(); t.after(() => f.adapter.dispose()); await f.adapter.init(); await f.adapter.setSelectedDevice('a');
  f.control.onDisconnect.emit(); assert.equal(f.adapter.getDevice().controlReady, false); assert.equal(f.control.muteState.count, 0);
});

test('EPOS waits for successful registration and a real device, ignoring ACK device payloads', async t => {
  const f = eposFixture(); t.after(() => f.adapter.dispose()); await f.adapter.init(); f.discover();
  await assert.rejects(f.adapter.setSelectedDevice(f.device.id), /not ready/);
  f.receive({ Event: 'EstablishConnection', EventType: 'Acknowledgement', ReturnCode: 7 }); assert.equal(f.sent.some(m => m.Event === 'SPLoggedIn'), false);
  f.login(); f.discover(); await f.adapter.setSelectedDevice(f.device.id);
  f.receive({ Event: 'ActiveDeviceChanged', EventType: 'Acknowledgement', ProductName: 'wrong' }); assert.equal(f.device.id, 'epos-a');
});
test('EPOS sends acknowledged incoming, answer, mute, hold, resume, unmute and end', async t => {
  const f = eposFixture(); t.after(() => f.adapter.dispose()); await f.ready(); f.sent.length = 0;
  await f.adapter.setSoftphoneState({ callId: 'c1', ringing: true }); await f.adapter.setSoftphoneState({ callId: 'c1', active: true });
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true, muted: true, held: true }); await f.adapter.setSoftphoneState({ callId: 'c1', active: true }); await f.adapter.setSoftphoneState({});
  assert.deepEqual(f.sent.map(m => m.Event), ['IncomingCall', 'InCallAccepted', 'MuteHeadset', 'CallHold', 'UnmuteHeadset', 'HeldCallResumed', 'CallEnded']);
});
test('EPOS BTD 800 live discovery enables the registered adapter without inventing a paired headset', async t => {
  const f = eposFixture(), commands = []; t.after(() => f.adapter.dispose());
  f.adapter.onCommand(command => commands.push(command)); await f.adapter.init();
  const dongle = { Event: 'HeadsetConnected', EventType: 'Notification',
    HeadsetName: 'Sennheiser BTD 800 USB for Lync', HeadsetPath: 'Sennheiser BTD 800 USB for Lync', HeadsetType: 'Sennheiser BTD 800 USB for Lync' };
  f.receive(dongle); assert.equal(f.device.controlReady, false);
  await assert.rejects(f.adapter.setSelectedDevice(f.device.id), /not ready/);
  f.login(); assert.equal(f.device.controlReady, true); assert.equal(f.device.deviceRole, 'dongle');
  assert.equal(f.device.model, dongle.HeadsetName);
  await f.adapter.setSelectedDevice(f.device.id);
  await f.adapter.setSoftphoneState({ callId: 'dongle-call', ringing: true });
  f.receive({ Event: 'InCallAccepted', EventType: 'Request' });
  assert.equal(commands.at(-1).type, 'answer'); assert.equal(commands.at(-1).deviceId, dongle.HeadsetPath);
  await f.adapter.setSoftphoneState({ callId: 'dongle-call', active: true, muted: true, held: true });
  assert(f.sent.some(m => m.Event === 'MuteHeadset')); assert(f.sent.some(m => m.Event === 'CallHold'));
  f.receive({ Event: 'HeadsetDisconnected', EventType: 'Notification', HeadsetPath: dongle.HeadsetPath });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(f.device.controlReady, false);
  f.receive(dongle); assert.equal(f.device.controlReady, true);
});
test('EPOS BTD 800 browser enumeration alone never grants control readiness', async t => {
  const f = eposFixture({ mediaDevices: { enumerateDevices: async () => [{ kind: 'audioinput', label: 'Sennheiser BTD 800 USB for Lync (1395:002d)', deviceId: 'usb' }] } });
  t.after(() => f.adapter.dispose()); await f.adapter.init(); f.login(); await tick();
  assert.equal(f.device.connectionState, 'audio-only'); assert.equal(f.device.controlReady, false);
  await assert.rejects(f.adapter.setSelectedDevice(f.device.id), /not ready/);
});
test('EPOS discovery never sends an empty ActiveDeviceChanged setter that deselects macOS hardware', async t => {
  let deviceChange;
  const f = eposFixture({ mediaDevices: { enumerateDevices: async () => [], addEventListener: (_event, fn) => { deviceChange = fn; }, removeEventListener() {} } });
  t.after(() => f.adapter.dispose()); await f.ready(); deviceChange();
  f.receive({ Event: 'HeadsetDisconnected', EventType: 'Notification', HeadsetPath: 'epos-a' }); await tick();
  assert.equal(f.sent.some(m => m.Event === 'ActiveDeviceChanged'), false);
});
test('outgoing dialing activates Jabra and EPOS call indicators before the remote party answers', async t => {
  const jabra = jabraFixture(), epos = eposFixture(); t.after(() => Promise.all([jabra.adapter.dispose(), epos.adapter.dispose()]));
  await jabra.adapter.init(); await jabra.adapter.setSelectedDevice('a'); await epos.ready();
  const dialing = { callId: 'dialing', direction: 'outgoing', active: false, ringing: false };
  await jabra.adapter.setSoftphoneState(dialing); await epos.adapter.setSoftphoneState(dialing);
  assert(jabra.calls.some(c => c[0] === 'start')); assert(epos.sent.some(m => m.Event === 'OutgoingCall'));
  await jabra.adapter.setSoftphoneState({}); await epos.adapter.setSoftphoneState({});
  assert(jabra.calls.some(c => c[0] === 'end')); assert(epos.sent.some(m => m.Event === 'CallEnded'));
});
test('EPOS negative ACK leaves failed transition retryable without repeating call start', async t => {
  const f = eposFixture(); t.after(() => f.adapter.dispose()); await f.ready(); f.sent.length = 0;
  f.responses.set('MuteHeadset', 5); await assert.rejects(f.adapter.setSoftphoneState({ callId: 'c1', active: true, muted: true }), /rejected/);
  f.responses.set('MuteHeadset', 0); await f.adapter.setSoftphoneState({ callId: 'c1', active: true, muted: true });
  assert.equal(f.sent.filter(m => m.Event === 'InCallAccepted').length, 1); assert.equal(f.sent.filter(m => m.Event === 'MuteHeadset').length, 2);
});
test('EPOS missing ACK closes the session; late ACK cannot confirm a new command', async t => {
  const f = eposFixture(); t.after(() => f.adapter.dispose()); await f.ready(); f.responses.set('OutgoingCall', null);
  await assert.rejects(f.adapter.setSoftphoneState({ callId: 'c1', direction: 'outgoing', active: true }), /timed out/);
  assert.equal(f.socket.readyState, 3); assert.equal(f.device.connectionState, 'service-missing');
});
test('EPOS button events flow back; ACK echoes and wrong call IDs do not', async t => {
  const f = eposFixture(), commands = []; t.after(() => f.adapter.dispose()); f.adapter.onCommand(c => commands.push(c)); await f.ready();
  await f.adapter.setSoftphoneState({ callId: 'c1', active: true, held: true });
  for (const Event of ['OffHook', 'MuteSoftphone', 'UnmuteSoftphone', 'CallHold', 'HeldCallResumed', 'OnHook']) f.receive({ Event, EventType: 'Request', CallID: 'c1' });
  f.receive({ Event: 'MuteHeadset', EventType: 'Acknowledgement', ReturnCode: 0 }); f.receive({ Event: 'OnHook', EventType: 'Request', CallID: 'old' });
  assert.deepEqual(commands.map(c => [c.type, c.held ?? c.muted]), [['hold', false], ['mute', true], ['mute', false], ['hold', true], ['hold', false], ['hangup', undefined]]);
});
test('EPOS browser audio is reported as audio-only when local service is missing', async t => {
  const f = eposFixture({ mediaDevices: { enumerateDevices: async () => [{ kind: 'audioinput', label: 'Sennheiser SC320 USB CTRL II', deviceId: 'mic' }] } });
  t.after(() => f.adapter.dispose()); await f.adapter.init(); f.login(); await tick();
  assert.equal(f.device.connectionState, 'audio-only'); assert.equal(f.device.controlReady, false); assert.equal(f.device.capabilities.mute, false);
});
test('EPOS ignores another device disconnect and confirms the matching disconnect', async t => {
  const f = eposFixture(); t.after(() => f.adapter.dispose()); await f.ready();
  f.receive({ Event: 'HeadsetDisconnected', EventType: 'Notification', HeadsetPath: 'other' }); await new Promise(r => setTimeout(r, 10)); assert.equal(f.device.id, 'epos-a');
  f.receive({ Event: 'HeadsetDisconnected', EventType: 'Notification', HeadsetPath: 'epos-a' }); await new Promise(r => setTimeout(r, 10)); assert.equal(f.device.connectionState, 'service-connected');
});
test('EPOS reports 0% battery correctly and supports product-ID identity', async t => {
  const f = eposFixture(); t.after(() => f.adapter.dispose()); await f.adapter.init(); f.login(); f.discover({ HeadsetPath: undefined, ProductId: 42, BatteryLevel: 0 });
  assert.equal(f.device.id, '42'); assert.equal(f.device.battery.levelPercent, 0);
});
