import { normalizeSoftphoneState, withHeadsetTimeout } from "../headset-control-service.mjs";
let browserApiPromise;
export const loadJabraSdk = () => import("@gnaudio/jabra-js");

export function createJabraAdapter({ jabra = null, loadSdk = loadJabraSdk, partnerKey = process.env.NEXT_PUBLIC_JABRA_PARTNER_KEY || "",
  appId = process.env.NEXT_PUBLIC_JABRA_APP_ID || "telnyx-contact-center", appName = process.env.NEXT_PUBLIC_JABRA_APP_NAME || "Telnyx Contact Center",
  incomingRingTimeoutMs = 60000, logger = null } = {}) {
  const listeners = { command: new Set(), devices: new Set(), device: new Set(), diagnostic: new Set() }, devices = new Map(), sessionIds = new WeakMap();
  let sdk = jabra, api, factory, control, selected = null, generation = 0, ringGeneration = 0, disposed = false;
  let desired = normalizeSoftphoneState(), applied = normalizeSoftphoneState(), lastCount = 0, writing = 0;
  let disposers = [], controlDisposers = [], testActive = false, sessionId = 0;
  const on = (kind, fn) => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
  const emit = (kind, value) => { for (const fn of listeners[kind]) fn(value); };
  const diagnostic = (message, level = "info") => emit("diagnostic", { message, level });
  const idFor = d => {
    if (d.serialNumber) return String(d.serialNumber);
    if (!sessionIds.has(d)) sessionIds.set(d, `session-${++sessionId}`);
    return sessionIds.get(d);
  };
  const info = entry => ({ id: idFor(entry.device), vendor: "jabra", vendorLabel: "Jabra", model: entry.device.name,
    productId: entry.device.productId, transport: api?.transportContext === "chrome-extension" ? "jabra-extension" : "jabra-webhid",
    connectionState: entry.error ? "error" : entry.supported ? "connected" : "unsupported", controlReady: entry.supported && !entry.error,
    error: entry.error, capabilities: entry.supported ? { answer: true, reject: true, hangup: true, mute: true, hold: true, ring: true } : {}, qualification: "unverified" });
  const list = () => [...devices.values()].map(info);
  const publish = () => { emit("devices", list()); emit("device", devices.has(selected) ? info(devices.get(selected)) : null); };
  const command = value => {
    if (!disposed && selected && desired.callId) emit("command", { ...value, deviceId: selected, callId: desired.callId, source: "headset" });
  };
  const subscribe = (observable, handler, list) => {
    if (!observable?.subscribe) return;
    const subscription = observable.subscribe(handler); list.push(() => subscription?.unsubscribe?.());
  };
  const teardown = target => { try { target?.teardown?.(); } catch { /* SDK already tears down on USB disconnect. */ } };
  const clearControl = () => {
    generation++; ringGeneration++; lastCount = 0; testActive = false;
    for (const fn of controlDisposers) fn(); controlDisposers = [];
    const previous = control; control = null; applied = normalizeSoftphoneState();
    teardown(previous);
  };
  const method = async (name, ...args) => {
    const target = control;
    if (typeof target?.[name] !== "function") throw new Error(`Jabra does not support ${name}.`);
    return withHeadsetTimeout(() => target[name](...args));
  };
  const apply = async input => {
    const next = { ...input, active: input.active || Boolean(input.callId && input.direction === "outgoing") };
    if (!control) return;
    const version = generation, target = control;
    // A USB disconnect can happen between any two awaited SDK operations.
    const invoke = async (name, ...args) => {
      if (version !== generation || target !== control) throw new Error("Jabra control changed during synchronization.");
      await method(name, ...args);
      if (version !== generation || target !== control) throw new Error("Jabra control changed during synchronization.");
    };
    const previous = applied;
    writing++;
    try {
      if (previous.callId !== next.callId && (previous.active || previous.ringing)) {
        ringGeneration++;
        if (previous.ringing) await invoke("rejectIncomingCall");
        if (previous.active) await invoke("endCall");
        applied = normalizeSoftphoneState();
      }
      const before = applied;
      if (next.ringing && !before.ringing) {
        const ring = ++ringGeneration, callId = next.callId, startedAt = Date.now();
        // Resolves on answer/reject; never block the state publication queue on ringing.
        Promise.resolve(target.signalIncomingCall(incomingRingTimeoutMs)).then(accepted => {
          if (disposed || version !== generation || ring !== ringGeneration || desired.callId !== callId || !desired.ringing) return;
          if (accepted === false && Date.now() - startedAt >= incomingRingTimeoutMs - 100) {
            applied = { ...applied, ringing: false };
            diagnostic("Jabra ringing timed out; the application still owns the offer lifetime.", "warn"); return;
          }
          applied = { ...applied, active: accepted === true, ringing: false };
          command({ type: accepted === true ? "answer" : "reject" });
        }).catch(err => diagnostic(`Jabra incoming signal failed: ${err.message}`, "error"));
      }
      if (next.active && !before.active) {
        ringGeneration++;
        await invoke(before.ringing ? "acceptIncomingCall" : "startCall");
        applied = { ...applied, callId: next.callId, active: true, ringing: false };
      } else if (!next.ringing && before.ringing && !next.active) { ringGeneration++; await invoke("rejectIncomingCall"); }
      else if (!next.active && before.active) { ringGeneration++; await invoke("endCall"); }
      // ECC rejects mute changes while held. Resume first; mute changes made
      // during hold stay in the WebRTC state and are replayed on resume.
      if (next.active && before.held && !next.held) { await invoke("resume"); applied = { ...applied, held: false }; }
      const deferMute = next.active && next.held && before.held;
      if (next.active && !deferMute && (next.muted !== before.muted || !before.active)) { await invoke(next.muted ? "mute" : "unmute"); applied = { ...applied, muted: next.muted }; }
      if (next.active && next.held && !before.held) { await invoke("hold"); applied = { ...applied, held: true }; }
      if (deferMute && next.muted !== applied.muted) diagnostic("Jabra mute indicator will update when the held call resumes.");
      if (version === generation) applied = { ...next, muted: deferMute ? applied.muted : next.muted };
    } catch (err) { diagnostic(`Jabra state synchronization failed: ${err.message}`, "error"); throw err; }
    finally { writing--; }
  };
  const select = async id => {
    clearControl(); selected = null;
    if (!id) { publish(); return; }
    const entry = devices.get(id);
    if (!entry?.supported) throw new Error("This Jabra device does not support Easy Call Control.");
    const version = generation;
    const initial = { ...desired, active: desired.active || Boolean(desired.callId && desired.direction === "outgoing"), ringing: false };
    const creation = factory.createMultiCallControl(entry.device, initial.active ? { ongoingCalls: 1, muted: initial.muted, onHold: initial.held } : undefined);
    // A timed-out factory may still resolve later with a live device lock.
    let next;
    try { next = await withHeadsetTimeout(() => creation); }
    catch (error) { if (version === generation) generation++; void Promise.resolve(creation).then(teardown, () => {}); throw error; }
    if (disposed || version !== generation || devices.get(id) !== entry) { teardown(next); return; }
    selected = id; control = next; entry.error = null; applied = initial;
    let initializing = true;
    const current = fn => value => { if (!disposed && version === generation && !writing && !initializing) fn(value); };
    subscribe(next.muteState, current(value => {
      if (["muted", "unmuted"].includes(String(value))) {
        const muted = String(value) === "muted"; applied = { ...applied, muted }; command({ type: "mute", muted });
      }
    }), controlDisposers);
    subscribe(next.holdState, current(value => {
      if (["on-hold", "not-on-hold"].includes(String(value))) {
        const held = String(value) === "on-hold"; applied = { ...applied, held }; command({ type: "hold", held });
      }
    }), controlDisposers);
    subscribe(next.swapRequest, current(() => command({ type: "swap" })), controlDisposers);
    subscribe(next.ongoingCalls, value => {
      if (version !== generation || disposed) return;
      const count = Number(value) || 0;
      if (!initializing && !writing && lastCount > 0 && count === 0 && (desired.active || desired.direction === "outgoing")) {
        // The SDK already ended its call. Calling endCall again throws.
        applied = { ...applied, active: false, ringing: false, muted: false, held: false };
        command({ type: "hangup" });
      }
      lastCount = count;
    }, controlDisposers);
    subscribe(next.onDisconnect, () => {
      if (version !== generation) return;
      clearControl(); entry.error = "Jabra control connection lost. Reconnect the headset."; publish();
    }, controlDisposers);
    publish(); await apply(desired); initializing = false;
  };
  return {
    vendor: "jabra", onCommand: fn => on("command", fn), onDevicesChange: fn => on("devices", fn), onDeviceChange: fn => on("device", fn), onDiagnostic: fn => on("diagnostic", fn),
    getDevice: () => devices.has(selected) ? info(devices.get(selected)) : null,
    async init() {
      disposed = false; sdk ||= await loadSdk();
      const config = { partnerKey, transport: sdk.RequestedBrowserTransport.CHROME_EXTENSION_WITH_WEB_HID_FALLBACK, appId, appName };
      if (logger) config.logger = logger;
      // The SDK exposes no public shutdown API. Reuse its transport across React
      // remounts; per-session subscriptions and call-control locks are torn down.
      if (!jabra) {
        browserApiPromise ||= sdk.createApi(config).catch(error => { browserApiPromise = null; throw error; });
        api = await browserApiPromise;
      } else api = await sdk.createApi(config);
      if (disposed) return;
      factory = new sdk.EasyCallControlFactory(api);
      subscribe(api.deviceAdded, device => { if (disposed) return; devices.set(idFor(device), { device, supported: factory.supportsEasyCallControl(device) }); publish(); }, disposers);
      subscribe(api.deviceRemoved, device => {
        const id = idFor(device); devices.delete(id);
        if (selected === id) { clearControl(); selected = null; }
        publish();
      }, disposers);
      await api.start?.();
      if (!disposed) { for (const device of api.getCurrentDevices?.() || []) devices.set(idFor(device), { device, supported: factory.supportsEasyCallControl(device) }); publish(); }
      if (!disposed) diagnostic(`Jabra service ready: ${api.transportContext}; SDK ${api.getVersion?.() || "unknown"}.`);
      if (!partnerKey) diagnostic("A Jabra partner key must be configured before production rollout.", "warn");
    },
    requestPermission() {
      if (!api || !sdk?.webHidPairing) throw new Error("Wait for Jabra initialization, then try again.");
      if (api.transportContext === "chrome-extension") {
        diagnostic("Jabra Device Connector discovers connected devices automatically."); return Promise.resolve();
      }
      return sdk.webHidPairing();
    },
    setSelectedDevice: select,
    async setSoftphoneState(input) {
      desired = normalizeSoftphoneState(input);
      if (testActive) { testActive = false; ringGeneration++; await method("rejectIncomingCall"); }
      await apply(desired);
    },
    async sendTestCommand(commandName) {
      if (desired.callId || desired.active || desired.ringing) throw new Error("Finish the call before testing the headset.");
      if (!control) throw new Error("Select a Jabra device first.");
      if (commandName === "ring") {
        const version = generation, ring = ++ringGeneration; testActive = true; writing++;
        try {
          const accepted = await control.signalIncomingCall(3000);
          // Timeout/reject already clears the SDK offer. An answer during the
          // indicator test creates only an SDK call, which must be ended here.
          if (version === generation && ring === ringGeneration && !desired.callId && accepted) await method("endCall");
        } finally { writing--; if (version === generation && ring === ringGeneration) testActive = false; }
      }
      if (commandName === "reset" && testActive) { testActive = false; ringGeneration++; await method("rejectIncomingCall"); }
    },
    async dispose() {
      disposed = true; try { if (testActive) await method("rejectIncomingCall"); await apply(normalizeSoftphoneState()); } catch { /* Best effort hardware cleanup. */ }
      clearControl(); selected = null;
      for (const fn of disposers) fn(); disposers = []; devices.clear();
      desired = normalizeSoftphoneState(); publish();
    },
  };
}
