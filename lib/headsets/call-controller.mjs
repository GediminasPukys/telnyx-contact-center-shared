export const headsetCallId = call => String(call?.callControlId || call?.call_control_id || call?.id || "");
const endedStates = new Set(["idle", "hangup", "ended", "destroy", "purge", "terminated", "done", "failed"]);
// A terminal SDK object can remain in the store while the call is finalized.
export const headsetCallInProgress = (call, status) => Boolean(call) &&
  ![status, call?.state].some(value => endedStates.has(String(value || "").toLowerCase()));
const connected = state => ["active", "connected", "answered", "held"].includes(String(state.status || state.call?.state).toLowerCase());

/** Both UI and hardware use this queue; desired values are captured before asynchronous work. */
export function createCallStateActions({ getState, submitHold, onError = () => {} }) {
  let chain = Promise.resolve();
  const set = (kind, value, expectedCall = getState().call) => {
    if (typeof value !== "boolean") return Promise.reject(new Error("Call state must be a boolean."));
    const work = chain.catch(() => {}).then(async () => {
      const state = getState(), call = state.call;
      if (!call || call !== expectedCall || !connected(state)) return;
      if (state.consultInProgress) throw new Error("Wait for the call transfer to finish before changing call controls.");
      const key = kind === "mute" ? "isMuted" : "isHeld";
      if (state.ui[key] === value) return;
      const method = kind === "mute" ? (value ? call.muteAudio || call.mute : call.unmuteAudio || call.unmute)
        : (value ? call.hold || call.pause : call.unhold || call.resume);
      if (typeof method !== "function") throw new Error(`This call does not support ${kind}.`);
      await method.call(call);
      // Telnyx reports hold failures through events and may resolve its promise.
      if (kind === "hold" && typeof call.state === "string" && (call.state === "held") !== value) {
        throw new Error("The WebRTC call did not confirm the requested hold state.");
      }
      if (getState().call !== call) return;
      if (kind === "hold" && state.contactCenter?.interactionId) {
        try { await submitHold(state.contactCenter.interactionId, value ? "hold" : "unhold"); }
        catch (error) {
          if (getState().call === call) {
            const reverse = value ? call.unhold || call.resume : call.hold || call.pause;
            try { await reverse?.call(call); } catch { throw new Error("Call hold state is uncertain. Check the call before retrying."); }
          }
          throw error;
        }
      }
      if (getState().call !== call) return;
      if (kind === "mute") getState().setMuted(value);
      else { getState().updateStatus(value ? "held" : "active"); getState().setHeld(value); }
    });
    chain = work;
    work.catch(onError);
    return work;
  };
  return { setMuted: (value, call) => set("mute", value, call), setHeld: (value, call) => set("hold", value, call) };
}

export function createHeadsetCommandController({ getState, getHandlers, isCurrent = () => true, onError = () => {} }) {
  let chain = Promise.resolve();
  const completed = new WeakMap();
  return {
    execute(command) {
      const call = getState().call;
      const work = chain.catch(() => {}).then(async () => {
        const state = getState();
        if (!call || call !== state.call || headsetCallId(call) !== command.callId || !isCurrent(command)) return;
        const handlers = getHandlers();
        const key = command.type;
        if (["answer", "reject", "hangup"].includes(key)) {
          if (["answer", "reject"].includes(key) && !state.ui.isRinging) return;
          if (completed.get(call)?.has(key)) return;
          const done = completed.get(call) || new Set();
          if (typeof handlers[key] !== "function") throw new Error(`Call action ${key} is unavailable.`);
          const result = await handlers[key]();
          if (result === false) throw new Error(`Call action ${key} failed. Try again from the softphone.`);
          done.add(key); completed.set(call, done);
        } else if (key === "mute" && connected(state)) await handlers.setMuted(command.muted, call);
        else if (key === "hold" && connected(state)) await handlers.setHeld(command.held, call);
      });
      chain = work; work.catch(onError); return work;
    },
  };
}
