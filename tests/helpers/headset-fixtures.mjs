import { createEposAdapter } from '../../lib/headsets/adapters/epos-adapter.mjs';
import { createJabraAdapter } from '../../lib/headsets/adapters/jabra-adapter.mjs';
export const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export function observable(initial) {
  const listeners = new Set();
  return { subscribe(fn) { listeners.add(fn); if (initial !== undefined) fn(initial); return { unsubscribe: () => listeners.delete(fn) }; }, emit(value) { if (initial !== undefined) initial = value; for (const fn of listeners) fn(value); }, get count() { return listeners.size; } };
}
export function fakeAdapter(vendor = 'jabra') {
  let commands, changed;
  const sent = [], selected = [];
  return { vendor, sent, selected, init: async () => {}, dispose: async () => {},
    setSoftphoneState: async state => { sent.push(state); }, setSelectedDevice: async id => { selected.push(id); },
    onDevicesChange(fn) { changed = fn; return () => { changed = null; }; },
    onCommand(fn) { commands = fn; return () => { commands = null; }; },
    devices(list) { changed?.(list.map(d => ({ id: 'a', vendor, connectionState: 'connected', controlReady: true, ...d }))); },
    command(value) { commands?.(value); },
  };
}
export function jabraFixture(options = {}) {
  const device = { name: 'Jabra fixture', productId: 1, serialNumber: 'a' }, calls = [], rings = [], initialStates = [];
  const control = { ongoingCalls: observable(0), muteState: observable('unmuted'), holdState: observable('not-on-hold'), swapRequest: observable(), onDisconnect: observable(),
    signalIncomingCall(ms) { calls.push(['ring', ms]); return new Promise(resolve => rings.push(resolve)); },
    async acceptIncomingCall() { calls.push(['accept']); rings.at(-1)?.(true); control.ongoingCalls.emit(1); },
    async rejectIncomingCall() { calls.push(['reject']); rings.at(-1)?.(false); },
    async startCall() { calls.push(['start']); control.ongoingCalls.emit(1); },
    async endCall() { calls.push(['end']); control.ongoingCalls.emit(0); },
    async mute() { calls.push(['mute']); control.muteState.emit('muted'); },
    async unmute() { calls.push(['unmute']); control.muteState.emit('unmuted'); },
    async hold() { calls.push(['hold']); control.holdState.emit('on-hold'); },
    async resume() { calls.push(['resume']); control.holdState.emit('not-on-hold'); },
    teardown() { calls.push(['teardown']); },
  };
  const api = { transportContext: 'chrome-extension', deviceAdded: observable(device), deviceRemoved: observable(), start: async () => {} };
  const sdk = { RequestedBrowserTransport: { CHROME_EXTENSION_WITH_WEB_HID_FALLBACK: 'fallback' }, createApi: async () => api,
    EasyCallControlFactory: class { supportsEasyCallControl() { return true; } async createMultiCallControl(_device, initial) {
      initialStates.push(initial); control.ongoingCalls.emit(initial?.ongoingCalls || 0);
      control.muteState.emit(initial?.muted ? 'muted' : 'unmuted'); control.holdState.emit(initial?.onHold ? 'on-hold' : 'not-on-hold'); return control;
    } }, webHidPairing: async () => calls.push(['pair']) };
  return { device, control, calls, rings, api, sdk, initialStates, adapter: createJabraAdapter({ jabra: sdk, partnerKey: 'test-key', ...options }) };
}
export function eposFixture(options = {}) {
  const sent = [], sockets = [], responses = new Map();
  let current;
  class Socket {
    constructor() { current = this; sockets.push(this); this.readyState = 1; queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw); sent.push(message);
      if (['EstablishConnection', 'SPLoggedIn', 'SystemInformation', 'ActiveDeviceChanged', 'SPLoggedOut', 'TerminateConnection'].includes(message.Event)) return;
      const code = responses.has(message.Event) ? responses.get(message.Event) : 0;
      if (code !== null) queueMicrotask(() => this.receive({ Event: message.Event, EventType: 'Acknowledgement', ReturnCode: code, CallID: message.CallID }));
    }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const adapter = createEposAdapter({ WebSocketImpl: Socket, reconnectDelayMs: 0, mediaDevices: null, disconnectConfirmationMs: 5, transientDisconnectGraceMs: 0, acknowledgementTimeoutMs: 25, ...options });
  let device; adapter.onDeviceChange(d => { device = d; });
  return { adapter, sent, sockets, responses, get socket() { return current; }, get device() { return device; },
    receive(value) { current.receive(value); },
    login() { for (const Event of ['SocketConnected', 'EstablishConnection', 'SPLoggedIn']) current.receive({ Event, EventType: Event === 'SocketConnected' ? 'Notification' : 'Acknowledgement', ReturnCode: 0 }); },
    discover(extra = {}) { current.receive({ Event: 'HeadsetConnected', EventType: 'Notification', ProductName: 'Sennheiser SC320 USB CTRL II', HeadsetPath: 'epos-a', ...extra }); },
    async ready() { await adapter.init(); this.login(); this.discover(); await adapter.setSelectedDevice(device.id); },
  };
}
export function polyFixture() {
  const listeners = {}, reports = [];
  const item = usages => ({ usages, reportSize: 1, reportCount: usages.length, isAbsolute: true, isArray: false, isConstant: false });
  const device = { vendorId: 0x047f, productId: 1, productName: 'Poly fixture', opened: false,
    collections: [{ usagePage: 0x0b, usage: 5, inputReports: [{ reportId: 1, items: [item([0x0b0020, 0x0b002f, 0x0b0023, 0x0b0026])] }], outputReports: [{ reportId: 2, items: [item([0x080017, 0x080018, 0x080021, 0x080020])] }] }],
    addEventListener(name, fn) { listeners[name] = fn; }, removeEventListener(name) { delete listeners[name]; }, async open() { this.opened = true; }, async close() { this.opened = false; },
    async sendReport(id, bytes) { reports.push({ id, bytes: [...bytes] }); },
  };
  const hidEvents = {};
  const hid = { getDevices: async () => [device], requestDevice: async () => [device], addEventListener(name, fn) { hidEvents[name] = fn; }, removeEventListener(name) { delete hidEvents[name]; } };
  return { device, hid, hidEvents, reports, input(bits, reportId = 1) { listeners.inputreport?.({ reportId, data: new DataView(Uint8Array.from(Array.isArray(bits) ? bits : [bits]).buffer) }); } };
}
