import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPolyAdapter, describePolyReports } from '../lib/headsets/adapters/poly-adapter.mjs';
import { polyFixture } from './helpers/headset-fixtures.mjs';

// Descriptor captured from the physical 047f:02f7 BT600, not a synthetic
// all-capabilities headset. Input payloads below exclude the native report ID.
const descriptor = JSON.parse(readFileSync(new URL('./fixtures/poly-bt600-02f7.json', import.meta.url)));
async function ready(t) {
  const f = polyFixture();
  Object.assign(f.device, structuredClone(descriptor));
  const adapter = createPolyAdapter({ hid: f.hid });
  let inventory;
  adapter.onDevicesChange(value => { inventory = value; });
  await adapter.init();
  await adapter.setSelectedDevice(inventory[0].id);
  t.after(() => adapter.dispose());
  return { ...f, adapter, inventory };
}

test('captured BT600 has vendor call and hold impulses, relative mute, standard LEDs, no independent wear input', () => {
  const layout = describePolyReports(descriptor.collections, descriptor);
  assert.equal(layout.profile, 'bt600-02f7');
  assert.equal(layout.vendorCallButton, true);
  assert.deepEqual(layout.inputs.find(report => report.id === 21).fields, [{ name: 'callToggle', bit: 0, absolute: false }, { name: 'held', bit: 2, absolute: false }]);
  assert.equal(layout.inputs.find(report => report.id === 1).fields.find(field => field.name === 'muted').absolute, false);
  assert.deepEqual(layout.outputs.map(report => [report.id, report.fields[0].name]).sort((a, b) => a[0] - b[0]), [[1, 'ringing'], [3, 'muted'], [4, 'active'], [5, 'held']]);
  assert.equal(layout.capabilities.hold, true);
  assert.equal(layout.capabilities.holdIndicator, true);
  assert.equal(layout.capabilities.wearingSensor, false);
});

test('BT600 physical call impulses answer and hang up once; standard hook echoes do not control calls', async t => {
  const f = await ready(t), commands = [];
  f.adapter.onCommand(command => commands.push(command));
  f.input([1, 0], 21); f.input([0, 0], 21); // idle press is not a call
  await f.adapter.setSoftphoneState({ callId: 'incoming', ringing: true });
  f.input(1); f.input(0); // standard hook is transport state on this profile
  assert.equal(commands.length, 0);
  f.input([1, 0], 21); f.input([0, 0], 21);
  assert.deepEqual(commands.map(command => command.type), ['answer']);
  await f.adapter.setSoftphoneState({ callId: 'incoming', active: true });
  f.input(1); f.input(0);
  f.input([1, 0], 21); f.input([0, 0], 21);
  assert.deepEqual(commands.map(command => command.type), ['answer', 'hangup']);
  assert(commands.every(command => command.callId === 'incoming'));
});

test('BT600 every mute pulse toggles even when each release is lost during LED writes', async t => {
  const f = await ready(t), commands = [];
  f.adapter.onCommand(command => commands.push(command));
  const send = f.device.sendReport;
  f.device.sendReport = async (...args) => {
    f.input(1); // release arrives during output echo suppression
    await send(...args);
  };
  let muted = false;
  await f.adapter.setSoftphoneState({ callId: 'c', active: true, muted });
  for (let press = 0; press < 4; press++) {
    f.input([2, 0], 21); // accompanying vendor mute pulse must not duplicate it
    f.input(3);
    assert.equal(commands.length, press + 1);
    muted = !muted;
    assert.equal(commands.at(-1).muted, muted);
    await f.adapter.setSoftphoneState({ callId: 'c', active: true, muted });
  }
  assert.deepEqual(commands.map(command => command.muted), [true, false, true, false]);
});

test('BT600 sensor-generated mute uses the same mute command, never invents a wearing or hold event', async t => {
  const f = await ready(t), commands = [];
  f.adapter.onCommand(command => commands.push(command));
  await f.adapter.setSoftphoneState({ callId: 'c', active: true });
  f.input([2, 0], 21); f.input(3); f.input(1); f.input(0, 14);
  assert.deepEqual(commands.map(command => [command.type, command.muted]), [['mute', true]]);
  await f.adapter.setSoftphoneState({ callId: 'c', active: true, muted: true });
  f.input([2, 0], 21); f.input(3); f.input(1); f.input(1, 14);
  assert.deepEqual(commands.map(command => [command.type, command.muted]), [['mute', true], ['mute', false]]);
});

test('BT600 double Call press holds and resumes without toggling mute, including lost releases', async t => {
  const f = await ready(t), commands = [];
  f.adapter.onCommand(command => commands.push(command));
  f.input([4, 0], 21); // Idle: no call to hold.
  await f.adapter.setSoftphoneState({ callId: 'c', ringing: true });
  f.input([4, 0], 21); // Ringing: must not answer or reject.
  assert.equal(commands.length, 0);
  await f.adapter.setSoftphoneState({ callId: 'c', active: true, muted: true });
  f.input([4, 0], 21); f.input([0, 0], 21);
  assert.deepEqual(commands.map(c => [c.type, c.held, c.callId]), [['hold', true, 'c']]);
  const send = f.device.sendReport;
  f.device.sendReport = async (...args) => { f.input([0, 0], 21); await send(...args); };
  await f.adapter.setSoftphoneState({ callId: 'c', active: true, muted: true, held: true });
  f.input([4, 0], 21);
  assert.deepEqual(commands.map(c => [c.type, c.held]), [['hold', true], ['hold', false]]);
  await f.adapter.setSoftphoneState({ callId: 'c', active: true, muted: true, held: false });
  f.input([4, 0], 21);
  assert.deepEqual(commands.map(c => c.held), [true, false, true]);
  assert(commands.every(c => c.type === 'hold' && c.muted === undefined));
  assert(f.reports.filter(r => r.id === 3).slice(-3).every(r => r.bytes[0] === 1));
});

test('BT600 GUI state uses only qualified standard LED outputs, including LED/Mute 09', async t => {
  const f = await ready(t);
  await f.adapter.setSoftphoneState({ callId: 'c', active: true, held: true, muted: true });
  assert.deepEqual([...f.reports].sort((a, b) => a.id - b.id), [{ id: 1, bytes: [0] }, { id: 3, bytes: [1] }, { id: 4, bytes: [1] }, { id: 5, bytes: [1] }]);
  await f.adapter.setSoftphoneState({ callId: 'c', active: true });
  assert.deepEqual(f.reports.at(-1), { id: 3, bytes: [0] });
  assert(f.reports.every(report => [1, 3, 4, 5].includes(report.id)));
});

test('BT600 profile never enables vendor usages or LED/Mute for an unqualified product ID', () => {
  const layout = describePolyReports(descriptor.collections, { ...descriptor, productId: 0xffff });
  assert.equal(layout.vendorCallButton, false);
  assert.equal(layout.capabilities.muteIndicator, false);
  assert.equal(layout.capabilities.hold, false);
  assert(!layout.inputs.some(report => report.id === 21));
  assert(!layout.outputs.some(report => report.id === 3));
});

test('BT600 ignores truncated vendor reports and stops handling impulses after unplug', async t => {
  const f = await ready(t), commands = [];
  f.adapter.onCommand(command => commands.push(command));
  await f.adapter.setSoftphoneState({ callId: 'c', active: true });
  f.input(1, 21); // report 21 requires two bytes
  f.hidEvents.disconnect({ device: f.device });
  f.input([1, 0], 21); f.input(3);
  assert.equal(commands.length, 0);
});
