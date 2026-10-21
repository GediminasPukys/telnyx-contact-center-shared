import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCallStateActions, createHeadsetCommandController, headsetCallInProgress } from '../lib/headsets/call-controller.mjs';

test('headset control lock follows call lifecycle even when a terminal SDK object is retained', () => {
  assert.equal(headsetCallInProgress(null, 'active'), false);
  for (const status of ['ringing', 'trying', 'requesting', 'active', 'held', 'recovering', undefined]) {
    assert.equal(headsetCallInProgress({ id: 'call' }, status), true);
  }
  for (const status of ['idle', 'hangup', 'ended', 'destroy', 'purge', 'terminated', 'done', 'failed']) {
    assert.equal(headsetCallInProgress({ state: 'active' }, status), false);
    assert.equal(headsetCallInProgress({ state: status }, 'active'), false);
  }
});
import { createAudioRouter } from '../lib/headsets/audio-routing.mjs';
import { headsetPolicy, parseHeadsetSettings } from '../lib/headsets/policy.mjs';
import { tick } from './helpers/headset-fixtures.mjs';
function callFixture() {
  const ops = [], call = { id: 'c1', state: 'active', muteAudio: async () => ops.push('mute'), unmuteAudio: async () => ops.push('unmute'), hold: async () => { ops.push('hold'); call.state = 'held'; }, unhold: async () => { ops.push('resume'); call.state = 'active'; } };
  const state = { call, status: 'active', ui: { isMuted: false, isHeld: false }, contactCenter: { interactionId: 'i1' }, setMuted(v) { state.ui.isMuted = v; }, setHeld(v) { state.ui.isHeld = v; }, updateStatus(v) { state.status = v; } };
  const actions = createCallStateActions({ getState: () => state, submitHold: async (_id, action) => ops.push(action === 'hold' ? 'core-hold' : 'core-resume') });
  return { state, call, ops, actions };
}
test('shared explicit setters serialize rapid mute and hold changes from GUI and hardware', async () => {
  const f = callFixture(); await Promise.all([f.actions.setMuted(true), f.actions.setMuted(true), f.actions.setMuted(false), f.actions.setHeld(true), f.actions.setHeld(false)]);
  assert.deepEqual(f.ops, ['mute', 'unmute', 'hold', 'core-hold', 'resume', 'core-resume']); assert.deepEqual(f.state.ui, { isMuted: false, isHeld: false });
});
test('failed hold intent reverses WebRTC hold and keeps UI confirmed state', async () => {
  const f = callFixture(); const actions = createCallStateActions({ getState: () => f.state, submitHold: async () => { throw new Error('HTTP 500'); } });
  await assert.rejects(actions.setHeld(true), /500/); assert.equal(f.state.ui.isHeld, false); assert.equal(f.call.state, 'active');
});
test('Telnyx resolved false hold is a failure, never an optimistic GUI success', async () => {
  const f = callFixture(); f.call.hold = async () => false;
  await assert.rejects(f.actions.setHeld(true), /did not confirm/); assert.equal(f.state.ui.isHeld, false); assert.deepEqual(f.ops, []);
});
test('pending controls for an old call cannot change a replacement call', async () => {
  const f = callFixture(); const operation = f.actions.setMuted(true); f.state.call = { id: 'c2' }; await operation; assert.deepEqual(f.ops, []);
});
test('consultation blocks ambiguous hardware hold without a target guess', async () => {
  const f = callFixture(); f.state.consultInProgress = true; await assert.rejects(f.actions.setHeld(true), /transfer/); assert.deepEqual(f.ops, []);
});
test('command controller dedupes answers and rejects stale generations', async () => {
  const f = callFixture(); f.state.ui.isRinging = true; let answers = 0, current = true;
  const controller = createHeadsetCommandController({ getState: () => f.state, getHandlers: () => ({ answer: async () => answers++ }), isCurrent: () => current });
  await Promise.all([controller.execute({ type: 'answer', callId: 'c1' }), controller.execute({ type: 'answer', callId: 'c1' })]); assert.equal(answers, 1);
  current = false; await controller.execute({ type: 'answer', callId: 'c2' }); assert.equal(answers, 1);
});
test('failed command remains retryable and reports its error', async () => {
  const f = callFixture(); f.state.ui.isRinging = true; let fail = true, errors = 0, answers = 0;
  const controller = createHeadsetCommandController({ getState: () => f.state, getHandlers: () => ({ answer: async () => { if (fail) throw Error('failed'); answers++; } }), onError: () => errors++ });
  await assert.rejects(controller.execute({ type: 'answer', callId: 'c1' }), /failed/); fail = false;
  await controller.execute({ type: 'answer', callId: 'c1' }); assert.equal(answers, 1); assert.equal(errors, 1);
});
test('audio route changes the real sender and sole remote element, persists, and preserves microphone mute', async () => {
  const ops = []; let saved; const call = { setAudioInDevice: async (id, muted) => ops.push([id, muted]) }, client = { setAudioSettings: async settings => ops.push(settings) }, el = { setSinkId: async id => ops.push(id) };
  const router = createAudioRouter({ getCall: () => call, getClient: () => client, getMuted: () => true, storage: { setItem: (_k, v) => { saved = v; } } }); router.registerElement(el);
  await router.setRoute({ inputId: 'usb-mic', outputId: 'usb-speaker' }); assert.deepEqual(ops, [['usb-mic', true], { micId: 'usb-mic' }, 'usb-speaker']); assert.equal(JSON.parse(saved).outputId, 'usb-speaker');
  await router.setRoute({ inputId: '', outputId: '' }); assert.equal(ops.at(-1), 'default');
});
test('audio loss mutes the sender and receiver; reconnection never unmutes the microphone', async () => {
  const ops = []; let muted = false; const call = { muteAudio: async () => { muted = true; ops.push('mute'); }, setAudioInDevice: async (_id, value) => ops.push(value) };
  const router = createAudioRouter({ getCall: () => call, getClient: () => null, getMuted: () => muted }); const el = { setSinkId: async () => {} }; router.registerElement(el);
  await router.setRoute({ inputId: 'usb-mic', outputId: 'usb-speaker' }); await router.checkDevices([]); assert.equal(el.muted, true); assert.equal(muted, true);
  await router.setRoute({ inputId: 'reconnected', outputId: 'reconnected' }); assert.equal(el.muted, false); assert.equal(ops.at(-1), true);
});
test('a swallowed Telnyx microphone error is detected and route is not falsely saved', async () => {
  const call = { options: { micId: 'old' }, setAudioInDevice: async () => {}, muteAudio: async () => {} };
  const router = createAudioRouter({ getCall: () => call, getClient: () => null, getMuted: () => false });
  await assert.rejects(router.setRoute({ inputId: 'missing' }), /could not switch/); assert.equal(router.getSnapshot().inputId, ''); assert.equal(router.getSnapshot().outputBlocked, true);
});
const usbDevices = [{ kind: 'audioinput', deviceId: 'usb-mic' }, { kind: 'audiooutput', deviceId: 'usb-speaker' }];
function reconnectFixture() {
  const ops = []; let muted = false, fail = false;
  const call = { state: 'active', muteAudio: async () => { muted = true; }, setAudioInDevice: async (id, value) => ops.push(['input', id, value]) };
  const client = { setAudioSettings: async settings => ops.push(['settings', settings.micId]) };
  const el = { setSinkId: async id => { ops.push(['output', id]); if (fail) throw Error('Speaker permission denied'); } };
  const f = { call, client, el, ops, setFail: value => { fail = value; }, muted: () => muted };
  f.router = createAudioRouter({ getCall: () => f.call, getClient: () => client, getMuted: () => muted }); f.router.registerElement(el);
  return f;
}
test('system audio returns after complete device loss and preserves safety mute', async () => {
  const f = reconnectFixture(); await f.router.setRoute({ inputId: 'usb-mic', outputId: 'usb-speaker' });
  await f.router.checkDevices([]); assert.match(f.router.getSnapshot().error, /No microphone|No speaker|Switching/); assert.equal(f.el.muted, true);
  f.ops.length = 0; await f.router.checkDevices(usbDevices);
  assert.equal(f.router.getSnapshot().error, null); assert.equal(f.el.muted, false); assert.equal(f.muted(), true);
  assert.deepEqual(f.ops, [['input', 'default', true], ['settings', 'default'], ['output', 'default']]);
  f.ops.length = 0; await f.router.checkDevices(usbDevices); assert.deepEqual(f.ops, []);
});
test('idle fallback clears the warning without acquiring a microphone', async () => {
  const f = reconnectFixture(); f.call = null; await f.router.setRoute({ inputId: 'usb-mic', outputId: 'usb-speaker' });
  await f.router.checkDevices([]); f.ops.length = 0; await f.router.checkDevices(usbDevices);
  assert.equal(f.router.getSnapshot().error, null); assert.deepEqual(f.ops, [['settings', 'default'], ['output', 'default']]);
});
test('fallback waits for both microphone and speaker, then uses the system route', async () => {
  const f = reconnectFixture(); await f.router.setRoute({ inputId: 'usb-mic', outputId: 'usb-speaker' }); await f.router.checkDevices([]);
  await f.router.checkDevices([usbDevices[0]]); assert.match(f.router.getSnapshot().error, /No microphone|No speaker|Switching/); assert.equal(f.el.muted, true);
  await f.router.checkDevices([{ kind: 'audioinput', deviceId: 'other-mic' }, { kind: 'audiooutput', deviceId: 'other-speaker' }]);
  assert.equal(f.router.getSnapshot().error, null);
  assert.equal(f.router.getSnapshot().inputId, 'default');
  assert.equal(f.router.getSnapshot().outputId, 'default');
});
test('failed reconnect remains blocked and visible until route restoration succeeds', async () => {
  const f = reconnectFixture(); await f.router.setRoute({ inputId: 'usb-mic', outputId: 'usb-speaker' }); await f.router.checkDevices([]); f.setFail(true);
  await f.router.checkDevices(usbDevices); assert.match(f.router.getSnapshot().error, /permission denied/); assert.equal(f.el.muted, true);
  f.setFail(false); await f.router.checkDevices(usbDevices); assert.equal(f.router.getSnapshot().error, null); assert.equal(f.el.muted, false);
});
test('USB recovery waits until call negotiation ends', async () => {
  const f = reconnectFixture(); await f.router.setRoute({ inputId: 'usb-mic', outputId: 'usb-speaker' }); await f.router.checkDevices([]);
  f.call.state = 'trying'; f.ops.length = 0; await f.router.checkDevices(usbDevices);
  assert.deepEqual(f.ops, []); assert.match(f.router.getSnapshot().error, /No microphone|No speaker|Switching/);
  f.call.state = 'active'; await f.router.applyToCall(); assert.equal(f.router.getSnapshot().error, null); assert.equal(f.el.muted, false);
});
test('a device disappearing during asynchronous recovery cannot unblock the output', async () => {
  const f = reconnectFixture(); await f.router.setRoute({ inputId: 'usb-mic', outputId: 'usb-speaker' }); await f.router.checkDevices([]);
  let release, started; const pending = new Promise(resolve => { started = resolve; });
  f.call.setAudioInDevice = () => new Promise(resolve => { release = resolve; started(); });
  const restore = f.router.checkDevices(usbDevices); await pending;
  const unplug = f.router.checkDevices([]); release(); await Promise.all([restore, unplug]);
  assert.equal(f.el.muted, true); assert.match(f.router.getSnapshot().error, /No microphone|No speaker|Switching/);
});
test('healthy device enumeration does not erase unrelated audio errors', async () => {
  const f = reconnectFixture(); f.setFail(true); await assert.rejects(f.router.setRoute({ outputId: 'usb-speaker' }));
  const error = f.router.getSnapshot().error; await f.router.checkDevices(usbDevices); assert.equal(f.router.getSnapshot().error, error);
});
test('old async audio selection cannot configure a new call', async () => {
  let call = {}; const router = createAudioRouter({ getCall: () => call, getClient: () => null, getMuted: () => false });
  const pending = router.setRoute({ inputId: 'mic' }); call = {}; await assert.rejects(pending, /call changed/);
});
test('saved microphone is deferred until media exists; changing it while dialing cannot interrupt negotiation', async () => {
  const replaced = [], defaults = [], call = { state: 'trying', setAudioInDevice: async id => replaced.push(id) };
  const router = createAudioRouter({ getCall: () => call, getClient: () => ({ setAudioSettings: settings => defaults.push(settings) }), getMuted: () => false, storage: { getItem: () => JSON.stringify({ inputId: 'usb' }) } });
  await router.applyToCall(); assert.deepEqual(replaced, []); assert.deepEqual(defaults, [{ micId: 'usb' }]);
  await assert.rejects(router.setRoute({ inputId: 'another' }), /Wait for the call/); assert.deepEqual(replaced, []);
  call.state = 'active'; await router.applyToCall(); assert.deepEqual(replaced, ['usb']);
});
test('an explicit failed answer remains retryable', async () => {
  const f = callFixture(); f.state.ui.isRinging = true; let succeed = false;
  const controller = createHeadsetCommandController({ getState: () => f.state, getHandlers: () => ({ answer: async () => succeed }) });
  await assert.rejects(controller.execute({ type: 'answer', callId: 'c1' }), /failed/);
  succeed = true; await controller.execute({ type: 'answer', callId: 'c1' });
});
test('entitlement is independent of experimental flags, with global and per-vendor runtime disable', () => {
  assert.equal(headsetPolicy({ id: 1, experimental_features: true }).enabled, true);
  assert.equal(headsetPolicy({ id: 1, experimental_features: true, headset_controls_enabled: false }).enabled, false);
  assert.equal(headsetPolicy({ id: 1, headset_controls_enabled: true }, { headsets: { enabled: false } }).enabled, false);
  assert.deepEqual(headsetPolicy({ id: 1, headset_controls_enabled: true }, { headsets: { disabledVendors: ['epos'] } }).vendors, ['jabra', 'poly']);
  assert.throws(() => parseHeadsetSettings({ enabled: 'true', disabledVendors: [] })); assert.throws(() => parseHeadsetSettings({ enabled: true, disabledVendors: ['other'] }));
});
