import { HEADSET_COMMANDS, normalizeSoftphoneState } from "../headset-control-service.mjs";
import { findHeadsetCatalogEntry } from "../headset-device-catalog.js";

const DEFAULT_EP0S_URL = "wss://127.0.0.1:41088";
const DEFAULT_SOFTPHONE_NAME = "Telnyx Contact Center";
const WEBSOCKET_OPEN = 1;

function baseMessage(event, callId = null) {
  const message = { Event: event, EventType: "Request" };
  if (callId) message.CallID = callId;
  return message;
}

function getDeviceId(payload = {}, connectionState = "connected") {
  const productName = payload.ProductName || payload.HeadsetType || payload.DeviceName || payload.HeadsetName || payload.Model || null;
  const id = payload.HeadsetPath || payload.SerialNumber || payload.ProductId || payload.ProductID || productName || connectionState;
  return id ? String(id) : null;
}

function toDevice(payload = {}, connectionState = "connected") {
  const model = payload.DeviceName || payload.HeadsetName || payload.HeadsetType || payload.ProductName || payload.Model || null;
  const productName = payload.ProductName || payload.HeadsetType || model;
  const productId = payload.ProductId || payload.ProductID || null;
  const source = payload.Source || "epos-websocket";
  const isServiceOnly = source === "browser-media-device" || connectionState !== "connected";
  const baseDevice = {
    id: getDeviceId(payload, connectionState),
    vendor: "epos",
    vendorLabel: "EPOS/Sennheiser",
    model,
    productName,
    serialNumber: payload.SerialNumber || null,
    productId,
    transport: source,
    connectionState,
    battery: ((payload.BatteryLevel ?? payload.Battery) != null) ? { levelPercent: Number(payload.BatteryLevel ?? payload.Battery), charging: null, source: "sdk" } : null,
    capabilities: {
      answer: !isServiceOnly,
      reject: !isServiceOnly,
      hangup: !isServiceOnly,
      mute: !isServiceOnly,
      hold: !isServiceOnly,
      ring: !isServiceOnly,
      battery: (payload.BatteryLevel ?? payload.Battery) != null,
      donDoff: false,
      busylight: true,
    },
  };
  const catalogEntry = findHeadsetCatalogEntry(baseDevice);
  // EPOS reports BTD 800 as the active call-control endpoint, using the
  // dongle name for HeadsetConnected even when MB Pro 2 is paired. Artwork
  // classification must not override a registered SDK connection.
  return {
    ...baseDevice,
    deviceRole: catalogEntry?.role || null,
    connectionState,
    controlReady: !isServiceOnly,
    qualification: "unverified",
    capabilities: {
      ...baseDevice.capabilities,
      audio: !isServiceOnly,
    },
  };
}

function hasDeviceIdentity(payload = {}) {
  return Boolean(
    payload.HeadsetPath
      || payload.SerialNumber
      || payload.ProductName
      || payload.ProductId
      || payload.ProductID
      || payload.HeadsetType
      || payload.DeviceName
      || payload.HeadsetName
      || payload.Model
  );
}

function deviceMatchesIdentifier(device, identifier) {
  if (!device || !identifier) return false;
  const normalizedIdentifier = String(identifier);
  const hasStrongerIdentifier = Boolean(
    device.serialNumber
      || (device.id && (!device.productId || String(device.id) !== String(device.productId)))
  );
  const identifiers = [device.id, device.serialNumber];
  if (!hasStrongerIdentifier) identifiers.push(device.productId);
  return identifiers
    .filter(Boolean)
    .some((value) => String(value) === normalizedIdentifier);
}

function isAcknowledgement(payload = {}) {
  return String(payload.EventType || "").toLowerCase() === "acknowledgement";
}

function isNotification(payload = {}) {
  return String(payload.EventType || "").toLowerCase() === "notification";
}

function isHeadsetControlEvent(payload = {}) {
  return !isAcknowledgement(payload);
}

function isSuccessfulAcknowledgement(payload = {}) {
  if (!isAcknowledgement(payload)) return false;
  if (payload.ReturnCode === undefined || payload.ReturnCode === null || payload.ReturnCode === "") return true;
  return Number(payload.ReturnCode) === 0;
}

function formatSoftphoneName(name) {
  return String(name || DEFAULT_SOFTPHONE_NAME).trim() || DEFAULT_SOFTPHONE_NAME;
}

function isEposMediaDevice(device = {}) {
  const label = String(device.label || "").toLowerCase();
  return /epos|sennheiser/.test(label);
}

function mediaDeviceToPayload(device = {}) {
  const label = String(device.label || "").trim();
  return {
    DeviceName: label,
    HeadsetName: label,
    HeadsetType: label,
    HeadsetPath: device.deviceId || label,
    Source: "browser-media-device",
  };
}

export function createEposAdapter({
  WebSocketImpl = globalThis.WebSocket,
  url = process.env.NEXT_PUBLIC_EPOS_SDK_WS_URL || DEFAULT_EP0S_URL,
  softphoneName = process.env.NEXT_PUBLIC_EPOS_SOFTPHONE_NAME || DEFAULT_SOFTPHONE_NAME,
  reconnectDelayMs = 2000,
  disconnectConfirmationMs = 1200,
  transientDisconnectGraceMs = 5000,
  mediaDevices = globalThis.navigator?.mediaDevices,
  now = () => Date.now(),
  logger = null,
  acknowledgementTimeoutMs = 1800,
} = {}) {
  const commandSubscribers = new Set();
  const deviceSubscribers = new Set();
  const diagnosticSubscribers = new Set();
  let socket = null;
  let reconnectTimer = null;
  let disconnectTimer = null;
  let serviceDevice = null;
  let currentDevice = null;
  let currentDeviceConnectedAt = 0;
  let previousState = normalizeSoftphoneState();
  let pendingSoftphoneState = null;
  let softphoneRegistered = false;
  let initialized = false;
  let disposed = false;
  let selectedId = null, socketGeneration = 0, pendingAck = null, handshakeTimer = null, testTimer = null;
  let desiredState = normalizeSoftphoneState(), testActive = false;
  const failPending = (message) => { if (pendingAck) { const pending = pendingAck; pendingAck = null; clearTimeout(pending.timer); pending.reject(new Error(message)); } };
  const acknowledged = (message) => new Promise((resolve, reject) => {
    if (pendingAck) { reject(new Error("EPOS command already pending")); return; }
    const timer = setTimeout(() => {
      pendingAck = null; reject(new Error(`EPOS ${message.Event} acknowledgement timed out`));
      // A late ACK must never confirm a subsequent command on the same socket.
      softphoneRegistered = false; socket?.close?.(); emitServiceMissing(); scheduleReconnect();
    }, acknowledgementTimeoutMs);
    pendingAck = { event: message.Event, callId: message.CallID, resolve, reject, timer };
    if (!send(message)) failPending("EPOS service is not connected");
  });
  const handleMediaDeviceChange = () => {
    emitDiagnostic("Browser media-device change detected", "info");
    void reconcileBrowserMediaDevices("browser-devicechange");
  };

  const emitCommand = (command) => {
    logger?.info?.("[Headset][EPOS] command from headset", command);
    if (!selectedId || !softphoneRegistered || currentDevice?.id !== selectedId || !currentDevice?.controlReady) return;
    for (const subscriber of commandSubscribers) subscriber({ ...command, deviceId: selectedId, callId: desiredState.callId });
  };

  const emitDevice = (device) => {
    logger?.info?.("[Headset][EPOS] device state", device);
    for (const subscriber of deviceSubscribers) subscriber(device);
  };

  const emitCurrentDevice = () => emitDevice(currentDevice || serviceDevice || null);

  const emitDiagnostic = (message, level = "info", payload = null) => {
    const diagnostic = { message, level };
    if (payload) diagnostic.payload = payload;
    const logMethod = level === "error" ? "error" : level === "warn" ? "warn" : "info";
    logger?.[logMethod]?.(`[Headset][EPOS] ${message}`, payload || "");
    for (const subscriber of diagnosticSubscribers) subscriber(diagnostic);
  };

  const clearDisconnectTimer = () => {
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };

  const scheduleDisconnectConfirmation = (delayMs = disconnectConfirmationMs) => {
    clearDisconnectTimer();
    disconnectTimer = setTimeout(() => {
      disconnectTimer = null;
      currentDevice = null;
      emitCurrentDevice();
    }, delayMs);
    disconnectTimer.unref?.();
  };

  const markCurrentDevice = (payload, connectionState = "connected") => {
    clearDisconnectTimer();
    currentDevice = toDevice(payload, connectionState);
    currentDevice.controlReady = currentDevice.controlReady && softphoneRegistered;
    currentDeviceConnectedAt = now();
    emitCurrentDevice();
  };

  const reconcileBrowserMediaDevices = async (reason = "manual") => {
    if (!mediaDevices?.enumerateDevices) return;
    try {
      const devices = await mediaDevices.enumerateDevices();
      const audioDevices = devices.filter((device) => device.kind === "audioinput" || device.kind === "audiooutput");
      const labeledAudioDevices = audioDevices.filter((device) => String(device.label || "").trim());
      const eposDevice = labeledAudioDevices.find(isEposMediaDevice);
      emitDiagnostic(
        `Browser media-device scan (${reason}): ${eposDevice ? eposDevice.label : "no EPOS/Sennheiser audio device"}`,
        eposDevice ? "info" : "warn",
        { reason, audioDeviceLabels: labeledAudioDevices.map((device) => device.label) }
      );
      if (disposed) return;
      if (eposDevice && (!currentDevice || currentDevice.transport === "browser-media-device")) {
        markCurrentDevice(mediaDeviceToPayload(eposDevice), "audio-only");
      } else if (labeledAudioDevices.length && currentDevice?.transport === "browser-media-device") {
        currentDevice = null;
        emitCurrentDevice();
      }
    } catch (error) {
      emitDiagnostic("Browser media-device scan failed", "warn", { reason, message: error?.message || String(error) });
    }
  };

  const isSocketOpen = () => socket?.readyState === WEBSOCKET_OPEN;

  const send = (message) => {
    if (!isSocketOpen() || typeof socket.send !== "function") {
      logger?.warn?.("[Headset][EPOS] dropped outgoing message because websocket is not open", message);
      return false;
    }
    emitDiagnostic(`EPOS outgoing ${message.Event}`, "info", message);
    logger?.debug?.("[Headset][EPOS] outgoing", message);
    socket.send(JSON.stringify(message));
    return true;
  };

  const handleMessage = (event) => {
    let payload = null;
    try {
      payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch (_) {
      return;
    }
    if (!payload?.Event) return;

    const eventName = String(payload.Event);
    if (isAcknowledgement(payload) && pendingAck?.event === eventName) {
      if (payload.CallID && pendingAck.callId && String(payload.CallID) !== String(pendingAck.callId)) return;
      const pending = pendingAck; pendingAck = null; clearTimeout(pending.timer);
      if (isSuccessfulAcknowledgement(payload)) pending.resolve();
      else { const message = `EPOS ${eventName} rejected (${payload.ReturnCode})`; emitDiagnostic(message, "error"); pending.reject(new Error(message)); }
      return;
    }
    emitDiagnostic(`EPOS ${eventName}${payload.EventType ? ` (${payload.EventType})` : ""}`, "info", payload);

    if (/SocketConnected/i.test(eventName)) {
      serviceDevice = toDevice({ ProductName: "EPOS Connect" }, "service-connected");
      emitCurrentDevice();
      sendRegistration();
      return;
    }

    if (/EstablishConnection/i.test(eventName) && isAcknowledgement(payload)) {
      if (!isSuccessfulAcknowledgement(payload)) {
        emitDiagnostic("EPOS EstablishConnection was rejected", "error", payload);
        softphoneRegistered = false;
        return;
      }
      send(baseMessage("SPLoggedIn"));
      return;
    }

    if (/SPLoggedIn/i.test(eventName) && isAcknowledgement(payload)) {
      if (!isSuccessfulAcknowledgement(payload)) {
        emitDiagnostic("EPOS softphone login was rejected", "error", payload);
        softphoneRegistered = false;
        return;
      }
      softphoneRegistered = true;
      clearTimeout(handshakeTimer);
      if (currentDevice?.transport === "epos-websocket") { currentDevice.controlReady = currentDevice.connectionState === "connected"; emitCurrentDevice(); }
      send(baseMessage("SystemInformation"));
      // Login publishes HeadsetConnected. ActiveDeviceChanged is a setter, not
      // an inventory query: sending it without an identity deselects the real
      // headset in EPOS Connect (confirmed with macOS Connect 8.7 / SC230).
      void reconcileBrowserMediaDevices("login");
      // The service restores the selected device and current state after discovery.
      return;
    }

    if (/HeadsetConnected|DeviceConnected/i.test(eventName) && isNotification(payload)) {
      if (!hasDeviceIdentity(payload)) return;
      clearDisconnectTimer();
      markCurrentDevice(payload, "connected");
      return;
    }

    if (/ActiveDeviceChanged/i.test(eventName)) {
      if (isNotification(payload) && hasDeviceIdentity(payload)) {
        markCurrentDevice(payload, "connected");
      }
      return;
    }

    if (/HeadsetDisconnected|DeviceDisconnected/i.test(eventName) && isNotification(payload)) {
      const disconnectedDeviceId = getDeviceId(payload, null);
      if (currentDevice && disconnectedDeviceId && !deviceMatchesIdentifier(currentDevice, disconnectedDeviceId)) {
        return;
      }
      void reconcileBrowserMediaDevices("headset-disconnected");
      if (currentDevice && !disconnectedDeviceId) {
        emitDiagnostic(`EPOS ${eventName}: notification had no device identity; keeping current device until EPOS reports an identified disconnect`, "warn", payload);
        return;
      }
      clearDisconnectTimer();
      if (currentDevice && now() - currentDeviceConnectedAt < transientDisconnectGraceMs) {
        const remainingGraceMs = Math.max(transientDisconnectGraceMs - (now() - currentDeviceConnectedAt), 0);
        emitDiagnostic(`EPOS ${eventName}: deferring transient disconnect confirmation until grace window expires`, "warn", payload);
        scheduleDisconnectConfirmation(remainingGraceMs + disconnectConfirmationMs);
        return;
      }
      emitDiagnostic(`EPOS ${eventName}: confirming active device`, "warn", payload);
      scheduleDisconnectConfirmation();
      return;
    }

    if (payload.CallID && String(payload.CallID) !== desiredState.callId) return;

    if (/InCallAccepted|DNDIncomingCallAccepted|InCallAcceptedOnOffhook/i.test(eventName) && isHeadsetControlEvent(payload)) {
      emitCommand(previousState.held
        ? { type: HEADSET_COMMANDS.HOLD, held: false, source: "headset" }
        : { type: HEADSET_COMMANDS.ANSWER, source: "headset" });
    } else if (/OffHook/i.test(eventName) && isHeadsetControlEvent(payload)) {
      if (previousState.held) {
        emitCommand({ type: HEADSET_COMMANDS.HOLD, held: false, source: "headset" });
      } else if (previousState.ringing) {
        emitCommand({ type: HEADSET_COMMANDS.ANSWER, source: "headset" });
      }
    } else if (/InCallRejected/i.test(eventName) && isHeadsetControlEvent(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.REJECT, source: "headset" });
    } else if (/CallEnded|OnHook/i.test(eventName) && isHeadsetControlEvent(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.HANGUP, source: "headset" });
    } else if (/UnmuteSoftphone/i.test(eventName) && isHeadsetControlEvent(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: false, source: "headset" });
    } else if (/MuteSoftphone/i.test(eventName) && isHeadsetControlEvent(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: true, source: "headset" });
    } else if (/UnmuteHeadset/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: false, source: "headset" });
    } else if (/MuteHeadset/i.test(eventName) && isNotification(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.MUTE, muted: true, source: "headset" });
    } else if (/CallHold|ConfCallOnHold/i.test(eventName) && isHeadsetControlEvent(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.HOLD, held: true, source: "headset" });
    } else if (/HeldCallResumed|HeldConfCallResumed/i.test(eventName) && isHeadsetControlEvent(payload)) {
      emitCommand({ type: HEADSET_COMMANDS.HOLD, held: false, source: "headset" });
    }
  };

  const emitServiceMissing = () => {
    serviceDevice = {
      id: "epos-service-missing",
      vendor: "epos",
      vendorLabel: "EPOS/Sennheiser",
      model: null,
      productName: "EPOS Connect",
      transport: "epos-websocket",
      connectionState: "service-missing",
      capabilities: {},
    };
    currentDevice = null;
    emitCurrentDevice();
  };

  const scheduleReconnect = () => {
    if (disposed || !reconnectDelayMs || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  };

  const sendRegistration = () => {
    softphoneRegistered = false;
    send({
      Event: "EstablishConnection",
      EventType: "Request",
      SPName: formatSoftphoneName(softphoneName),
      SPIconImage: "telnyx-contact-center.ico",
      RedialSupport: "No",
      OffHookSupport: "Yes",
      MuteSupport: "Yes",
      DNDOption: "No",
    });
  };

  const applySoftphoneState = async (input) => {
    const next = { ...input, active: input.active || Boolean(input.callId && input.direction === "outgoing") };
    if (!selectedId || currentDevice?.id !== selectedId || !softphoneRegistered) return;
    const version = socketGeneration;
    const callId = next.callId || previousState.callId;
    if (!callId) return;
    const previous = previousState;
    const messages = [];
    if (previous.callId && next.callId !== previous.callId && (previous.active || previous.ringing)) messages.push(baseMessage("CallEnded", previous.callId));
    const changedCall = previous.callId !== next.callId;
    if (next.ringing && (!previous.ringing || changedCall)) messages.push(baseMessage("IncomingCall", callId));
    if (next.active && (!previous.active || changedCall)) messages.push(baseMessage(next.direction === "outgoing" ? "OutgoingCall" : "InCallAccepted", callId));
    if (next.active && (next.muted !== previous.muted || changedCall)) messages.push(baseMessage(next.muted ? "MuteHeadset" : "UnmuteHeadset", callId));
    if (next.active && (next.held !== previous.held || (changedCall && next.held))) messages.push(baseMessage(next.held ? "CallHold" : "HeldCallResumed", callId));
    if (!next.active && !next.ringing && !changedCall && (previous.active || previous.ringing)) messages.push(baseMessage("CallEnded", callId));
    try {
      for (const message of messages) {
        if (version !== socketGeneration || disposed) throw new Error("EPOS connection changed");
        await acknowledged(message);
        // Commit each acknowledged transition. Retrying after a later failure does not repeat call start.
        if (["IncomingCall", "OutgoingCall", "InCallAccepted", "CallEnded"].includes(message.Event)) {
          previousState = { ...previousState, callId: message.CallID, ringing: message.Event === "IncomingCall", active: ["OutgoingCall", "InCallAccepted"].includes(message.Event) };
        }
        if (["MuteHeadset", "UnmuteHeadset"].includes(message.Event)) previousState.muted = message.Event === "MuteHeadset";
        if (["CallHold", "HeldCallResumed"].includes(message.Event)) previousState.held = message.Event === "CallHold";
      }
      previousState = next;
    } catch (error) { emitDiagnostic(error.message, "error"); throw error; }
  };

  const connect = () => {
    if (disposed || !WebSocketImpl) {
      emitServiceMissing();
      return;
    }
    try {
      const version = ++socketGeneration;
      if (socket) { socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.close?.(); }
      socket = new WebSocketImpl(url);
      socket.onmessage = event => { if (!disposed && version === socketGeneration) handleMessage(event); };
      clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => { if (!disposed && !softphoneRegistered && version === socketGeneration) { emitDiagnostic("EPOS registration timed out", "error"); socket.close?.(); emitServiceMissing(); scheduleReconnect(); } }, 8000);
      handshakeTimer.unref?.();
      socket.onopen = () => {
        if (disposed || version !== socketGeneration) return;
        serviceDevice = toDevice({ ProductName: "EPOS Connect" }, "service-connected");
        emitDiagnostic("EPOS websocket connected", "info");
        emitCurrentDevice();
      };
      socket.onerror = () => {
        if (disposed || version !== socketGeneration) return;
        failPending("EPOS connection failed"); clearTimeout(handshakeTimer);
        emitDiagnostic("EPOS websocket error", "warn");
        emitServiceMissing();
        softphoneRegistered = false;
        pendingSoftphoneState = desiredState;
        previousState = normalizeSoftphoneState();
        scheduleReconnect();
      };
      socket.onclose = () => {
        if (!disposed && version === socketGeneration) {
          failPending("EPOS connection closed"); clearTimeout(handshakeTimer);
          emitDiagnostic("EPOS websocket closed", "warn");
          emitServiceMissing();
          softphoneRegistered = false;
          pendingSoftphoneState = desiredState;
          previousState = normalizeSoftphoneState();
          scheduleReconnect();
        }
      };
    } catch (_) {
      emitServiceMissing();
      scheduleReconnect();
    }
  };

  return {
    vendor: "epos",

    async init() {
      if (initialized) return;
      initialized = true;
      disposed = false;
      if (!WebSocketImpl) {
        emitServiceMissing();
        return;
      }
      connect();
      mediaDevices?.addEventListener?.("devicechange", handleMediaDeviceChange);
    },

    onCommand(callback) {
      commandSubscribers.add(callback);
      return () => commandSubscribers.delete(callback);
    },

    onDeviceChange(callback) {
      deviceSubscribers.add(callback);
      return () => deviceSubscribers.delete(callback);
    },

    onDiagnostic(callback) {
      diagnosticSubscribers.add(callback);
      return () => diagnosticSubscribers.delete(callback);
    },

    async setSelectedDevice(id) {
      if (id && (id !== currentDevice?.id || !currentDevice?.controlReady)) throw new Error("EPOS call control is not ready for this device.");
      selectedId = id; previousState = normalizeSoftphoneState(); pendingSoftphoneState = null;
    },

    async setSoftphoneState(state) {
      clearTimeout(testTimer);
      const next = normalizeSoftphoneState(state);
      desiredState = next;
      if (testActive) { testActive = false; await acknowledged(baseMessage("CallEnded", "headset-test")); }
      emitDiagnostic("EPOS softphone state", "info", next);
      if (!isSocketOpen() || !softphoneRegistered) {
        pendingSoftphoneState = next;
        emitDiagnostic("EPOS softphone state queued until websocket login completes", "warn", {
          socketOpen: isSocketOpen(),
          softphoneRegistered,
          next,
        });
        return;
      }
      await applySoftphoneState(next);
    },

    async sendTestCommand(command) {
      if (desiredState.callId || desiredState.active || desiredState.ringing) throw new Error("Finish the call before testing the headset.");
      if (!selectedId || !softphoneRegistered) throw new Error("Select an EPOS headset first.");
      clearTimeout(testTimer);
      if (command === "ring") { testActive = true; await acknowledged(baseMessage("IncomingCall", "headset-test")); testTimer = setTimeout(() => { testActive = false; void acknowledged(baseMessage("CallEnded", "headset-test")).catch(err => emitDiagnostic(err.message, "error")); }, 3000); }
      if (command === "reset") await acknowledged(baseMessage("CallEnded", "headset-test"));
    },

    async dispose() {
      disposed = true; socketGeneration++; selectedId = null; clearTimeout(handshakeTimer); clearTimeout(testTimer); failPending("EPOS integration stopped");
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      mediaDevices?.removeEventListener?.("devicechange", handleMediaDeviceChange);
      clearDisconnectTimer();
      try {
        if (desiredState.callId) send(baseMessage("CallEnded", desiredState.callId));
        if (testActive) send(baseMessage("CallEnded", "headset-test"));
        send(baseMessage("SPLoggedOut"));
        send(baseMessage("TerminateConnection"));
        socket?.close?.();
      } catch (_) {}
      socket = null;
      initialized = false;
      serviceDevice = null;
      currentDevice = null;
      currentDeviceConnectedAt = 0;
      pendingSoftphoneState = null;
      softphoneRegistered = false;
      previousState = normalizeSoftphoneState();
    },
  };
}
