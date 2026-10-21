// Test-only transport stand-ins. Real WebRTC, MediaDevices, APIs and audio remain intact.
// This is injected by Puppeteer; it is never imported by application code.
export function installHeadsetTransportProbe() {
  // Simulate USB inventory loss only; capture, RTP and sink APIs remain real.
  const media = navigator.mediaDevices, enumerate = media.enumerateDevices.bind(media);
  let audioVisible = true;
  media.enumerateDevices = async () => (await enumerate()).filter(device => audioVisible || !['audioinput','audiooutput'].includes(device.kind));
  const reports = [], jabraReports = [], eposMessages = [], signaling = [], events = new EventTarget();
  const item = usages => ({ usages, reportSize: 1, reportCount: usages.length, isAbsolute: true, isArray: false, isConstant: false });
  const device = new EventTarget();
  Object.assign(device, { vendorId: 0x047f, productId: 1, productName: 'Poly USB test transport', opened: false,
    collections: [{ usagePage: 0x0b, usage: 5, inputReports: [{ reportId: 1, items: [item([0x0b0020, 0x0b002f, 0x0b0023, 0x0b0026])] }], outputReports: [{ reportId: 2, items: [item([0x080017, 0x080018, 0x080021, 0x080020])] }] }],
    async open() { this.opened = true; }, async close() { this.opened = false; }, async sendReport(id, data) { reports.push({ id, bytes: [...data], at: Date.now() }); },
  });
  // Exercise the actual Jabra SDK (discovery, ECC state machine, HID parsing and
  // acknowledgements), replacing only the physical USB endpoint.
  let jabraBits = 0;
  const jabra = new EventTarget();
  const jabraInput = bits => { jabraBits = bits; jabra.oninputreport?.({ currentTarget: jabra, reportId: 1, data: new DataView(Uint8Array.of(bits).buffer) }); };
  Object.assign(jabra, { vendorId: 0x0b0e, productId: 0x9999, productName: 'Jabra USB SDK test transport', opened: false,
    collections: [{ usagePage: 0x0b, usage: 5, children: [], featureReports: [],
      inputReports: [{ reportId: 1, items: [item([0xff300020]), { ...item([0xff30002f, 0xff300021, 0xff30fffd]), isAbsolute: false }] }],
      outputReports: [{ reportId: 2, items: [item([0xff400017, 0xff400018, 0xff400021, 0xff400020])] }] }],
    async open() { this.opened = true; }, async close() { this.opened = false; },
    async sendReport(id, data) {
      const bits = new Uint8Array(data.buffer || data)[0], previous = jabraReports.at(-1)?.bytes[0] || 0;
      jabraReports.push({ id, bytes: [bits], at: Date.now() });
      // The hook is absolute; mute, flash and reject are momentary buttons.
      // A mute LED write must not masquerade as a user pressing mute.
      if ((bits & 1) !== (previous & 1)) setTimeout(() => jabraInput((jabraBits & 14) | (bits & 1)), 0);
      if ((bits & 8) !== (previous & 8)) setTimeout(() => { jabraInput(jabraBits & ~4); jabraInput(jabraBits | 4); setTimeout(() => jabraInput(jabraBits & ~4), 1); }, 5);
    },
  });
  Object.assign(events, { getDevices: async () => [device, jabra], requestDevice: async () => [device, jabra] });
  Object.defineProperty(navigator, 'hid', { configurable: true, value: events });
  const NativeSocket = window.WebSocket; let socket;
  class EposSocket {
    constructor() { socket = this; this.readyState = 1; setTimeout(() => { this.onopen?.(); this.receive('SocketConnected', 'Notification'); }, 20); }
    receive(Event, EventType = 'Request', fields = {}) { this.onmessage?.({ data: JSON.stringify({ Event, EventType, ReturnCode: 0, ...fields }) }); }
    send(raw) {
      const message = JSON.parse(raw); eposMessages.push({ ...message, at: Date.now() });
      queueMicrotask(() => {
        this.receive(message.Event, 'Acknowledgement', { CallID: message.CallID });
        if (message.Event === 'SPLoggedIn') this.receive('HeadsetConnected', 'Notification', { HeadsetPath: 'epos-fixture', ProductName: 'Sennheiser SC230 USB CTRL II (test transport)' });
      });
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  window.WebSocket = new Proxy(NativeSocket, { construct(target, args) {
    if (String(args[0]).startsWith('wss://127.0.0.1:41088')) return new EposSocket();
    const real = Reflect.construct(target, args);
    if (String(args[0]).includes('rtc.telnyx.com')) real.addEventListener('message', e => {
      try { const m = JSON.parse(e.data), p = m.params || {};
        signaling.push({ method: m.method, error: m.error?.message, code: m.error?.code, cause: p.cause, causeCode: p.causeCode, callId: p.callID });
      } catch { /* Only structured, credential-free signaling evidence. */ }
    });
    return real;
  } });
  window.__headsetFixture = {
    reports, jabraReports, eposMessages, signaling,
    jabraDisconnect() { events.ondisconnect?.({ device: jabra }); },
    jabra(action) {
      if (action === 'answer') jabraInput(jabraBits | 1);
      if (action === 'hangup') jabraInput(jabraBits & ~1);
      if (action === 'mute' || action === 'unmute') { jabraInput(jabraBits | 2); setTimeout(() => jabraInput(jabraBits & ~2), 20); }
      if (action === 'hold' || action === 'resume') { jabraInput(jabraBits | 4); setTimeout(() => jabraInput(jabraBits & ~4), 20); }
      if (action === 'reject') { jabraInput(jabraBits | 8); setTimeout(() => jabraInput(jabraBits & ~8), 20); }
    },
    audioDevices(visible) { audioVisible = visible; media.dispatchEvent(new Event('devicechange')); },
    poly(bits) { const event = new Event('inputreport'); Object.assign(event, { reportId: 1, data: new DataView(Uint8Array.of(bits).buffer) }); device.dispatchEvent(event); },
    epos(event) { socket.receive(event); },
    unplug() { const event = new Event('disconnect'); event.device = device; events.dispatchEvent(event); },
    plug() { const event = new Event('connect'); event.device = device; events.dispatchEvent(event); },
  };
}
