import { findAudioControlDevice } from './audio-control-match.mjs';
import { headsetDeviceKey } from './headset-control-service.mjs';

/** Keep the user's audio choice while the vendor's slower HID/SDK inventory arrives. */
export function createAudioControlSelection({ service, isCurrentAudio, onError = () => {}, now = Date.now, discoveryWindowMs = 20000 }) {
  let pending = null, selecting = false, disposed = false;
  const cancel = () => { pending = null; };
  const attempt = async () => {
    if (!pending || selecting || disposed) return false;
    const snapshot = service.getSnapshot();
    if (now() >= pending.until || !isCurrentAudio(pending.suggestion)
      || snapshot.state.callId || snapshot.state.active || snapshot.state.ringing
      || snapshot.selectedKey !== pending.previousKey || !snapshot.enabled) { cancel(); return false; }
    if (snapshot.busy) return false;
    const match = findAudioControlDevice(pending.suggestion, snapshot.devices);
    if (!match) return false;
    cancel();
    const key = headsetDeviceKey(match);
    if (snapshot.selectedKey === key && snapshot.sync === 'synced') return true;
    selecting = true;
    try { await service.selectDevice(key); return true; }
    finally { selecting = false; }
  };
  const unsubscribe = service.onChange(() => { void attempt().catch(onError); });
  return {
    async select(suggestion) {
      pending = { suggestion: { ...suggestion }, previousKey: service.getSnapshot().selectedKey, until: now() + discoveryWindowMs };
      return attempt();
    },
    cancel,
    dispose() { disposed = true; cancel(); unsubscribe(); },
  };
}
