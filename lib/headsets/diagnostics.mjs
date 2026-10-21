/** A portable qualification report without serials, call IDs or audio payloads. */
export function createHeadsetDiagnostics({ status, sync, device, devices = [], audio = {}, diagnostics = [] }, environment = {}) {
  const summarize = value => value ? {
    vendor: value.vendor, model: value.model, transport: value.transport,
    vendorId: value.vendorId, productId: value.productId,
    connectionState: value.connectionState, capabilities: value.capabilities,
    qualification: value.qualification, reports: value.reports,
  } : null;
  return { capturedAt: new Date().toISOString(), status, sync,
    environment: { secureContext: environment.secureContext, webHid: environment.webHid, audioOutputSelection: environment.audioOutputSelection },
    device: summarize(device), devices: devices.map(summarize),
    audio: { microphoneSelected: Boolean(audio.inputId), speakerSelected: Boolean(audio.outputId), error: audio.error },
    events: diagnostics.map(({ at, vendor, level, message, type }) => ({ at, vendor, level, message, type })) };
}
