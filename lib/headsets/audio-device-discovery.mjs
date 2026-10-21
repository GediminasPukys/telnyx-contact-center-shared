import { headsetCallInProgress } from './call-controller.mjs';

const concreteAudio = devices => devices.filter(d =>
  ['audioinput', 'audiooutput'].includes(d.kind) && d.deviceId && !['default', 'communications'].includes(d.deviceId));
const endpointKey = device => `${device.kind}:${device.deviceId}`;
const pairedSuggestion = (first, devices) => {
  const group = first.groupId ? devices.filter(d => d.groupId === first.groupId) : [first];
  const input = group.find(d => d.kind === 'audioinput');
  const output = group.find(d => d.kind === 'audiooutput');
  return { name: first.label, ...(input && { inputId: input.deviceId }), ...(output && { outputId: output.deviceId }) };
};

// devicechange describes an inventory change, not necessarily a physical plug.
// Remember a short disappearance and group input/output endpoints belonging to
// the same hardware. This affects suggestions only, never disconnect fallback.
export function createAudioDeviceDiscovery({ now = Date.now, reappearanceGraceMs = 3000 } = {}) {
  const known = new Map();
  let initialized = false;
  return devices => {
    const concrete = concreteAudio(devices), time = now();
    const present = new Set(concrete.map(endpointKey));
    for (const [key, record] of known) {
      if (!present.has(key)) record.missingSince ??= time;
      // Check expiry even if this is the first observation of the returning device.
      if (record.missingSince !== null && time - record.missingSince >= reappearanceGraceMs) known.delete(key);
    }
    const previous = [...known.values()];
    const added = concrete.filter(device => device.label && !known.has(endpointKey(device)) &&
      !previous.some(({ device: old }) => device.groupId && old.groupId === device.groupId) &&
      // Some audio profiles replace both IDs. A unique, just-disappeared endpoint
      // with the same label is continuity; never merge two present identical units.
      !(previous.filter(({ device: old, missingSince }) => missingSince !== null && old.label === device.label && old.kind === device.kind).length === 1 &&
        concrete.filter(d => d.label === device.label && d.kind === device.kind).length === 1));
    for (const device of concrete) known.set(endpointKey(device), { device, missingSince: null });
    if (!initialized) {
      initialized = concrete.some(device => device.label);
      return null;
    }
    const first = added.find(d => d.kind === 'audioinput') || added[0];
    return first ? pairedSuggestion(first, concrete) : null;
  };
}

// Update a pending offer when the other audio endpoint arrives later. Drop stale
// IDs and offers for the route already selected, without generating a new event.
export function reconcileAudioSuggestion(suggestion, devices, route = {}) {
  if (!suggestion) return null;
  const concrete = concreteAudio(devices);
  const first = concrete.find(d => d.kind === 'audioinput' && d.deviceId === suggestion.inputId) ||
    concrete.find(d => d.kind === 'audiooutput' && d.deviceId === suggestion.outputId);
  if (!first) return null;
  const next = pairedSuggestion(first, concrete);
  if (['inputId', 'outputId'].every(key => !next[key] || next[key] === route[key])) return null;
  return ['name', 'inputId', 'outputId'].every(key => next[key] === suggestion[key]) ? suggestion : next;
}

export function shouldAutoOpenAudioSuggestion(next, previous, callState) {
  return Boolean(next && !previous && !callState.consultInProgress && !headsetCallInProgress(callState.call, callState.status));
}
