/** Audio routing targets the single remote element and the actual WebRTC sender. */
export function createAudioRouter({ getCall, getClient, getMuted, onChange = () => {}, onSafetyMute = () => {}, storage = null }) {
  let route = { inputId: "", outputId: "" }, error = null, chain = Promise.resolve(), outputBlocked = false;
  let inventory = null, inventoryVersion = 0, notice = null;
  const appliedInputs = new WeakMap();
  const recovery = { input: false, output: false, error: null };
  const disconnectedMessage = "Switching to system audio…";
  const elements = new Set();
  const mediaReady = call => !call?.state || ["active", "connected", "answered", "held"].includes(call.state);
  try {
    const saved = JSON.parse(storage?.getItem("cc.headset.audio") || "{}");
    for (const key of ["inputId", "outputId"]) if (typeof saved[key] === "string") route[key] = saved[key];
  } catch { /* No saved route. */ }
  const snapshot = () => ({ ...route, error: recovery.error || ((recovery.input || recovery.output) ? disconnectedMessage : error), outputBlocked, notice });
  const publish = () => onChange(snapshot());
  const blockOutput = blocked => { outputBlocked = blocked; for (const el of elements) el.muted = blocked; };
  const missingDevices = () => ({
    inputMissing: Boolean(inventory && route.inputId && route.inputId !== "default" && !inventory.some(d => d.kind === "audioinput" && d.deviceId === route.inputId)),
    outputMissing: Boolean(inventory && route.outputId && route.outputId !== "default" && !inventory.some(d => d.kind === "audiooutput" && d.deviceId === route.outputId)),
  });
  const persist = () => { try { storage?.setItem("cc.headset.audio", JSON.stringify(route)); } catch { /* Optional storage. */ } };
  const markMissing = ({ inputMissing, outputMissing }) => {
    recovery.input ||= inputMissing; recovery.output ||= outputMissing;
    recovery.error = null;
    if (inputMissing) route.inputId = "default";
    if (outputMissing) route.outputId = "default";
    notice = "Audio device disconnected. Using system audio.";
    persist();
    publish();
  };
  const muteForLoss = async call => {
    if (call) { const mute = call.muteAudio || call.mute; await mute?.call(call); onSafetyMute(call); }
  };
  const apply = async (next, call, input, output) => {
    const client = getClient();
    if (input) {
      const liveTrack = call?.options?.localStream?.getAudioTracks?.()[0];
      if (call && (appliedInputs.get(call) !== (next.inputId || "default") || (call.options && liveTrack?.readyState !== "live"))) {
        if (typeof call.setAudioInDevice !== "function") throw new Error("This call cannot change microphone.");
        await call.setAudioInDevice(next.inputId || "default", getMuted());
        // Telnyx emits mediaError and resolves on acquisition/replacement failure.
        const track = call.options?.localStream?.getAudioTracks?.()[0];
        if (call.options && (call.options.micId !== (next.inputId || "default") || !track || track.readyState === "ended")) {
          throw new Error("The WebRTC call could not switch to the selected microphone.");
        }
        if (call !== getCall()) throw new Error("The call changed. Select audio devices again.");
        appliedInputs.set(call, next.inputId || "default");
      }
      if (client?.setAudioSettings) await client.setAudioSettings({ micId: next.inputId || "default" });
    }
    if (output) {
      for (const el of elements) {
        if (!el.setSinkId) {
          if (!next.outputId || next.outputId === "default") continue;
          throw new Error("This browser cannot select a speaker. Use the operating system audio settings.");
        }
        await el.setSinkId(next.outputId || "default");
      }
      if (client) client.speaker = next.outputId || "default";
    }
  };
  const enqueue = operation => { const work = chain.catch(() => {}).then(operation); chain = work; return work; };
  const recoverDevices = async () => {
    const missing = missingDevices();
    if (missing.inputMissing || missing.outputMissing) markMissing(missing);
    // A stream acquired through the 'default' alias can still belong to USB
    // hardware. Its ended track must be replaced after that hardware vanishes.
    const track = getCall()?.options?.localStream?.getAudioTracks?.()[0];
    if (track?.readyState === "ended") recovery.input = true;
    if (!recovery.input && !recovery.output) return null;
    const call = getCall(), version = inventoryVersion;
    // Replacing a sender while the call negotiates can interrupt the call.
    // applyToCall retries recovery when the active/held state arrives.
    if (recovery.input && call && !mediaReady(call)) return null;
    try {
      if (inventory && recovery.input && !inventory.some(d => d.kind === "audioinput" && d.deviceId)) throw new Error("No microphone is available. Connect a microphone and try again.");
      if (inventory && recovery.output && !inventory.some(d => d.kind === "audiooutput" && d.deviceId)) throw new Error("No speaker is available. Connect an audio device and try again.");
      await apply(route, call, recovery.input, recovery.output);
      if (call !== getCall() || version !== inventoryVersion) return null;
      if (recovery.output) blockOutput(false);
      recovery.input = false; recovery.output = false; recovery.error = null; error = null;
    } catch (err) {
      recovery.error = err.message;
      await muteForLoss(getCall());
      if (recovery.output) blockOutput(true);
    }
    publish();
    return null;
  };
  return {
    getSnapshot: snapshot,
    registerElement(el) {
      if (!el) return () => {};
      elements.add(el); el.muted = outputBlocked;
      void enqueue(async () => {
        if (!elements.has(el) || outputBlocked || !route.outputId || !el.setSinkId) return;
        try { await el.setSinkId(route.outputId); }
        catch (err) { blockOutput(true); error = err.message; publish(); }
      });
      return () => elements.delete(el);
    },
    setRoute(patch) {
      const call = getCall();
      return enqueue(async () => {
        if (call !== getCall()) throw new Error("The call changed. Select audio devices again.");
        const next = { ...route }, previous = route;
        for (const key of ["inputId", "outputId"]) if (typeof patch[key] === "string") next[key] = patch[key];
        const input = "inputId" in patch, output = "outputId" in patch;
        if (input && call && !mediaReady(call)) throw new Error("Wait for the call to connect before changing its microphone.");
        try {
          await apply(next, call, input, output); route = next; error = null; notice = null;
          if (input) recovery.input = false;
          if (output) { recovery.output = false; blockOutput(false); }
          recovery.error = null;
          persist();
        } catch (err) {
          error = err.message;
          if (call === getCall()) {
            try { await apply(previous, call, input, output); }
            catch { await muteForLoss(call); outputBlocked = true; for (const el of elements) el.muted = true; error += " Previous audio route could not be restored."; }
          }
          throw new Error(error);
        } finally { publish(); }
      });
    },
    applyToCall() {
      const call = getCall();
      return enqueue(async () => {
        if (call !== getCall()) return;
        if (missingDevices().inputMissing || missingDevices().outputMissing || recovery.input || recovery.output) { await recoverDevices(); return; }
        try { await apply(route, mediaReady(call) ? call : null, Boolean(route.inputId), Boolean(route.outputId)); }
        catch (err) { error = err.message; await muteForLoss(call); outputBlocked = true; for (const el of elements) el.muted = true; }
        publish();
      });
    },
    checkDevices(devices) {
      inventory = devices; inventoryVersion++;
      return enqueue(recoverDevices);
    },
  };
}
