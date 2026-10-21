import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { installHeadsetPermissions, isHeadset } = createRequire(import.meta.url)('../tools/contact-center-desktop/headset-permissions.cjs');
const origin = 'https://cc.example.test';
const headset = (vendorId = 0x047f, deviceId = 'phone') => ({ deviceId, vendorId, productId: 0x02f7, collections: [{ usagePage: 11 }] });
function fixture(chooseDevice = async devices => devices[1]) {
  const session = new EventEmitter(), wc = new EventEmitter();
  let url = `${origin}/agent/desktop`;
  wc.getURL = () => url; wc.isDestroyed = () => false; wc.mainFrame = { url };
  session.setPermissionCheckHandler = handler => { session.check = handler; };
  session.setPermissionRequestHandler = handler => { session.request = handler; };
  session.setDevicePermissionHandler = handler => { session.device = handler; };
  installHeadsetPermissions({ session, webContents: wc, origin, chooseDevice });
  return { session, wc, navigate(value) { url = value; wc.mainFrame.url = value; } };
}
test('desktop discovers headset HID for all supported vendors, without granting other hardware or origins', () => {
  const { session, wc, navigate } = fixture();
  for (const vendorId of [0x047f, 0x0b0e, 0x1395]) {
    assert.equal(session.check(wc, 'hid', origin), true);
    assert.equal(session.device({ deviceType: 'hid', origin, device: headset(vendorId) }), true);
  }
  for (const device of [headset(1), { ...headset(), collections: [{ usagePage: 1, usage: 6 }] }, { ...headset(), collections: undefined }])
    assert.equal(session.device({ deviceType: 'hid', origin, device }), false);
  assert.equal(session.device({ deviceType: 'usb', origin, device: headset() }), false);
  assert.equal(session.device({ deviceType: 'hid', origin: 'https://cc.example.test.evil.test', device: headset() }), false);
  assert.equal(session.check({}, 'hid', origin), false);
  assert.equal(session.check(wc, 'serial', origin), false);
  assert.equal(session.check(wc, 'loopback-network', origin), true);
  assert.equal(session.check(wc, 'loopback-network', 'https://other.example.test'), false);
  assert.equal(session.check(wc, 'local-network', origin), false);
  assert.equal(session.check(wc, 'hid', 'null'), false);
  navigate('https://different.example.test');
  assert.equal(session.device({ deviceType: 'hid', origin, device: headset() }), false);
});
test('desktop retains audio permissions and recognizes nested telephony collections', () => {
  const { session, wc } = fixture();
  let granted;
  session.request(wc, 'media', value => { granted = value; }, { requestingUrl: `${origin}/signin` });
  assert.equal(granted, true);
  session.request(wc, 'media', value => { granted = value; }, { requestingUrl: 'https://other.example.test' });
  assert.equal(granted, false);
  assert(isHeadset({ ...headset(), collections: [{ usagePage: 0xff00, children: [{ usagePage: 11 }] }] }));
});
test('desktop Add headset selects a unique device or asks which one, rejects subframes, cleans up listener', async () => {
  const { session, wc } = fixture();
  const invoke = (frame, list) => new Promise(resolve => session.emit('select-hid-device', { preventDefault() {} }, { frame, deviceList: list }, resolve));
  assert.equal(await invoke(wc.mainFrame, [headset()]), 'phone');
  assert.equal(await invoke(wc.mainFrame, [headset(0x0b0e, 'one'), headset(0x0b0e, 'two')]), 'two');
  assert.equal(await invoke({ url: origin }, [headset()]), '');
  assert.equal(await invoke(wc.mainFrame, [headset(42)]), '');
  wc.emit('destroyed');
  assert.equal(session.listenerCount('select-hid-device'), 0);
});
test('desktop rejects a device selection after navigation or cancellation', async () => {
  let resolveChoice;
  const f = fixture(() => new Promise(resolve => { resolveChoice = resolve; }));
  const list = [headset(0x047f, 'one'), headset(0x047f, 'two')];
  const result = new Promise(resolve => f.session.emit('select-hid-device', { preventDefault() {} }, { frame: f.wc.mainFrame, deviceList: list }, resolve));
  f.navigate('https://other.example.test'); resolveChoice(list[0]); assert.equal(await result, '');
});
