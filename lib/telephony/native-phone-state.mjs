// Device observations, never WebRTC SDK state. Unknown/multiple calls fail closed.
const normalized = value => String(value || "").trim().replace(/([a-z0-9])([A-Z])/g,"$1_$2").toLowerCase().replace(/[\s-]+/g,"_");
const ended = new Set(["", "idle", "disconnected", "ended", "completed", "failed", "no_active_call"]);
const held = new Set(["held", "hold", "call_hold", "call_held", "on_hold", "local_hold", "remote_hold"]);
const connected = new Set(["connected", "call_connected", "active", "confirmed", "in_call", "talking", "answered", "bridged"]);
const incoming = new Set(["incoming", "call_incoming", "ringing", "call_ringing", "offering", "alerting", "ring", "presenting"]);
const dialing = new Set(["proceeding", "call_proceeding", "ringback", "ring_back", "call_ringback", "dialing", "outgoing", "trying", "originating"]);
export function nativePhoneState(observation, { callStateKnown = true } = {}) {
  callStateKnown = callStateKnown && observation?.callStateKnown !== false;
  const calls = (Array.isArray(observation?.call) ? observation.call : observation?.call ? [observation.call] : []).filter(c => c && !ended.has(normalized(c.CallState || c.state)));
  const call = calls.length === 1 ? calls[0] : null;
  const state = normalized(call?.CallState || call?.state);
  const direction = normalized(call?.Type || call?.direction);
  const isHeld = held.has(state);
  const isConnected = isHeld || connected.has(state);
  const isRinging = incoming.has(state) && !["outgoing", "outbound"].includes(direction);
  const isDialing = dialing.has(state) || (incoming.has(state) && ["outgoing", "outbound"].includes(direction));
  const mute = call?.Muted ?? call?.Mute ?? observation?.muted;
  const isMuted = mute == null ? null : ["true", "1", "on", "muted", "yes"].includes(String(mute).toLowerCase());
  const status = !callStateKnown || calls.length > 1 || (calls.length && !isConnected && !isRinging && !isDialing) ? "unknown" : isHeld ? "held" : isConnected ? "active" : isRinging ? "ringing" : isDialing ? "dialing" : "idle";
  return { status, call, callCount:calls.length, callRef:String(call?.CallHandle || call?.Ref || call?.id || ""), isHeld, isConnected, isRinging, isMuted,
    direction:["incoming","inbound"].includes(direction) || isRinging ? "inbound" : "outbound",
    remoteNumber:String(call?.RemotePartyNumber || call?.remote_party_number || call?.to || ""),
    remoteName:String(call?.RemotePartyName || call?.remote_party_name || ""),
    localNumber:String(call?.LocalPartyNumber || call?.local_party_number || ""),
    // No call identity means no mutations. Poll failures must never manufacture idle.
    controllable:callStateKnown && calls.length === 1 && Boolean(call?.CallHandle || call?.Ref || call?.id) && status !== "unknown",
  };
}
export function nativeActionAllowed(state, action) {
  if (!state?.controllable) return false;
  if (action === "answer") return state.isRinging;
  if (action === "hangup") return true;
  if (action === "hold") return state.isConnected && !state.isHeld;
  if (action === "resume") return state.isHeld;
  if (["mute", "unmute", "send_dtmf"].includes(action)) return state.isConnected && !state.isHeld;
  return false;
}
