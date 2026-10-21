"use client";
import NativeSoftphone from "@/components/telephony/NativeSoftphone";
import { usePhoneChoice } from "@/components/telephony/use-phone-choice";
import { MiniPhoneSurface } from "@/components/telephony/PhoneSurface";
import { useUiText } from "@/components/i18n/use-ui-text";


import { prepareWebrtcAudio } from "@/lib/headsets/client-headset-service";
import { voiceFetch } from "@/lib/telephony/endpoint-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTelnyx } from "@/components/telephony-provider";
import { usePhoneUi } from "@/components/phone-ui-provider";
import useActiveCallStore, {
  useActiveCall,
  useIsRinging,
  useCallerInfo,
  useCallUI,
} from "@/lib/stores/active-call-store";
import useDialStore from "@/lib/stores/dial-store";
import useCallsStore from "@/lib/stores/calls-store";
import {
  lookupCallMetadata,
  lookupCustomerName,
  getStoredCallerInfo,
} from "@/lib/helpers/lookup-call-info";
import { TransferModal } from "@/components/contact-center/TransferModal";
import { HandoffMoveButton } from "@/components/contact-center/handoff/HandoffEntry";
import useDeviceHandoffStore from "@/lib/stores/device-handoff-store";
import { NumberSelectionModal } from "@/components/contact-center/NumberSelectionModal";
import { VoiceRecoveryBadge } from "@/components/voice-recovery-badge";
import { HeadsetStatusBadge } from "@/components/headsets/HeadsetStatusBadge";
import { createHeadsetCommandController, headsetCallInProgress } from "@/lib/headsets/call-controller.mjs";
import { callStateActions } from "@/lib/headsets/client-call-actions";
import { useHeadsetAccess } from "@/lib/headsets/use-headset-access";
import { getHeadsetControlService, startHeadsetSession, isHeadsetIntegrationEnabled, getHeadsetAudioRouter, setHeadsetAudioClient, refreshHeadsetAudioDevices } from "@/lib/headsets/client-headset-service";
import { notify } from "@/components/ToastNotify";
import { interactionCallControls,matchesInteractionCall,voiceInteractionPhase } from "@/lib/telephony/interaction-controls.mjs";
import {
  cancelUnstartedWebrtcIntent,
  claimWebrtcDialFailure,
  describeWebrtcDialFailure,
  directIntentIdFromCall,
  isWebrtcDialFailureState,
  markWebrtcCallConnected,
  shouldHandleWebrtcDialFailure,
} from "@/lib/webrtc-dial-failure";

const readWebrtcBooleanFlag = (storageKey, envValue = "false") => {
  const normalize = (value) =>
    ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());

  if (typeof window !== "undefined") {
    try {
      const storedValue = localStorage.getItem(storageKey);
      if (storedValue !== null) {
        return normalize(storedValue);
      }
    } catch (_) {}
  }

  return normalize(envValue);
};

const getWebrtcExperimentalOptions = () => ({
  prefetchIceCandidates: readWebrtcBooleanFlag(
    "webrtc.prefetchIceCandidates",
    process.env.NEXT_PUBLIC_TELNYX_WEBRTC_PREFETCH_ICE_CANDIDATES
  ),
});

function isValidE164(number) {
  return /^\+?[1-9]\d{6,14}$/.test(String(number || "").trim());
}
function isValidSipUri(input) {
  return /^sip:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(input || "").trim());
}
function isValidDialTo(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  return /^[1-9]\d{2,4}$/.test(v) || isValidE164(v) || isValidSipUri(v);
}

export default function SoftphoneMini() {
  const choice = usePhoneChoice();
  return ["deskphone", "sip"].includes(choice?.kind) ? <NativeSoftphone mini /> : <WebrtcSoftphoneMini />;
}

function WebrtcSoftphoneMini() {
  const tUi = useUiText();
  const { client, status: telephonyStatus } = useTelnyx();
  const { toggle } = usePhoneUi();
  const headsetAccess = useHeadsetAccess();
  const headsetEnabled = headsetAccess.enabled && isHeadsetIntegrationEnabled();
  const headsetVendorsKey = headsetAccess.vendors.join(",");
  const [headsetRetry, setHeadsetRetry] = useState(0);

  // Zustand stores - call state
  const activeCall = useActiveCall();
  const isRinging = useIsRinging();
  const callerInfo = useCallerInfo();
  const callUI = useCallUI();
  const callStatus = useActiveCallStore((state) => state.status);
  const headsetHasCall = headsetCallInProgress(activeCall, callStatus);
  const activeCallDirection = useActiveCallStore((state) => state.direction);
  const testInteractionId = useActiveCallStore((state) => state.contactCenter?.interactionId);
  const recoveredCallHeaders = useActiveCallStore((state) => state.recoveredCallHeaders);
  const callHeaders = [activeCall?.options?.customHeaders, activeCall?.inviteCustomHeaders, activeCall?.customHeaders, recoveredCallHeaders].filter(Array.isArray).flat();
  const callHeader = (name) => callHeaders.find(h => String(h.name).toLowerCase() === name)?.value || "";

  // Zustand stores - dial state
  const { toNumber, setToNumber: setDialToNumber } = useDialStore();

  // Active call store actions
  const {
    setActiveCall,
    updateStatus,
    setMuted: storeSetMuted,
    setHeld: storeSetHeld,
    setCallerName,
    setCallerInfo,
    clearActiveCall,
    isContactCenterCall,
    getCallDuration,
  } = useActiveCallStore();

  // Check if call is connected/answered (CTI buttons should only show when connected)
  // Check both store status and call object state to handle all cases (inbound/outbound, direct/contact center)
  // Use useMemo to ensure this recalculates when status changes
  const isCallConnected = useMemo(() => {
    if (!activeCall) return false;

    const callObjectState = activeCall?.state
      ? String(activeCall.state).toLowerCase()
      : null;
    const storeStatus = callStatus ? String(callStatus).toLowerCase() : null;
    const connectedStates = ["active", "connected", "answered", "held"];

    // Prioritize store status (most reliable), fallback to call object state
    return (
      (storeStatus && connectedStates.includes(storeStatus)) ||
      (callObjectState && connectedStates.includes(callObjectState))
    );
  }, [activeCall, callStatus]);

  // Local UI state
  const [toInput, setToInput] = useState(toNumber || "");
  const [showTransfer, setShowTransfer] = useState(false);
  const [cardTransferInteraction,setCardTransferInteraction]=useState(null);
  const [showNumberModal, setShowNumberModal] = useState(false);
  const [interaction, setInteraction] = useState(null);
  const [outboundCallerName, setOutboundCallerName] = useState("");
  const headsetCommandHandlersRef = useRef({});
  const formatCallerIdentity = (name, number) => {
    const normalizedName = String(name || "").trim();
    const normalizedNumber = String(number || "").trim();
    if (normalizedName && normalizedNumber && normalizedName !== normalizedNumber) {
      return `${normalizedName} (${normalizedNumber})`;
    }
    return normalizedNumber || normalizedName;
  };

  const interactionFromNumber =
    interaction?.from_number || interaction?.fromNumber || interaction?.caller_number || "";
  const remoteCallerNumber = activeCall?.options?.remoteCallerNumber || activeCall?.remoteCallerNumber || "";
  const remoteCallerName = activeCall?.options?.remoteCallerName || activeCall?.remoteCallerName || "";
  const incomingFromNumber = remoteCallerNumber || interactionFromNumber || callerInfo?.fromNumber || "";
  const incomingFromName = remoteCallerName || callerInfo?.fromName || interaction?.from_name || interaction?.fromName || "";
  const incomingCallerDisplay = formatCallerIdentity(incomingFromName, incomingFromNumber);
  const isIncomingCall =
    activeCall &&
    (activeCallDirection === "inbound" || activeCallDirection === "incoming");
  const isOutboundCall = activeCall && activeCallDirection === "outbound";
  const miniInputDisplay = isIncomingCall && incomingCallerDisplay ? incomingCallerDisplay : toInput;
  const shouldMarqueeMiniInput = Boolean(isIncomingCall && incomingCallerDisplay && incomingCallerDisplay.length > 18);

  headsetCommandHandlersRef.current = {
    call: activeCall,
    answer: handleAnswerCall,
    reject: handleRejectCall,
    hangup,
    mute: toggleMute,
    hold: toggleHold,
    setMuted: callStateActions.setMuted,
    setHeld: callStateActions.setHeld,
    transfer: target=>{setCardTransferInteraction(target);setShowTransfer(true);},
  };

  useEffect(()=>interactionCallControls.register({
    getState:useActiveCallStore.getState,
    getHandlers:()=>headsetCommandHandlersRef.current,
  }),[]);

  useEffect(()=>{
    const state=useActiveCallStore.getState();
    if(cardTransferInteraction&&!state.consultInProgress&&(!matchesInteractionCall(cardTransferInteraction,state)||voiceInteractionPhase(cardTransferInteraction,state)==="ended")){
      setShowTransfer(false);setCardTransferInteraction(null);
    }
  },[activeCall,callStatus,testInteractionId,cardTransferInteraction]);

  useEffect(() => {
    const retry = () => setHeadsetRetry(value => value + 1);
    window.addEventListener("headsets:retry", retry);
    return () => window.removeEventListener("headsets:retry", retry);
  }, []);

  useEffect(() => {
    if (!headsetEnabled) return;
    const stop = startHeadsetSession({ vendors: headsetVendorsKey.split(",").filter(Boolean), ownerId: headsetAccess.userId });
    const service = getHeadsetControlService();
    const controller = createHeadsetCommandController({
      getState: useActiveCallStore.getState, getHandlers: () => headsetCommandHandlersRef.current,
      isCurrent: command => service.isCurrentCommand(command),
      onError: error => notify({ title: "Headset control failed", description: error.message, variant: "error" }),
    });
    const off = service.onCommand(command => controller.execute(command));
    return () => { off(); stop(); };
  }, [headsetEnabled, headsetVendorsKey, headsetAccess.userId, headsetRetry]);

  useEffect(() => {
    if (!headsetEnabled) return;
    void getHeadsetControlService()?.setSoftphoneState(headsetHasCall ? {
      callId: activeCall?.callControlId || activeCall?.call_control_id || activeCall?.id || null,
      direction: isIncomingCall ? "incoming" : isOutboundCall ? "outgoing" : null,
      ringing: Boolean(isIncomingCall && isRinging), active: Boolean(isCallConnected),
      muted: Boolean(callUI.isMuted), held: Boolean(callUI.isHeld),
    } : {});
  }, [activeCall, headsetHasCall, callUI.isHeld, callUI.isMuted, isCallConnected, isIncomingCall, isOutboundCall, isRinging, headsetEnabled, headsetVendorsKey, headsetAccess.userId, headsetRetry]);

  const fromRef = useRef("");
  const audioRef = useRef(null);
  useEffect(() => {
    setHeadsetAudioClient(client);
    const router = getHeadsetAudioRouter();
    const unregister = router?.registerElement(audioRef.current);
    let disposed = false;
    void refreshHeadsetAudioDevices().then(() => { if (!disposed) void router?.applyToCall(); });
    const changed = () => { void refreshHeadsetAudioDevices(); };
    navigator.mediaDevices?.addEventListener("devicechange", changed);
    return () => { disposed = true; unregister?.(); navigator.mediaDevices?.removeEventListener("devicechange", changed); };
  }, [client, activeCall, isCallConnected]);
  useEffect(() => {
    const attach = event => attachAudio(event.detail?.call || useActiveCallStore.getState().call);
    window.addEventListener("softphone:attach-audio", attach);
    return () => window.removeEventListener("softphone:attach-audio", attach);
  });
  // Fetch interaction when call is active
  // This works for BOTH contact center calls AND by looking up any incoming call
  // Track the last interaction we fetched to prevent repeated API calls
  const lastFetchedInteractionIdRef = useRef(null);
  const applyContactCenterMetadata = (interaction) => {
    if (!interaction?.id) return;
    useActiveCallStore.getState().setContactCenterMetadata({
      interactionId: interaction.id,
      queueName: interaction.queue_name || interaction.queueName || null,
      queuedAt: interaction.enqueued_at || interaction.queuedAt || null,
      assignedAt: interaction.assigned_at || interaction.assignedAt || null,
      customerId: interaction.customer_id || interaction.customerId || null,
      customerData:
        interaction.customer_data || interaction.customerData || null,
      metadata: interaction.metadata || null,
    });
  };

  useEffect(() => {
    // Fetch full interaction data for any call that might have an interaction
    if (activeCall) {
      const storeState = useActiveCallStore.getState();

      // For contact center calls, we have the interactionId from metadata
      let interactionId =
        testInteractionId || storeState.contactCenter?.interactionId;

      // For incoming calls, check the incoming call store first (fastest method)
      // The SSE event from webrtc-bridge includes the interaction ID
      if (!interactionId) {
        const callControlId =
          activeCall.callControlId ||
          activeCall.call_control_id ||
          activeCall.id;

        // Try to get interaction ID from incoming call store first
        // The SSE event should have populated this with the interaction ID
        (async () => {
          try {
            const { getIncomingCallData } = await import(
              "@/lib/incoming-call-store"
            );

            // Try immediate lookup first
            let callData = getIncomingCallData(callControlId);

            // If not found by call_control_id, try the "latest" key
            // This handles the case where the WebRTC SDK uses a different call_control_id
            if (!callData?.interactionId) {
              const latestData = getIncomingCallData("__latest_incoming__");

              // Only use latest data if it's fresh (within last 10 seconds)
              if (
                latestData?.timestamp &&
                Date.now() - latestData.timestamp < 10000
              ) {
                callData = latestData;
              }
            }

            // If still not found, wait a bit for SSE event to arrive and try again
            if (!callData?.interactionId) {
              await new Promise((resolve) => setTimeout(resolve, 500)); // Wait 500ms

              callData = getIncomingCallData(callControlId);
              if (!callData?.interactionId) {
                // Try latest again after waiting
                const latestData = getIncomingCallData("__latest_incoming__");
                if (
                  latestData?.timestamp &&
                  Date.now() - latestData.timestamp < 10000
                ) {
                  callData = latestData;
                }
              }
            }

            if (callData?.interactionId) {
              interactionId = callData.interactionId;

              // Fetch the full interaction by ID
              if (
                interactionId &&
                interactionId !== lastFetchedInteractionIdRef.current
              ) {
                const res = await voiceFetch(
                  `/api/contact-center/interactions/${interactionId}`
                );
                const data = await res.json();

                if (data.ok && data.interaction) {
                  lastFetchedInteractionIdRef.current = interactionId;
                  setInteraction(data.interaction);
                  applyContactCenterMetadata(data.interaction);
                } else {
                  lastFetchedInteractionIdRef.current = null;
                  setInteraction(null);
                }
              }
              return;
            }
          } catch (err) {
            // Error checking incoming call store
          }

          // Fallback: Fetch interaction by looking up this call in the database
          if (
            callControlId &&
            callControlId !== lastFetchedInteractionIdRef.current
          ) {
            try {
              const res = await voiceFetch(
                `/api/contact-center/interactions/by-call-control-id?callControlId=${encodeURIComponent(
                  callControlId
                )}`
              );
              const data = await res.json();

              if (data.ok && data.interaction) {
                lastFetchedInteractionIdRef.current = callControlId;
                setInteraction(data.interaction);
                applyContactCenterMetadata(data.interaction);
              } else {
                lastFetchedInteractionIdRef.current = null;
                setInteraction(null);
              }
            } catch (err) {
              lastFetchedInteractionIdRef.current = null;
              setInteraction(null);
            }
          }
        })();
        return;
      }

      // Fetch by interactionId if we have one (from contact center metadata)
      if (
        interactionId &&
        interactionId !== lastFetchedInteractionIdRef.current
      ) {
        const fetchInteraction = async () => {
          try {
            const res = await voiceFetch(
              `/api/contact-center/interactions/${interactionId}`
            );
            const data = await res.json();

            if (data.ok && data.interaction) {
              lastFetchedInteractionIdRef.current = interactionId;
              setInteraction(data.interaction);
              applyContactCenterMetadata(data.interaction);
            } else {
              lastFetchedInteractionIdRef.current = null;
              setInteraction(null);
            }
          } catch (err) {
            lastFetchedInteractionIdRef.current = null;
            setInteraction(null);
          }
        };
        fetchInteraction();
      }
    } else {
      // Call ended, clear interaction
      lastFetchedInteractionIdRef.current = null;
      setInteraction(null);
    }
  }, [activeCall, callStatus, testInteractionId]);

  // Sync toInput with store toNumber
  useEffect(() => {
    if (toNumber !== toInput) {
      setToInput(toNumber || "");
    }
  }, [toNumber]);

  // Listen for incoming calls
  useEffect(() => {
    if (!client) return;

    const onNotification = (notification) => {
      try {
        if (notification.type === "callUpdate" || notification?.call) {
          const call = notification?.call || null;
          const callState = call?.state || notification?.call?.state || "";
          if (useActiveCallStore.getState().adoptRecoveredCall(call)) {
            wireCall(call);
            lastWiredCallRef.current = call;
          }

          // Detect call end states - when call object is missing or in end state
          if (!call) {
            // A callUpdate without a call identity cannot prove which SDK leg
            // ended. This occurs while consult replaces the original leg; an
            // ambiguous notification must never clear the new active call.
            return;
          }
          if (
            [
              "done",
              "hangup",
              "ended",
              "destroy",
              "purge",
              "idle",
              "terminated",
              "failed",
            ].includes(callState.toLowerCase())
          ) {
            // If we have an active call and it just ended
            if (activeCall && useActiveCallStore.getState().call === call) {
              handleCallEnd();
            }
            return;
          }

          if (call) {
            // Reattached inbound calls do not pass through the Answer button,
            // and their stream can arrive after the replacement object.
            if (useActiveCallStore.getState().call === call &&
                ["active", "connected", "answered"].includes(callState.toLowerCase())) {
              updateStatus(callState.toLowerCase());
              attachAudio(call);
              if (call.recoveredCallId) {
                for (const delay of [100, 300, 1000]) setTimeout(() => attachAudio(call), delay);
              }
            }
            const callDirection =
              call.direction || notification?.call?.direction || "";
            const fromNumber =
              call.options?.remoteCallerNumber ||
              call.remoteCallerNumber ||
              call.from ||
              call.callerId ||
              call.caller_id ||
              "";
            const fromName =
              call.options?.remoteCallerName || call.remoteCallerName || "";

            // Determine if this is an incoming call
            // Priority:
            // 1. If direction is explicitly "outbound" -> NOT incoming
            // 2. If direction is explicitly "inbound" or "incoming" -> incoming
            // 3. If we already have an active call -> NOT incoming (it's a notification for our outbound call)
            // 4. If no active call AND state is new/ringing -> incoming (default assumption for notifications without direction)
            const isIncoming =
              callDirection === "outbound"
                ? false
                : callDirection === "inbound" || callDirection === "incoming"
                ? true
                : activeCall
                ? false // We have an active call, so this is our outbound call
                : callState === "new" || callState === "ringing"; // No active call + ringing = incoming

            // Detect incoming call - can be in "new" or "ringing" state
            // Only show answer UI for truly incoming calls
            const isIncomingCall =
              isIncoming && (callState === "new" || callState === "ringing");

            // WebRTC SDK remote caller fields are the source of truth for inbound UI.
            if (isIncoming && (fromNumber || fromName)) {
              const storeState = useActiveCallStore.getState();
              if (storeState.call) {
                const storeCallControlId =
                  storeState.call.callControlId ||
                  storeState.call.call_control_id ||
                  storeState.call.id;
                const notificationCallControlId =
                  call.callControlId || call.call_control_id || call.id;
                if (!storeCallControlId || storeCallControlId === notificationCallControlId) {
                  setCallerInfo({
                    fromNumber: fromNumber || undefined,
                    fromName: fromName || undefined,
                  });
                }
              }
            }

            // For outbound calls, attach audio when call becomes active
            if (callDirection === "outbound" && activeCall) {
              // Attach audio when call is active, connected, or answered
              if (
                ["active", "connected", "answered"].includes(
                  callState.toLowerCase()
                )
              ) {
                attachAudio(call);

                // Retry multiple times to catch the remote stream
                const retryDelays = [100, 300, 500, 1000, 2000];
                retryDelays.forEach((delay) => {
                  setTimeout(() => {
                    attachAudio(call);
                  }, delay);
                });
              }
            }

            if (isIncomingCall && !activeCall) {
              const callControlId =
                call.callControlId || call.call_control_id || call.id;

              // Lookup call metadata and set active call
              (async () => {
                try {
                  // Check again if we have an active call - might have been set by startCall()
                  const currentState = useActiveCallStore.getState();
                  if (currentState.call) {
                    return;
                  }

                  // Lookup if this is a contact center call or direct call
                  const metadata = await lookupCallMetadata(callControlId);
                  metadata.direction = "inbound";
                  if (fromNumber) metadata.fromNumber = fromNumber;
                  if (fromName) metadata.fromName = fromName;

                  // Try to get caller name from SSE store first
                  const storedInfo = await getStoredCallerInfo(fromNumber);
                  const storedIdentityMatches = Boolean(
                    metadata.interactionId &&
                      storedInfo?.interactionId &&
                      String(metadata.interactionId) ===
                        String(storedInfo.interactionId),
                  );
                  const mayUseStoredIdentity =
                    !metadata.interactionId || storedIdentityMatches;
                  if (!metadata.fromName && storedInfo?.fromName) {
                    metadata.fromName = storedInfo.fromName;
                  }
                  if (
                    mayUseStoredIdentity &&
                    storedInfo?.originalCallControlId
                  ) {
                    metadata.originalCallControlId =
                      storedInfo.originalCallControlId;
                  }
                  if (mayUseStoredIdentity && storedInfo?.callSessionId) {
                    metadata.originalCallSessionId = storedInfo.callSessionId;
                  }
                  if (storedInfo?.interactionId && !metadata.interactionId) {
                    metadata.interactionId = storedInfo.interactionId;
                  }
                  if (mayUseStoredIdentity && storedInfo?.metadata) {
                    metadata.metadata = {
                      ...(metadata.metadata || {}),
                      ...storedInfo.metadata,
                    };
                  }

                  // Populate contact center metadata from SSE if available
                  if (mayUseStoredIdentity && storedInfo?.contactCenter) {
                    metadata.interactionId =
                      storedInfo.contactCenter.interactionId;
                    metadata.queueName = storedInfo.contactCenter.queueName;
                    metadata.queuedAt = storedInfo.contactCenter.queuedAt;
                    metadata.assignedAt = storedInfo.contactCenter.assignedAt;
                    metadata.customerId = storedInfo.contactCenter.customerId;
                    metadata.customerData =
                      storedInfo.contactCenter.customerData;
                    metadata.isContactCenter =
                      !!storedInfo.contactCenter.interactionId;
                  }

                  // Double-check before setting - avoid race condition
                  const stateBeforeSet = useActiveCallStore.getState();
                  if (stateBeforeSet.call) {
                    return;
                  }

                  // Set active call in store
                  setActiveCall(call, metadata);

                  // Also add to calls store for multi-call management
                  useCallsStore.getState().addCall({
                    callControlId,
                    callSessionId: call.callSessionId || call.call_session_id,
                    originalCallControlId: metadata.originalCallControlId,
                    originalCallSessionId: metadata.originalCallSessionId,
                    rtcCallId: metadata.rtcCallId,
                    interactionId: metadata.interactionId,
                    callerName: metadata.fromName,
                    callerNumber: metadata.fromNumber || fromNumber,
                    queueName: metadata.queueName,
                    queueId: metadata.queueId,
                    direction: metadata.direction || "inbound",
                    status: "ringing",
                    fromName: metadata.fromName,
                    fromNumber: metadata.fromNumber || fromNumber,
                    toNumber: metadata.toNumber,
                    queuedAt: metadata.queuedAt,
                    assignedAt: metadata.assignedAt || Date.now(),
                    customerId: metadata.customerId,
                    customerData: metadata.customerData,
                    metadata: metadata.metadata || {},
                  });

                  // Wire up call events
                  wireCall(call);

                  // If no name yet, lookup customer name asynchronously
                  if (!metadata.fromName && fromNumber) {
                    const customerName = await lookupCustomerName(fromNumber);
                    if (customerName) {
                      setCallerName(customerName);
                    }
                  }
                } catch (err) {
                  // Error setting up incoming call
                }
              })();
            } else if (activeCall && callDirection === "outbound") {
              // If we have an active call and get an outbound notification,
              // this is likely a notification for our own outbound call
              // Sync the call state to ensure UI updates correctly
              const callControlId =
                call.callControlId || call.call_control_id || call.id;
              const activeCallControlId =
                activeCall.callControlId ||
                activeCall.call_control_id ||
                activeCall.id;

              // Only sync if this notification is for our active call
              if (callControlId === activeCallControlId) {
                // Sync call state - this ensures UI updates when call connects
                const syncCallState = () => {
                  try {
                    const s = String(call.state || "").toLowerCase();
                    if (s) {
                      updateStatus(s);
                    }

                    // Sync mute/hold status from call object
                    try {
                      const muted =
                        call.muted !== undefined ? call.muted : call.isMuted;
                      if (muted !== undefined) {
                        storeSetMuted(muted);
                      }
                    } catch (_) {}

                    try {
                      const held =
                        call.held !== undefined ? call.held : call.isHeld;
                      if (held !== undefined) {
                        storeSetHeld(held);
                      }
                    } catch (_) {}
                  } catch (_) {}
                };

                syncCallState();

                // Attach audio when call becomes active/connected/answered
                if (
                  ["active", "connected", "answered"].includes(
                    callState.toLowerCase()
                  )
                ) {
                  attachAudio(call);
                }
              }
            }
          }
        }
      } catch (err) {
        // Notification handler error
      }
    };

    try {
      client.on?.("telnyx.notification", onNotification);
    } catch (_) {}

    return () => {
      try {
        client.off?.("telnyx.notification", onNotification);
      } catch (_) {}
    };
  }, [client, activeCall, setActiveCall, setCallerInfo, setCallerName]);

  useEffect(() => {
    // Ensure audio element is configured and unlock audio context
    const el = audioRef.current;
    if (el) {
      try {
        el.muted = Boolean(getHeadsetAudioRouter()?.getSnapshot().outputBlocked);
        el.autoplay = true;
        el.playsInline = true;
        el.volume = 1.0;

        // Unlock audio context by playing silent audio on mount
        // This allows the WebRTC SDK to play ringtones later
        const unlockAudio = async () => {
          try {
            // Create a silent audio buffer and play it to unlock the audio context
            // eslint-disable-next-line
            const AudioContextClass =
              window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;

            const audioContext = new AudioContextClass();
            const buffer = audioContext.createBuffer(1, 1, 22050);
            const source = audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContext.destination);
            source.start(0);
            await audioContext.close();
          } catch (err) {
            // Audio unlock failed, will retry on user interaction
          }
        };

        // Try to unlock immediately
        unlockAudio();

        // Also unlock on first user click anywhere on the document
        const handleFirstClick = () => {
          unlockAudio();
          document.removeEventListener("click", handleFirstClick);
        };
        document.addEventListener("click", handleFirstClick, { once: true });

        return () => {
          document.removeEventListener("click", handleFirstClick);
        };
      } catch (_) {}
    }
  }, []);

  useEffect(() => {
    // Initialize To/From from user profile
    (async () => {
      try {
        const res = await voiceFetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json();
        const mobile = data?.user?.mobile || "";
        const voice = data?.user?.voiceNumber || "";
        const callerName = [data?.user?.firstName, data?.user?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        setOutboundCallerName(callerName);
        const mainFromNumber = data?.user?.mainFromNumber || "";

        // Only set mobile as toNumber if there's no existing toNumber in the store
        if (!toNumber && mobile) {
          setDialToNumber(mobile);
          setToInput(mobile);
        }

        // Use user's voice number, or fallback to main from number if not set
        // Always set mainFromNumber if voice is not available
        const fromNumber = voice || mainFromNumber;
        if (fromNumber && fromNumber.trim() !== "") {
          fromRef.current = fromNumber;
        } else {
          fromRef.current = "";
        }
      } catch (_) {}
    })();
  }, []);

  const canCall = useMemo(() => {
    return !activeCall && isValidDialTo(toNumber);
  }, [activeCall, toNumber]);

  function attachAudio(call) {
    try {
      const el = audioRef.current;
      if (!el || !call) return;
      if (useActiveCallStore.getState().call !== call) return;

      // Ensure audio element is properly configured
      el.muted = Boolean(getHeadsetAudioRouter()?.getSnapshot().outputBlocked);
      el.autoplay = true;
      el.playsInline = true;
      el.volume = 1.0;

      if (typeof call.setAudioElement === "function") {
        call.setAudioElement(el);
        // Explicitly play audio after attaching
        try {
          el.play?.()?.catch((err) => {
            // Audio playback failed
          });
        } catch (_) {}
        return;
      }

      const stream = call.remoteStream || call.remoteMediaStream || call.stream;

      if (stream) {
        if (el.srcObject !== stream) {
          el.srcObject = stream;
        }
        // Explicitly play audio after setting stream
        try {
          el.play?.()?.catch((err) => {
            // Audio playback failed
          });
        } catch (_) {}
      }
    } catch (err) {
      // attachAudio error
    }
  }

  // Re-attach audio whenever the call object changes
  useEffect(() => {
    if (activeCall) {
      attachAudio(activeCall);
    } else {
      try {
        if (audioRef.current) audioRef.current.srcObject = null;
      } catch (_) {}
    }
  }, [activeCall]);

  // Wire call events when activeCall changes (e.g., when set from TransferModal)
  // This ensures that calls set in the store from other components (like TransferModal) are properly wired
  const lastWiredCallRef = useRef(null);
  useEffect(() => {
    if (activeCall && typeof activeCall.on === "function") {
      // Only wire if this is a different call object (by reference)
      if (lastWiredCallRef.current !== activeCall) {
        console.log(
          "[SoftphoneMini] Wiring call events for activeCall from store:",
          {
            callId: activeCall.id,
            state: activeCall.state,
            callControlId: activeCall.callControlId,
          }
        );
        wireCall(activeCall);
        lastWiredCallRef.current = activeCall;
      }
    } else if (!activeCall) {
      lastWiredCallRef.current = null;
    }
  }, [activeCall]);

  function wireCall(call) {
    try {
      attachAudio(call);

      // Update call state and sync mute/hold status
      const syncCallState = () => {
        try {
          if (useActiveCallStore.getState().call !== call) return;
          const s = String(call.state || "").toLowerCase();
          if (s) {
            updateStatus(s);
          }

          // Sync mute status from call object
          try {
            const muted = call.muted !== undefined ? call.muted : call.isMuted;
            if (muted !== undefined) {
              storeSetMuted(muted);
            }
          } catch (_) {}

          // Sync hold status from call object
          try {
            const held = call.held !== undefined ? call.held : call.isHeld;
            if (held !== undefined) {
              storeSetHeld(held);
            }
          } catch (_) {}

          // Sync to calls store
          try {
            const callControlId =
              call.callControlId || call.call_control_id || call.id;
            const callsStore = useCallsStore.getState();
            const callData = callsStore.getCall(callControlId);

            if (callData) {
              const updates = {
                status: s,
                isMuted: call.muted !== undefined ? call.muted : call.isMuted,
                isHeld: call.held !== undefined ? call.held : call.isHeld,
              };

              // Set answerTime when call becomes active/connected/answered
              if (
                (s === "active" || s === "connected" || s === "answered") &&
                !callData.answerTime
              ) {
                updates.answerTime = Date.now();
                updates.connectedTime = Date.now();
                updates.isRinging = false;
              }

              // Update duration if call is active
              if (callData.answerTime && !callData.disconnectedTime) {
                updates.duration = Math.floor(
                  (Date.now() - callData.answerTime) / 1000
                );
              }

              callsStore.updateCall(callControlId, updates);
            }
          } catch (_) {}

          attachAudio(call);
        } catch (_) {}
      };

      // Wire up all call events for immediate status updates
      const registeredEvents = [];

      if (typeof call.on === "function") {
        call.on("ringing", () => {
          updateStatus("ringing");
          syncCallState();
        });
        registeredEvents.push("ringing");
      }

      if (typeof call.on === "function") {
        call.on("active", () => {
          markWebrtcCallConnected(call);
          updateStatus("active");
          syncCallState();
          attachAudio(call);

          // Retry audio attachment - stream may take time to be available
          setTimeout(() => {
            attachAudio(call);
          }, 500);
        });
        registeredEvents.push("active");

        call.on("connected", () => {
          markWebrtcCallConnected(call);
          updateStatus("connected");
          syncCallState();
          attachAudio(call);

          // Retry audio attachment - stream may take time to be available
          setTimeout(() => {
            attachAudio(call);
          }, 500);
        });
        registeredEvents.push("connected");

        call.on("answered", () => {
          markWebrtcCallConnected(call);
          updateStatus("answered");
          syncCallState();
          attachAudio(call);

          // For outbound calls, retry audio attachment multiple times
          // The remote stream may not be immediately available
          const retryDelays = [100, 300, 500, 1000];
          retryDelays.forEach((delay) => {
            setTimeout(() => {
              attachAudio(call);
            }, delay);
          });
        });
        registeredEvents.push("answered");

        call.on("trying", () => {
          updateStatus("trying");
        });
        registeredEvents.push("trying");

        call.on("requesting", () => {
          updateStatus("requesting");
        });
        registeredEvents.push("requesting");

        call.on("early", () => {
          updateStatus("early");
        });
        registeredEvents.push("early");

        call.on("busy", () => handleDialFailure(call, "busy"));
        registeredEvents.push("busy");

        call.on("held", () => {
          storeSetHeld(true);
        });
        registeredEvents.push("held");
      }

      // Register hangup handlers - try both with and without optional chaining
      // Some versions of the SDK might need direct .on() calls
      const onHangup = () => {
        if (useActiveCallStore.getState().call !== call) return;
        updateStatus("ended");
        setTimeout(() => {
          if (useActiveCallStore.getState().call === call) handleCallEnd();
        }, 100);
      };

      const onDestroy = () => {
        if (useActiveCallStore.getState().call !== call) return;
        updateStatus("ended");
        setTimeout(() => {
          if (useActiveCallStore.getState().call === call) handleCallEnd();
        }, 100);
      };

      const onEnded = () => {
        if (useActiveCallStore.getState().call !== call) return;
        updateStatus("ended");
        setTimeout(() => {
          if (useActiveCallStore.getState().call === call) handleCallEnd();
        }, 100);
      };

      const onPurge = () => {
        if (useActiveCallStore.getState().call !== call) return;
        updateStatus("ended");
        setTimeout(() => {
          if (useActiveCallStore.getState().call === call) handleCallEnd();
        }, 100);
      };

      // Try registering with both methods
      if (typeof call.on === "function") {
        call.on("hangup", onHangup);
        call.on("destroy", onDestroy);
        call.on("ended", onEnded);
        call.on("purge", onPurge);
      }

      // Listen to stateChanged for all state transitions
      call.on?.("stateChanged", (newState) => {
        if (useActiveCallStore.getState().call !== call) return;
        if (newState) {
          const lowerState = String(newState).toLowerCase();
          if (isWebrtcDialFailureState(lowerState)) {
            handleDialFailure(call, lowerState);
            return;
          }
          updateStatus(lowerState);

          // Check if call ended via state change
          if (
            [
              "hangup",
              "ended",
              "destroy",
              "purge",
              "idle",
              "terminated",
              "done",
              "failed",
            ].includes(lowerState)
          ) {
            setTimeout(() => {
              if (useActiveCallStore.getState().call === call) handleCallEnd();
            }, 100);
          }

          // Re-attach audio when call becomes active
          if (["active", "connected", "answered"].includes(lowerState)) {
            attachAudio(call);
          }
        }
        syncCallState();
      });

      // Transport failures are recoverable; only SDK/Core termination ends the UI.

      // Initial state sync
      syncCallState();
    } catch (err) {
      // wireCall: Error setting up event listeners
    }
  }

  function handleDialFailure(call, state) {
    const store = useActiveCallStore.getState();
    if (!shouldHandleWebrtcDialFailure({
      call,
      state,
      direction: store.direction,
      currentStatus: store.status,
    })) return;
    if (!claimWebrtcDialFailure(call)) return;
    const intentId = directIntentIdFromCall(call);
    try { call.hangup?.(); } catch (_) {}
    if (intentId) void cancelUnstartedWebrtcIntent(intentId);
    notify({
      title: "Call failed",
      description: describeWebrtcDialFailure(state),
      variant: "error",
    });
    updateStatus("ended");
    setTimeout(() => {
      if (useActiveCallStore.getState().call === call) void handleCallEnd();
    }, 100);
  }

  async function handleCallEnd() {
    const endingCall=useActiveCallStore.getState().call;
    try {
      const storeState = useActiveCallStore.getState();

      // Set status to "ended" before clearing to allow wrapup logic to detect it
      if (storeState.status !== "ended" && storeState.status !== "idle") {
        // Try updateStatus first (requires call object for proper state tracking)
        if (storeState.call) {
          useActiveCallStore.getState().updateStatus("ended");
        } else {
          // If call is null, set status directly
          useActiveCallStore.setState(
            { status: "ended" },
            false,
            "setStatusEnded"
          );
        }
        // Small delay to allow wrapup logic to detect the "ended" status
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Get callControlId and interactionId for calls store and refresh
      const callControlId =
        storeState.callControlId ||
        storeState.call?.callControlId ||
        storeState.call?.call_control_id ||
        storeState.call?.id;
      const interactionId = storeState?.contactCenter?.interactionId;

      // Dispatch disconnect event IMMEDIATELY with all identifiers
      // This allows AgentDesktop to remove the interaction from UI instantly
      if (interactionId || callControlId) {
        window.dispatchEvent(
          new CustomEvent("contact-center:call-disconnected", {
            detail: {
              interactionId,
              callControlId,
              transcriptions: storeState.transcriptions || [],
            },
          })
        );
      }

      // Update calls store before clearing
      if (callControlId) {
        const callsStore = useCallsStore.getState();
        const callData = callsStore.getCall(callControlId);

        if (callData) {
          // Update final status and disconnected time
          callsStore.updateCall(callControlId, {
            status: "ended",
            disconnectedTime: Date.now(),
            isRinging: false,
          });

          // Remove call from calls store immediately to clear agent desktop
          callsStore.removeCall(callControlId);
          // Also remove by interactionId if available
          if (interactionId) {
            callsStore.removeCall(interactionId);
          }
        }
      }

      // A different call may arrive while finalization waits for wrap-up.
      if(useActiveCallStore.getState().call===endingCall)clearActiveCall();

      // Also trigger refresh event as backup
      window.dispatchEvent(
        new CustomEvent("contact-center:refresh-interactions")
      );
    } catch (err) {
      if(useActiveCallStore.getState().call===endingCall)clearActiveCall();
    }
  }

  async function startCall(overrides = {}) {
    const to = (overrides.toNumber || toNumber || "").trim();
    let from = overrides.fromNumber || fromRef.current || "";
    if (!client || !to || activeCall) return;

    let callerName = overrides.callerName || outboundCallerName;
    if (!callerName) {
      try {
        const res = await voiceFetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json();
        callerName = [data?.user?.firstName, data?.user?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (callerName) {
          setOutboundCallerName(callerName);
        }
      } catch (_) {}
    }

    // If fromNumber is empty, try to get mainFromNumber as fallback
    if (!from) {
      try {
        const res = await voiceFetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json();
        const mainFromNumber = data?.user?.mainFromNumber || "";
        if (mainFromNumber) {
          from = mainFromNumber.trim();
          // Update the ref with the fallback number
          fromRef.current = mainFromNumber;
        }
      } catch (_) {
        // If fetch fails, continue with empty from
      }
    }

    let directIntentId = null;
    let callAudio = null;
    try {
      // Ensure mic is available
      try {
        client.enableMicrophone?.();
      } catch (_) {}

      callAudio = await prepareWebrtcAudio();
      const experimentalOptions = getWebrtcExperimentalOptions();
      console.log("[webrtc] Starting outbound call", experimentalOptions);
      const prepared = await voiceFetch("/api/voice/direct-intent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), target: to, outboundIdentity: useDialStore.getState().outboundIdentity }),
      });
      const directIntent = await prepared.json();
      if (!prepared.ok) throw new Error(directIntent.error || "Voice capacity unavailable");
      directIntentId = directIntent.intentId || null;
      from = directIntent.callerNumber || from;
      const call = client.newCall({
        destinationNumber: directIntent.destination || to,
        callerNumber: from || undefined,
        callerName: callerName || undefined,
        audio: true,
        localStream: callAudio,
        video: false,
        customHeaders: [...(overrides.customHeaders || []), ...directIntent.customHeaders],
        ...(experimentalOptions.prefetchIceCandidates && {
          prefetchIceCandidates: true,
        }),
      });

      // Set active call in store (outbound call, no contact center metadata)
      setActiveCall(call, {
        direction: "outbound",
        fromNumber: from,
        fromName: callerName || undefined,
        toNumber: to,
        interactionId: directIntent.workItemId || null,
        ...(overrides.metadata || {}),
      });

      const outboundCallControlId = call.callControlId || call.call_control_id || call.id;
      if (outboundCallControlId) {
        useCallsStore.getState().addCall({
          callControlId: outboundCallControlId,
          callSessionId: call.callSessionId || call.call_session_id,
          direction: "outbound",
          status: call.state || "trying",
          fromName: callerName || undefined,
          fromNumber: from,
          toNumber: to,
          assignedAt: Date.now(),
          metadata: overrides.metadata || {},
        });
      }

      // Immediately update status to ensure UI reflects dialing state
      const initialState = call.state || "trying";
      if (initialState) {
        updateStatus(initialState);
      }

      wireCall(call);

      // Proactively try to attach audio with retries
      // This helps ensure audio works when the other party answers
      const retryDelays = [500, 1000, 2000, 3000];
      retryDelays.forEach((delay) => {
        setTimeout(() => {
          if (activeCall) {
            attachAudio(call);
          }
        }, delay);
      });
    } catch (err) {
      callAudio?.getTracks().forEach(track => track.stop());
      if (directIntentId) void cancelUnstartedWebrtcIntent(directIntentId);
      notify({
        title: "Call failed",
        description: err?.message || "The call could not be started.",
        variant: "error",
      });
      clearActiveCall();
    }
  }

  useEffect(() => {
    const handleSoftphoneStartCall = (event) => {
      const detail = event.detail || {};
      if (!detail.toNumber) return;
      startCall(detail);
      try {
        toggle?.();
      } catch (_) {}
    };
    window.addEventListener("softphone:start-call", handleSoftphoneStartCall);
    return () => window.removeEventListener("softphone:start-call", handleSoftphoneStartCall);
  }, [client, activeCall, toNumber, outboundCallerName]);

  async function toggleMute() {
    try { await callStateActions.setMuted(!useActiveCallStore.getState().ui.isMuted); }
    catch (err) { notify({ title: "Mute failed", description: err.message, variant: "error" }); }
  }

  async function toggleHold() {
    try { await callStateActions.setHeld(!useActiveCallStore.getState().ui.isHeld); }
    catch (err) { notify({ title: "Hold failed", description: err.message, variant: "error" }); }
  }

  // "Answer here" in the Move call dialog: the mini phone owns the call's audio, so it answers.
  const answerRequest = useDeviceHandoffStore((s) => s.answerRequest);
  const answerRequested = useRef(answerRequest);
  useEffect(() => {
    if (answerRequest === answerRequested.current) return;
    answerRequested.current = answerRequest;
    handleAnswerCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerRequest]);

  async function handleAnswerCall() {
    try {
      if (!activeCall) {
        return;
      }

      // Ensure audio is properly attached before answering
      attachAudio(activeCall);

      // Answer the call
      if (typeof activeCall.answer !== "function") throw new Error("This call cannot be answered.");
      await activeCall.answer();
      if (useActiveCallStore.getState().call !== activeCall) return;

      // The WebRTC leg is already the agent leg created by the routing engine.
      // Do not call the interaction /answer endpoint here: that endpoint is for
      // picking up a queued interaction before a WebRTC leg exists and would
      // initiate a second transfer for an already-ringing ACD call.
      updateStatus("answered");

      // Force audio attachment with multiple retries
      // This ensures the remote stream is available after the answer
      const retryDelays = [100, 300, 500, 1000];
      retryDelays.forEach((delay) => {
        setTimeout(() => {
          if (activeCall) {
            attachAudio(activeCall);
          }
        }, delay);
      });
    } catch (err) {
      notify({ title: "Answer failed", description: err.message, variant: "error" });
      return false;
    }
  }

  async function handleRejectCall() {
    try {
      if (!activeCall) {
        return;
      }

      const storeState = useActiveCallStore.getState();
      const interactionId = storeState?.contactCenter?.interactionId;
      const callControlId =
        storeState.callControlId ||
        storeState.call?.callControlId ||
        storeState.call?.call_control_id ||
        storeState.call?.id;

      // Queue inbound reject is a pre-answer agent no-answer signal.
      // Never hang up the original caller leg from the browser: the backend webhook
      // must see the agent leg hangup and requeue the caller.
      if (interactionId || callControlId) {
        window.dispatchEvent(
          new CustomEvent("contact-center:call-disconnected", {
            detail: {
              interactionId,
              callControlId,
              transcriptions: storeState.transcriptions || [],
              rejectedBeforeAnswer: true,
              wasAnswered: false,
            },
          })
        );
      }

      if (typeof activeCall.hangup !== "function") throw new Error("This call cannot be rejected.");
      await activeCall.hangup();
      if (useActiveCallStore.getState().call && useActiveCallStore.getState().call !== activeCall) return;
      clearActiveCall();
      if (callControlId) {
        useCallsStore.getState().removeCall(callControlId);
      }
      if (interactionId) {
        useCallsStore.getState().removeCall(interactionId);
      }
      window.dispatchEvent(
        new CustomEvent("contact-center:refresh-interactions")
      );
    } catch (err) {
      notify({ title: "Reject failed", description: err.message, variant: "error" });
      return false;
    }
  }

  async function hangup() {
    // Check if this is a contact center call and trigger wrapup sheet
    const storeState = useActiveCallStore.getState();
    const interactionId = storeState?.contactCenter?.interactionId;
    const callControlId =
      storeState.callControlId ||
      storeState.call?.callControlId ||
      storeState.call?.call_control_id ||
      storeState.call?.id;

    // ALWAYS dispatch disconnect event with both interactionId and callControlId
    // This ensures AgentDesktop can immediately identify and remove the interaction
    if (interactionId || callControlId) {
      window.dispatchEvent(
        new CustomEvent("contact-center:call-disconnected", {
          detail: {
            interactionId,
            callControlId,
            transcriptions: storeState.transcriptions || [],
          },
        })
      );
    }

    try {
      if (!activeCall) {
        clearActiveCall();
        // Remove from calls store and refresh
        if (callControlId) {
          useCallsStore.getState().removeCall(callControlId);
        }
        if (interactionId) {
          useCallsStore.getState().removeCall(interactionId);
        }
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("contact-center:refresh-interactions")
          );
        }, 100);
        return;
      }

      // Check if call is already ended
      const currentStatus = storeState.status;
      if (
        ["hangup", "ended", "destroy", "idle", "terminated"].includes(
          currentStatus
        )
      ) {
        clearActiveCall();
        // Remove from calls store and refresh
        if (callControlId) {
          useCallsStore.getState().removeCall(callControlId);
        }
        if (interactionId) {
          useCallsStore.getState().removeCall(interactionId);
        }
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("contact-center:refresh-interactions")
          );
        }, 100);
        return;
      }

      // Try to hangup
      try {
        if (typeof activeCall.hangup === "function") {
          await activeCall.hangup();

          // The telnyx.notification handler will receive the call end notification
          // and call handleCallEnd(). Add a fallback timeout just in case.
          setTimeout(() => {
            const currentState = useActiveCallStore.getState();
            if (currentState.call===activeCall) {
              handleCallEnd();
            } else if (!currentState.call) {
              // Call already cleared, but ensure it's removed from calls store
              if (callControlId) {
                useCallsStore.getState().removeCall(callControlId);
              }
              if (interactionId) {
                useCallsStore.getState().removeCall(interactionId);
              }
              setTimeout(() => {
                window.dispatchEvent(
                  new CustomEvent("contact-center:refresh-interactions")
                );
              }, 100);
            }
          }, 2000);
        } else {
          handleCallEnd();
          return;
        }
      } catch (err) {
        notify({ title: "Hangup failed", description: err.message, variant: "error" });
        return false;
      }
    } catch (err) {
      // Clear state on any error
      try {
        clearActiveCall();
        // Remove from calls store and refresh
        if (callControlId) {
          useCallsStore.getState().removeCall(callControlId);
        }
        if (interactionId) {
          useCallsStore.getState().removeCall(interactionId);
        }
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("contact-center:refresh-interactions")
          );
        }, 100);
      } catch (_) {}
    }
  }

  return (
    <MiniPhoneSurface telephonyStatus={telephonyStatus} callStatus={callStatus} activeCall={activeCall} callHeader={callHeader} testInteractionId={testInteractionId} callUI={callUI} isRinging={isRinging} audioRef={audioRef} isIncomingCall={isIncomingCall} incomingCallerDisplay={incomingCallerDisplay} isOutboundCall={isOutboundCall} miniInputDisplay={miniInputDisplay} shouldMarqueeMiniInput={shouldMarqueeMiniInput} setShowNumberModal={setShowNumberModal} handleRejectCall={handleRejectCall} handleAnswerCall={handleAnswerCall} isCallConnected={isCallConnected} hangup={hangup} toggleMute={toggleMute} toggleHold={toggleHold} canCall={canCall} startCall={startCall} toggle={toggle}
      connectionIndicator={<VoiceRecoveryBadge promptForDevice />} headsetIndicator={headsetEnabled ? <HeadsetStatusBadge /> : null}
      onTransfer={() => {setCardTransferInteraction(null);setShowTransfer(true);}} handoffButton={<HandoffMoveButton callInteractionId={useActiveCallStore.getState().contactCenter?.interactionId ?? null} />}
    >
      {/* TransferModal must stay mounted during consult process even when activeCall is null
          (because consult hangs up original call before initiating new WebRTC call) */}
      <TransferModal
        open={showTransfer}
        onOpenChange={open=>{setShowTransfer(open);if(!open)setCardTransferInteraction(null);}}
        interaction={cardTransferInteraction||interaction}
        onConsultCallCreated={(call) => {
          wireCall(call);
          lastWiredCallRef.current = call;
          attachAudio(call);
          for (const delay of [100, 300, 700, 1500]) {
            setTimeout(() => attachAudio(call), delay);
          }
        }}
        onTransfer={() => {
          setShowTransfer(false);
          setCardTransferInteraction(null);
          console.log("[SoftphoneMini] Transfer successful");
        }}
      />
      <NumberSelectionModal
        open={showNumberModal}
        onOpenChange={setShowNumberModal}
        mode="dial"
        onSelect={(number) => {
          setToInput(number);
          setDialToNumber(number);
          setShowNumberModal(false);
        }}
      />
    </MiniPhoneSurface>
  );
}
