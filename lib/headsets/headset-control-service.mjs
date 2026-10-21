export const HEADSET_COMMANDS = Object.freeze({ ANSWER: "answer", REJECT: "reject", HANGUP: "hangup", MUTE: "mute", HOLD: "hold", DEVICE_CHANGED: "deviceChanged", BATTERY_CHANGED: "batteryChanged", SWAP: "swap" });

export function normalizeSoftphoneState(input = {}) {
  const string = value => value == null || value === "" ? null : String(value).trim() || null;
  return { callId: string(input.callId), direction: ["incoming", "outgoing"].includes(input.direction) ? input.direction : null,
    ringing: Boolean(input.ringing), active: Boolean(input.active), muted: Boolean(input.muted), held: Boolean(input.held),
    remoteDisplayName: string(input.remoteDisplayName), remoteNumber: string(input.remoteNumber) };
}

export const headsetDeviceKey = device => device ? `${device.vendor}:${device.id}` : null;
export const headsetControlReady = device => device?.connectionState === "connected" && device?.controlReady !== false;
export function withHeadsetTimeout(operation, timeoutMs = 5000) {
  let timer;
  return Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Headset operation timed out. Reconnect the device before retrying.")), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

/** Selection is explicit. A disconnected device never silently hands control to another device. */
export function createHeadsetControlService({ adapters = [], now = Date.now, debounceMs = 350, operationTimeoutMs = 5000, initialSelectedKey = null } = {}) {
  const events = { command: new Set(), device: new Set(), diagnostic: new Set(), change: new Set() };
  const devices = new Map(), initialized = new Set();
  let disposers = [], initPromise, selectedKey = initialSelectedKey, epoch = 0, disposed = false, enabled = true;
  let state = normalizeSoftphoneState(), chain = Promise.resolve(), sync = "idle", error = null, busy = false;
  let lastCommand = null, lastCommandAt = 0, revision = 0;
  const subscribe = (kind, fn) => { events[kind].add(fn); return () => events[kind].delete(fn); };
  const device = () => devices.get(selectedKey) || null;
  const adapterFor = d => adapters.find(a => a.vendor === d?.vendor);
  const diagnostic = (vendor, message, level = "info", extra = {}) => {
    const entry = { vendor, message, level, at: new Date(now()).toISOString(), ...extra };
    for (const fn of events.diagnostic) fn(entry);
  };
  const snapshot = () => ({ devices: [...devices.values()], selectedKey, device: device(), state, sync, error, busy, enabled });
  const publish = () => { for (const fn of events.device) fn(device()); for (const fn of events.change) fn(snapshot()); };
  const updateDevices = (adapter, list) => {
    if (disposed) return;
    const wasReady = headsetControlReady(device());
    for (const [key, d] of devices) if (d.vendor === adapter.vendor) devices.delete(key);
    for (const d of list.filter(Boolean)) {
      const value = { ...d, vendor: adapter.vendor, id: String(d.id || d.model || adapter.vendor) };
      devices.set(headsetDeviceKey(value), value);
    }
    if (selectedKey?.startsWith(`${adapter.vendor}:`)) {
      if (!headsetControlReady(device())) { sync = "disconnected"; if (wasReady) epoch++; }
      else if (!wasReady && !busy) {
        const key = selectedKey, version = epoch;
        chain = chain.catch(() => {}).then(async () => {
          if (disposed || key !== selectedKey || version !== epoch) return;
          try {
            await withHeadsetTimeout(() => adapter.setSelectedDevice?.(device().id), operationTimeoutMs);
            if (disposed || version !== epoch || key !== selectedKey || !headsetControlReady(device())) return;
            await withHeadsetTimeout(() => adapter.setSoftphoneState?.(state), operationTimeoutMs);
            if (disposed || version !== epoch || key !== selectedKey || !headsetControlReady(device())) return;
            sync = "synced"; error = null;
          } catch (err) { if (disposed || version !== epoch) return; sync = "error"; error = err.message; diagnostic(adapter.vendor, error, "error"); }
          publish();
        });
      }
    }
    publish();
  };
  const emitCommand = (adapter, input) => {
    const current = device();
    if (disposed || !enabled || busy || !headsetControlReady(current) || current.vendor !== adapter.vendor || !state.callId) return;
    if (input.deviceId != null && String(input.deviceId) !== current.id) return;
    if (input.callId != null && String(input.callId) !== state.callId) return;
    if (input.type === "swap" || current.capabilities?.[input.type] === false) {
      diagnostic(adapter.vendor, "This headset action is not available for the current call.", "warn"); return;
    }
    if (["answer", "reject"].includes(input.type) && !state.ringing) return;
    if (["mute", "hold"].includes(input.type) && !state.active) return;
    if (input.type === "mute" && typeof input.muted !== "boolean") return;
    if (input.type === "hold" && typeof input.held !== "boolean") return;
    const command = { ...input, vendor: adapter.vendor, deviceId: current.id, callId: state.callId, generation: epoch };
    const key = JSON.stringify([selectedKey, state.callId, epoch, command.type, command.muted, command.held]);
    if (lastCommand === key && now() - lastCommandAt < debounceMs) return;
    lastCommand = key; lastCommandAt = now();
    diagnostic(adapter.vendor, `Headset requested ${command.type}`, "info", { type: command.type });
    for (const fn of events.command) Promise.resolve().then(() => {
      if (command.generation === epoch && state.callId === command.callId && enabled && !disposed) return fn(command);
    }).catch(err => diagnostic(adapter.vendor, err.message, "error"));
  };
  const synchronize = () => {
    const version = epoch, update = ++revision, target = device(), desired = state;
    chain = chain.catch(() => {}).then(async () => {
      if (disposed || !enabled || version !== epoch || update !== revision || !headsetControlReady(target)) return;
      sync = "syncing"; error = null; publish();
      try {
        await withHeadsetTimeout(() => adapterFor(target)?.setSoftphoneState?.(desired), operationTimeoutMs);
        if (version !== epoch || disposed) return;
        sync = "synced"; diagnostic(target.vendor, "Headset state synchronized");
      } catch (err) {
        if (version !== epoch || disposed) return;
        sync = "error"; error = err.message;
        diagnostic(target.vendor, error, "error");
      }
      publish();
    });
    return chain;
  };
  const service = {
    onCommand: fn => subscribe("command", fn), onDeviceChange: fn => subscribe("device", fn),
    onDiagnostic: fn => subscribe("diagnostic", fn), onChange: fn => subscribe("change", fn),
    getDevice: device, getDevices: () => [...devices.values()], getSnapshot: snapshot, getSoftphoneState: () => state,
    isCurrentCommand: command => enabled && !disposed && command.generation === epoch && command.callId === state.callId && command.deviceId === device()?.id,
    async init() {
      if (initPromise) return initPromise;
      disposed = false;
      if (!disposers.length) for (const adapter of adapters) {
        disposers.push(adapter.onCommand?.(command => emitCommand(adapter, command)));
        if (adapter.onDevicesChange) disposers.push(adapter.onDevicesChange(list => updateDevices(adapter, list)));
        else disposers.push(adapter.onDeviceChange?.(d => updateDevices(adapter, d ? [d] : [])));
        disposers.push(adapter.onDiagnostic?.(d => diagnostic(adapter.vendor, d.message || String(d), d.level || "info")));
      }
      initPromise = Promise.all(adapters.map(async adapter => {
        if (initialized.has(adapter)) return;
        try { await withHeadsetTimeout(() => adapter.init?.(), operationTimeoutMs); initialized.add(adapter); }
        catch (err) { diagnostic(adapter.vendor, err.message, "error"); }
      })).finally(() => { initPromise = null; publish(); });
      return initPromise;
    },
    async selectDevice(key) {
      if (busy) throw new Error("A headset change is already in progress.");
      if (state.callId || state.active || state.ringing) throw new Error("Finish the call before changing the control device.");
      const next = key ? devices.get(key) : null;
      if (key && !headsetControlReady(next)) throw new Error("This device is not ready for call control.");
      busy = true; epoch++; publish();
      // Reconnection and explicit selection must share the same queue; they
      // otherwise can both open the same WebHID handle concurrently.
      const selecting = chain.catch(() => {}).then(async () => { try {
        if (disposed || !enabled) throw new Error("Headset controls are unavailable.");
        const old = device();
        if (old) await withHeadsetTimeout(() => adapterFor(old)?.setSoftphoneState?.(normalizeSoftphoneState()), operationTimeoutMs);
        for (const adapter of adapters) await withHeadsetTimeout(() => adapter.setSelectedDevice?.(adapter.vendor === next?.vendor ? next.id : null), operationTimeoutMs);
        selectedKey = key || null; sync = key ? "idle" : "disabled"; error = null;
      } catch (err) { selectedKey = null; sync = "error"; error = err.message; throw err; }
      finally { busy = false; publish(); } });
      chain = selecting.catch(() => {});
      await selecting;
      return synchronize();
    },
    async setSoftphoneState(input) {
      const next = normalizeSoftphoneState(input);
      if (next.callId !== state.callId) { epoch++; lastCommand = null; }
      state = next; publish();
      return synchronize();
    },
    async requestPermission(vendor) {
      const adapter = adapters.find(a => a.vendor === vendor);
      if (!adapter?.requestPermission) throw new Error("Start the headset manufacturer's local service to connect this device.");
      // Keep the original user gesture for WebHID requestDevice.
      return adapter.requestPermission();
    },
    async sendTestCommand(command) {
      if (busy) throw new Error("A headset operation is already in progress.");
      if (state.active || state.ringing || state.callId) throw new Error("Headset tests are available only when no call is in progress.");
      if (!enabled || !headsetControlReady(device())) throw new Error("Select a connected headset first.");
      if (!["ring", "reset"].includes(command)) throw new Error("Test mute and hold during a controlled test call.");
      busy = true; publish();
      try { return await withHeadsetTimeout(() => adapterFor(device()).sendTestCommand?.(command), operationTimeoutMs + 6000); }
      finally { busy = false; publish(); }
    },
    async setEnabled(value) {
      enabled = Boolean(value); epoch++;
      if (!enabled) { selectedKey = null; sync = "disabled"; }
      publish();
    },
    async dispose() {
      disposed = true; epoch++; selectedKey = null; state = normalizeSoftphoneState();
      for (const fn of disposers) fn?.(); disposers = [];
      await Promise.allSettled(adapters.map(adapter => withHeadsetTimeout(() => adapter.dispose?.(), operationTimeoutMs)));
      initialized.clear(); devices.clear(); sync = "disabled"; busy = false; error = null; publish();
    },
  };
  return service;
}
