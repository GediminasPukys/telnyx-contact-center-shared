/** Acquire the microphone before reserving ACD capacity or ringing a handset. */
export async function acquireCallAudio({ mediaDevices, router }) {
  if (!mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable in this browser.");
  const devices = await mediaDevices.enumerateDevices();
  await router?.checkDevices(devices);
  const route = router?.getSnapshot() || {};
  if (route.error) throw new Error(route.error);
  try {
    const stream = await mediaDevices.getUserMedia({
      audio: route.inputId && route.inputId !== "default" ? { deviceId: { exact: route.inputId } } : true,
      video: false,
    });
    if (!stream.getAudioTracks().some(t => t.readyState === "live")) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error("No microphone is available. Connect a microphone and try again.");
    }
    return stream;
  } catch (error) {
    if (["NotFoundError", "OverconstrainedError"].includes(error.name)) throw new Error("No microphone is available. Connect a microphone and try again.");
    if (error.name === "NotAllowedError") throw new Error("Allow microphone access in your browser and system settings, then try again.");
    throw error;
  }
}
