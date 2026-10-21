"use client";
import { createHeadsetControlService } from "./headset-control-service.mjs";
import { createJabraAdapter } from "./adapters/jabra-adapter.mjs";
import { createEposAdapter } from "./adapters/epos-adapter.mjs";
import { createPolyAdapter } from "./adapters/poly-adapter.mjs";
import { createAudioRouter } from "./audio-routing.mjs";
import { createAudioDeviceDiscovery, reconcileAudioSuggestion } from "./audio-device-discovery.mjs";
import { acquireCallAudio } from "./audio-preflight.mjs";
import { createAudioControlSelection } from "./audio-control-selection.mjs";
import useHeadsetStore from "@/lib/stores/headset-store";
import useActiveCallStore from "@/lib/stores/active-call-store";

let service = null, audioRouter = null, client = null, audioControlSelection = null;
let audioRefreshVersion = 0;
const discoverAudioDevice = createAudioDeviceDiscovery();
let sessionLease = Promise.resolve();
const update = patch => useHeadsetStore.getState().update(patch);
const diagnostic = entry => useHeadsetStore.getState().recordDiagnostic(entry);
export function isHeadsetIntegrationEnabled() { return String(process.env.NEXT_PUBLIC_HEADSET_INTEGRATION_ENABLED || "true").toLowerCase() !== "false"; }
export function getHeadsetControlService() { return service; }
export const selectAudioCallControl = suggestion => audioControlSelection?.select(suggestion);
export function selectHeadsetControlDevice(key) { audioControlSelection?.cancel(); return service?.selectDevice(key); }
export function getHeadsetAudioRouter() {
  if (!audioRouter && typeof window !== "undefined") {
    let storage; try { storage = window.localStorage; } catch { /* Storage disabled. */ }
    audioRouter = createAudioRouter({ getCall: () => useActiveCallStore.getState().call, getClient: () => client,
      getMuted: () => useActiveCallStore.getState().ui.isMuted,
      onSafetyMute: call => { if (useActiveCallStore.getState().call === call) useActiveCallStore.getState().setMuted(true); }, storage, onChange: audio => update({ audio }) });
    update({ audio: audioRouter.getSnapshot() });
  }
  return audioRouter;
}
export function setHeadsetAudioClient(value) { client = value; }
export const prepareWebrtcAudio = () => acquireCallAudio({ mediaDevices: navigator.mediaDevices, router: getHeadsetAudioRouter() });
export async function refreshHeadsetAudioDevices(requestPermission = false) {
  const version = ++audioRefreshVersion;
  update({ audioLoading: true });
  try {
    if (requestPermission) { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(track => track.stop()); }
    const audioDevices = (await navigator.mediaDevices.enumerateDevices()).filter(d => ["audioinput", "audiooutput"].includes(d.kind)).map(d => ({ deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: d.label }));
    if (version !== audioRefreshVersion) return;
    update({ audioDevices });
    const suggestion = discoverAudioDevice(audioDevices);
    const currentSuggestion = useHeadsetStore.getState().audioSuggestion;
    const nextSuggestion = reconcileAudioSuggestion(suggestion || currentSuggestion, audioDevices, getHeadsetAudioRouter()?.getSnapshot());
    if (nextSuggestion !== currentSuggestion) update({ audioSuggestion: nextSuggestion });
    await getHeadsetAudioRouter()?.checkDevices(audioDevices);
  } catch (err) { diagnostic({ message: err.message, level: "error" }); }
  finally { if (version === audioRefreshVersion) update({ audioLoading: false }); }
}

/** One tab owns local vendor transports. Cleanup does not hang up the WebRTC call. */
export function startHeadsetSession({ vendors = ["jabra", "epos", "poly"], ownerId } = {}) {
  let stopped = false, initializing = true, release;
  const released = new Promise(resolve => { release = resolve; });
  const preferenceKey = ownerId ? `cc.headset.control.${ownerId}` : null;
  let initialSelectedKey = null;
  try {
    const saved = preferenceKey && window.localStorage.getItem(preferenceKey);
    // WebHID does not expose a Poly serial number: its per-session ID is not
    // safe to restore when two identical adapters are connected in a new order.
    if (saved && /^(jabra:(?!session-)|epos:)/.test(saved) && vendors.includes(saved.split(":")[0])) initialSelectedKey = saved;
  } catch { /* Device choice still works when browser storage is unavailable. */ }
  const instance = createHeadsetControlService({ initialSelectedKey, adapters: [createJabraAdapter(), createEposAdapter(), createPolyAdapter()].filter(a => vendors.includes(a.vendor)) });
  service = instance;
  const selection = createAudioControlSelection({ service: instance,
    isCurrentAudio: suggestion => {
      const route = getHeadsetAudioRouter().getSnapshot();
      return ['inputId', 'outputId'].every(kind => !suggestion[kind] || suggestion[kind] === route[kind]);
    }, onError: error => diagnostic({ message: error.message, level: 'error' }) });
  audioControlSelection = selection;
  update({ enabled: true, status: "connecting", error: null });
  const off = instance.onChange(value => {
    if (stopped) return;
    update({ ...value, status: initializing || value.busy ? "connecting" : value.device?.connectionState || "disconnected" });
    if (preferenceKey) try {
      // Jabra WebHID's "serialNumber" is an SDK session UUID, not a USB serial.
      if (/^(jabra:(?!session-)|epos:)/.test(value.selectedKey || "") && value.device?.transport !== "jabra-webhid") window.localStorage.setItem(preferenceKey, value.selectedKey);
      else window.localStorage.removeItem(preferenceKey);
    } catch { /* Storage is optional. */ }
  });
  const offDiagnostic = instance.onDiagnostic(diagnostic);
  const run = async lock => {
    if (stopped) return;
    if (!lock) { update({ status: "in-use", error: "Headset controls are active in another browser tab. Close that tab and retry." }); return; }
    try { await instance.init(); initializing = false; if (!stopped) { const value = instance.getSnapshot(); update({ ...value, status: value.device?.connectionState || "disconnected" }); await released; } }
    finally { await instance.dispose(); }
  };
  if (navigator.locks?.request) sessionLease = sessionLease.catch(() => {}).then(() => navigator.locks.request("cc-headset-control", { ifAvailable: true }, run)).catch(err => { if (!stopped) update({ status: "error", error: err.message }); });
  else update({ status: "unsupported", error: "This browser cannot coordinate headset access. Use desktop Chrome or Edge." });
  return () => {
    stopped = true; release(); off(); offDiagnostic(); selection.dispose();
    if (audioControlSelection === selection) audioControlSelection = null;
    if (service === instance) { service = null; update({ enabled: false, device: null, devices: [], selectedKey: null, status: "disabled" }); }
  };
}
export async function disposeHeadsetControlServiceForTests() { await service?.dispose(); service = null; }
