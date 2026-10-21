import { normalizeSoftphoneState, withHeadsetTimeout } from "../headset-control-service.mjs";

// USB-IF HID Usage Tables, Telephony (0x0b) and LED (0x08) pages.
// Standard usages by default; the BT600 profile is qualified separately below.
const INPUT = new Map([[0x0b0020, "hook"], [0x0b0023, "held"], [0x0b0026, "drop"], [0x0b002f, "muted"]]);
const OUTPUT = new Map([[0x080017, "active"], [0x080018, "ringing"], [0x080020, "held"], [0x080021, "muted"]]);
const POLY_VENDOR_ID = 0x047f;

export function describePolyReports(collections = [], identity = {}) {
  // Captured on BT600 USB-A 047f:02f7 with Voyager Focus UC and Poly Studio.
  // Studio routes the call button to PLT HID 2.0 B7 instead of Telephony/Hook.
  // Read that button without changing device mode or writing vendor reports.
  const bt600 = identity.vendorId === POLY_VENDOR_ID && identity.productId === 0x02f7;
  const inputMapping = new Map(INPUT);
  const outputMapping = new Map(OUTPUT);
  if (bt600) {
    inputMapping.set(0xffa200b7, "callToggle");
    // Focus UC 715 with BT600: a double Call press emits a B3 hold/resume
    // impulse (report 21 bit 2), separately from the B5/standard mute pulse.
    inputMapping.set(0xffa200b3, "held");
    // This endpoint uses LED/Mute (09), not LED/Microphone (21).
    outputMapping.set(0x080009, "muted");
  }
  const inputs = new Map(), outputs = new Map();
  function visit(collection) {
    for (const [kind, reports, mapping] of [["inputReports", inputs, inputMapping], ["outputReports", outputs, outputMapping]]) {
      for (const report of collection[kind] || []) {
        const layout = reports.get(report.reportId) || { id: report.reportId, bits: 0, fields: [], items: [], safe: true };
        for (const item of report.items || []) {
          // Descriptor metadata only; never retain input payloads or identifiers.
          layout.items.push({ reportSize: item.reportSize, reportCount: item.reportCount, usages: item.usages,
            usageMinimum: item.usageMinimum, usageMaximum: item.usageMaximum,
            isConstant: item.isConstant, isArray: item.isArray, isAbsolute: item.isAbsolute });
          const size = Number(item.reportSize), count = Number(item.reportCount);
          if (!Number.isInteger(size) || !Number.isInteger(count) || size < 1 || size > 32 || count < 1 || size * count > 8192) { layout.safe = false; continue; }
          for (let index = 0; index < count; index++) {
            const usage = item.usages?.[index] ?? (item.usageMinimum != null && item.usageMinimum + index <= item.usageMaximum ? item.usageMinimum + index : null);
            const name = mapping.get(usage);
            if (!item.isConstant) {
              if (name && !item.isArray && size === 1) layout.fields.push({ name, bit: layout.bits + index * size, absolute: item.isAbsolute !== false });
              else if (kind === "outputReports") layout.safe = false;
            }
          }
          layout.bits += size * count;
        }
        reports.set(layout.id, layout);
      }
    }
    for (const child of collection.children || []) visit(child);
  }
  collections.forEach(visit);
  const readable = [...inputs.values()].filter(r => r.safe && r.fields.length);
  const writable = [...outputs.values()].filter(r => r.safe && r.fields.length);
  const hasIn = name => readable.some(r => r.fields.some(f => f.name === name));
  const hasOut = name => writable.some(r => r.fields.some(f => f.name === name));
  const vendorCallButton = bt600 && hasIn("callToggle");
  return { inputs: readable, outputs: writable, profile: bt600 ? "bt600-02f7" : "standard-telephony", vendorCallButton,
    excludedReports: { inputs: [...inputs.values()].filter(r => !readable.includes(r)), outputs: [...outputs.values()].filter(r => !writable.includes(r)) },
    capabilities: {
    answer: (hasIn("hook") || vendorCallButton) && hasOut("active"), hangup: (hasIn("hook") || vendorCallButton) && hasOut("active"),
    reject: hasIn("drop"), mute: hasIn("muted"), hold: hasIn("held"), ring: hasOut("ringing"),
    muteIndicator: hasOut("muted"), holdIndicator: hasOut("held"), battery: false, wearingSensor: false,
  } };
}

export function createPolyAdapter({ hid = globalThis.navigator?.hid, operationTimeoutMs = 4000 } = {}) {
  const devices = new Map(), ids = new WeakMap(), listeners = { devices: new Set(), command: new Set(), diagnostic: new Set() };
  let nextId = 0, selected = null, state = normalizeSoftphoneState(), disposed = false, testTimer, generation = 0;
  const on = (event, fn) => { listeners[event].add(fn); return () => listeners[event].delete(fn); };
  const emit = (event, value) => { for (const fn of listeners[event]) fn(value); };
  const idFor = device => { if (!ids.has(device)) ids.set(device, `usb-${device.vendorId}-${device.productId}-${++nextId}`); return ids.get(device); };
  const list = () => [...devices.values()].map(({ device, layout, error }) => ({ id: idFor(device), vendor: "poly", vendorLabel: "Poly / Plantronics",
    model: device.productName || "Poly USB headset", productId: device.productId, vendorId: device.vendorId,
    transport: "poly-webhid", connectionState: error ? "error" : layout.capabilities.answer ? "connected" : "unsupported",
    controlReady: !error && layout.capabilities.answer, capabilities: layout.capabilities, qualification: "unverified", error,
    reports: { profile: layout.profile, inputs: layout.inputs, outputs: layout.outputs, excluded: layout.excludedReports } }));
  const publish = () => emit("devices", list());
  const emitCommand = command => emit("command", { ...command, deviceId: selected, callId: state.callId, source: "headset" });
  const add = device => {
    if (disposed || device.vendorId !== POLY_VENDOR_ID || devices.has(idFor(device))) return;
    const layout = describePolyReports(device.collections, device);
    const entry = { device, layout, previous: new Map(), listener: null, writing: 0 };
    entry.listener = event => {
      if (disposed || selected !== idFor(device) || entry.writing) return;
      const report = layout.inputs.find(r => r.id === event.reportId);
      if (!report || event.data.byteLength < Math.ceil(report.bits / 8)) return;
      for (const field of report.fields) {
        const value = Boolean(event.data.getUint8(field.bit >> 3) & (1 << (field.bit % 8)));
        const old = entry.previous.get(field.name); entry.previous.set(field.name, value);
        // Relative bits are impulses, not retained switch state. A release may
        // arrive while LED writes suppress input echoes. Every nonzero impulse
        // still represents a new press even if the preceding release was lost.
        if ((field.absolute && old === value) || (!field.absolute && !value) || (old === undefined && field.absolute && !value && ["muted", "held"].includes(field.name))) continue;
        if (field.name === "callToggle" && value) {
          if (state.ringing) emitCommand({ type: "answer" });
          else if (state.active || state.direction === "outgoing") emitCommand({ type: "hangup" });
        } else if (field.name === "hook" && !layout.vendorCallButton) {
          if (state.ringing && value) emitCommand({ type: "answer" });
          else if ((state.active || state.direction === "outgoing") && (field.absolute ? !value && old === true : value)) emitCommand({ type: "hangup" });
        } else if (field.name === "drop" && value) emitCommand({ type: state.ringing ? "reject" : "hangup" });
        else if (state.active && field.name === "muted") emitCommand({ type: "mute", muted: field.absolute ? value : !state.muted });
        else if (state.active && field.name === "held") emitCommand({ type: "hold", held: field.absolute ? value : !state.held });
      }
    };
    device.addEventListener("inputreport", entry.listener); devices.set(idFor(device), entry); publish();
    emit("diagnostic", { level: layout.capabilities.answer ? "info" : "warn", message: layout.capabilities.answer
      ? "Poly USB telephony reports detected. Verify buttons and indicators on this model."
      : "Poly USB call control is unavailable for this report layout. Export diagnostics for model qualification." });
  };
  const connect = event => add(event.device);
  const disconnect = event => {
    const id = idFor(event.device), entry = devices.get(id);
    if (entry) event.device.removeEventListener("inputreport", entry.listener);
    devices.delete(id); if (selected === id) { selected = null; generation++; clearTimeout(testTimer); } publish();
  };
  const writeState = async next => {
    const entry = devices.get(selected); if (!entry) return;
    const version = generation;
    if (!entry.device.opened) throw new Error("Poly USB device is not open. Select it again.");
    entry.writing++;
    try {
      for (const report of entry.layout.outputs) {
        if (version !== generation || devices.get(selected) !== entry) throw new Error("Poly device changed during synchronization.");
        const bytes = new Uint8Array(Math.ceil(report.bits / 8));
        for (const field of report.fields) if (next[field.name]) bytes[field.bit >> 3] |= 1 << (field.bit % 8);
        await withHeadsetTimeout(() => entry.device.sendReport(report.id, bytes), operationTimeoutMs);
        if (version !== generation || devices.get(selected) !== entry) throw new Error("Poly device changed during synchronization.");
        // Rebase only observed absolute controls, after the corresponding LED
        // write succeeds. GUI changes must not swallow the next physical press.
        for (const field of report.fields) {
          const inputName = field.name === "active" ? "hook" : field.name;
          if (entry.previous.has(inputName) && entry.layout.inputs.some(input => input.fields.some(f => f.name === inputName && f.absolute))) {
            entry.previous.set(inputName, Boolean(next[field.name]));
          }
        }
      }
    } catch (err) { if (version === generation) { entry.error = err.message; publish(); } throw err; }
    finally { entry.writing--; }
  };
  return {
    vendor: "poly", onDevicesChange: fn => on("devices", fn), onCommand: fn => on("command", fn), onDiagnostic: fn => on("diagnostic", fn),
    async init() {
      disposed = false;
      if (!hid) { emit("diagnostic", { level: "warn", message: "Poly USB call control requires a browser with WebHID support." }); return; }
      hid.addEventListener("connect", connect); hid.addEventListener("disconnect", disconnect);
      for (const d of await hid.getDevices()) add(d);
      if (!disposed) emit("diagnostic", { level: "info", message: "Poly WebHID service ready. Add the USB headset or its manufacturer USB adapter." });
    },
    async requestPermission() {
      if (!hid) throw new Error("Use desktop Chrome or Edge to pair a Poly USB headset.");
      const paired = await hid.requestDevice({ filters: [{ vendorId: POLY_VENDOR_ID, usagePage: 0x0b }] });
      paired.forEach(add);
    },
    async setSelectedDevice(id) {
      clearTimeout(testTimer); const version = ++generation;
      const old = devices.get(selected); selected = null;
      if (old?.device.opened) await old.device.close();
      if (!id || disposed || version !== generation) return;
      const entry = devices.get(id);
      if (!entry || !entry.layout.capabilities.answer) throw new Error("This Poly device does not expose supported USB telephony reports.");
      // A reconnected HIDDevice can retain an open handle in this document.
      // Calling open() again rejects with "The device is already open".
      const opening = entry.device.opened ? Promise.resolve() : entry.device.open();
      try { await withHeadsetTimeout(() => opening, operationTimeoutMs); }
      catch (error) {
        if (version === generation) generation++;
        void Promise.resolve(opening).then(() => entry.device.opened && entry.device.close()).catch(() => {});
        throw error;
      }
      if (disposed || version !== generation || devices.get(id) !== entry) { if (entry.device.opened) await entry.device.close(); return; }
      entry.error = null; entry.previous.clear(); selected = id; publish();
    },
    async setSoftphoneState(input) { clearTimeout(testTimer); state = normalizeSoftphoneState(input); await writeState({ ...state, active: state.active || Boolean(state.callId && state.direction === "outgoing") }); },
    async sendTestCommand(command) {
      if (state.callId || state.active || state.ringing) throw new Error("Finish the call before testing the headset.");
      clearTimeout(testTimer);
      if (command === "ring") { await writeState({ ...state, ringing: true }); testTimer = setTimeout(() => void writeState(state).catch(err => emit("diagnostic", { level: "error", message: err.message })), 3000); }
      if (command === "reset") await writeState(state);
    },
    async dispose() {
      disposed = true; generation++; clearTimeout(testTimer);
      try { await writeState(normalizeSoftphoneState()); } catch { /* Device may already be unplugged. */ }
      selected = null;
      hid?.removeEventListener("connect", connect); hid?.removeEventListener("disconnect", disconnect);
      await Promise.allSettled([...devices.values()].map(async entry => { entry.device.removeEventListener("inputreport", entry.listener); if (entry.device.opened) await entry.device.close(); }));
      devices.clear(); state = normalizeSoftphoneState(); publish();
    },
  };
}
