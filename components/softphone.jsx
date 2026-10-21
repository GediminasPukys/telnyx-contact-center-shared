"use client";
import NativeSoftphone from "@/components/telephony/NativeSoftphone";
import { usePhoneChoice } from "@/components/telephony/use-phone-choice";
import { FloatingPhoneSurface } from "@/components/telephony/PhoneSurface";
import { useUiText } from "@/components/i18n/use-ui-text";

import { prepareWebrtcAudio } from "@/lib/headsets/client-headset-service";
import { voiceFetch } from "@/lib/telephony/endpoint-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTelnyx } from "@/components/telephony-provider";
import { playDtmfBeep } from "@/lib/dtmf";
import useActiveCallStore, {
  useActiveCall,
  useIsRinging,
  useCallUI,
} from "@/lib/stores/active-call-store";
import useDialStore from "@/lib/stores/dial-store";
import useCallsStore from "@/lib/stores/calls-store";
import { NumberSelectionModal } from "@/components/contact-center/NumberSelectionModal";
import { TransferModal } from "@/components/contact-center/TransferModal";
import { HandoffEntryBar } from "@/components/contact-center/handoff/HandoffEntry";
import { notify } from "@/components/ToastNotify";
import { callStateActions } from "@/lib/headsets/client-call-actions";
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

export function Softphone() {
  const choice = usePhoneChoice();
  return ["deskphone", "sip"].includes(choice?.kind) ? <NativeSoftphone /> : <WebrtcSoftphone />;
}

function WebrtcSoftphone() {
  const tUi = useUiText();
  const { client } = useTelnyx();

  // Zustand stores - call state (shared with mini phone)
  const activeCall = useActiveCall();
  const isRinging = useIsRinging();
  const callUI = useCallUI();
  const callStatus = useActiveCallStore((state) => state.status);
  const activeCallDirection = useActiveCallStore((state) => state.direction);
  const activeCallFromNumber = useActiveCallStore((state) => state.fromNumber);
  const activeCallFromName = useActiveCallStore((state) => state.fromName);
  const contactCenterInteractionId = useActiveCallStore(
    (state) => state.contactCenter?.interactionId || null,
  );

  // Zustand stores - dial state
  const {
    toNumber,
    fromNumber,
    setToNumber: setDialToNumber,
    setFromNumber: setDialFromNumber,
  } = useDialStore();

  // Active call store actions
  const {
    setActiveCall,
    updateStatus,
    setMuted: storeSetMuted,
    setHeld: storeSetHeld,
    setCallerInfo,
    clearActiveCall,
    isContactCenterCall,
    getCallDuration,
  } = useActiveCallStore();

  // Check if call is connected/answered (CTI buttons should only show when connected)
  // Check both store status and call object state to handle all cases (inbound/outbound, direct/contact center)
  // Memoized to prevent rapid re-computation when status changes rapidly during answer
  const isCallConnected = useMemo(() => {
    if (!activeCall) return false;

    const callObjectState = activeCall?.state
      ? String(activeCall.state).toLowerCase()
      : null;
    const storeStatus = callStatus ? String(callStatus).toLowerCase() : null;
    const connectedStates = ["active", "connected", "answered", "held"];

    return (
      (storeStatus && connectedStates.includes(storeStatus)) ||
      (callObjectState && connectedStates.includes(callObjectState))
    );
  }, [activeCall, callStatus]);

  // Local UI state
  const [dtmfBuffer, setDtmfBuffer] = useState("");
  const [showDtmf, setShowDtmf] = useState(false);
  const [showNumberModal, setShowNumberModal] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [interaction, setInteraction] = useState(null);
  const [sipUri, setSipUri] = useState("");
  const [outboundCallerName, setOutboundCallerName] = useState("");
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
  const incomingCallerNumber = remoteCallerNumber || interactionFromNumber || activeCallFromNumber || "";
  const incomingCallerName = remoteCallerName || activeCallFromName || interaction?.from_name || interaction?.fromName || "";
  const incomingCallerDisplay = formatCallerIdentity(incomingCallerName, incomingCallerNumber);
  const isIncomingCall =
    activeCall &&
    (activeCallDirection === "inbound" || activeCallDirection === "incoming");
  const isOutboundCall = activeCall && activeCallDirection === "outbound";
  const displayedFromNumber = isIncomingCall
    ? incomingCallerDisplay || fromNumber
    : fromNumber;

  const lastFetchedInteractionIdRef = useRef(null);

  const copySipUri = async () => {
    if (!sipUri) {
      notify({ title: "WebRTC SIP URI is not configured for this profile", variant: "error" });
      return;
    }

    try {
      await navigator.clipboard.writeText(sipUri);
      notify({ title: "WebRTC URI copied", description: sipUri, variant: "success" });
    } catch (_) {
      notify({ title: "Failed to copy WebRTC URI", variant: "error" });
    }
  };

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await voiceFetch("/api/user/profile", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        const user = data?.data || data?.user || data || {};
        const telephonyUserName = user.telephony_user_name || "";
        const callerName = [
          user.first_name || user.firstName,
          user.last_name || user.lastName,
        ]
          .filter(Boolean)
          .join(" ")
          .trim();

        if (!cancelled) {
          setOutboundCallerName(callerName);
          setSipUri(
            telephonyUserName ? `sip:${telephonyUserName}@sip.telnyx.com` : ""
          );
        }
      } catch (_) {
        if (!cancelled) {
          setOutboundCallerName("");
          setSipUri("");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
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

  // Pass the call explicitly when it may be newer than this render's activeCall
  // (e.g. a consult leg created by TransferModal).
  const hydrateRemoteAudio = useCallback((targetCall) => {
    window.dispatchEvent(new CustomEvent("softphone:attach-audio", { detail: { call: targetCall || useActiveCallStore.getState().call } }));
  }, []);

  useEffect(() => { if (activeCall) hydrateRemoteAudio(activeCall); }, [activeCall, hydrateRemoteAudio]);

  // Wire call events when activeCall changes (e.g., when set from TransferModal)
  // This ensures that calls set in the store from other components (like TransferModal) are properly wired
  const lastWiredCallRef = useRef(null);
  useEffect(() => {
    if (activeCall && typeof activeCall.on === "function") {
      // Only wire if this is a different call object (by reference)
      if (lastWiredCallRef.current !== activeCall) {
        // Wire the call to ensure all event handlers are set up
        // This is safe to call multiple times - duplicate listeners won't cause issues
        console.log(
          "[Softphone] Wiring call events for activeCall from store:",
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
  }, [activeCall]); // Wire when activeCall changes

  // Fetch interaction when call is active (same as mini phone)
  useEffect(() => {
    if (activeCall) {
      const storeState = useActiveCallStore.getState();
      let interactionId =
        contactCenterInteractionId || storeState.contactCenter?.interactionId;

      if (!interactionId) {
        const callControlId =
          activeCall.callControlId ||
          activeCall.call_control_id ||
          activeCall.id;

        (async () => {
          try {
            const { getIncomingCallData } = await import(
              "@/lib/incoming-call-store"
            );
            let callData = getIncomingCallData(callControlId);

            if (!callData?.interactionId) {
              const latestData = getIncomingCallData("__latest_incoming__");
              if (
                latestData?.timestamp &&
                Date.now() - latestData.timestamp < 10000
              ) {
                callData = latestData;
              }
            }

            if (!callData?.interactionId) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              callData = getIncomingCallData(callControlId);
              if (!callData?.interactionId) {
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
            console.warn(
              "[Softphone] Error checking incoming call store:",
              err
            );
          }

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
              console.error(
                "[Softphone] Failed to fetch interaction by call_control_id:",
                err
              );
              lastFetchedInteractionIdRef.current = null;
              setInteraction(null);
            }
          }
        })();
        return;
      }

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
            console.error("[Softphone] Failed to fetch interaction:", err);
            lastFetchedInteractionIdRef.current = null;
            setInteraction(null);
          }
        };
        fetchInteraction();
      }
    } else {
      lastFetchedInteractionIdRef.current = null;
      setInteraction(null);
    }
  }, [activeCall, callStatus, contactCenterInteractionId]);

  // Listen for incoming calls (notifications from WebRTC SDK)
  // NOTE: softphone-mini.jsx is the PRIMARY handler for incoming calls
  // This component should NOT set active call to avoid race conditions
  useEffect(() => {
    if (!client) return;

    const onNotification = (notification) => {
      try {
        if (notification.type === "callUpdate" || notification?.call) {
          const call = notification?.call || null;
          const callState = call?.state || notification?.call?.state || "";

          // Detect call end states
          if (!call) {
            // The SDK may emit an identity-free update when an older leg is
            // purged. Only an identified terminal call may clear the active
            // softphone state.
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
            if (activeCall && useActiveCallStore.getState().call === call) {
              handleCallEnd();
            }
            return;
          }

          const callDirection =
            call.direction || notification?.call?.direction || "";
          const isIncoming =
            callDirection === "outbound"
              ? false
              : callDirection === "inbound" ||
                callDirection === "incoming" ||
                (!activeCall && callState.toLowerCase() === "ringing");
          const remoteCallerNumber =
            call.options?.remoteCallerNumber || call.remoteCallerNumber || "";
          const remoteCallerName =
            call.options?.remoteCallerName || call.remoteCallerName || "";

          if (isIncoming && (remoteCallerNumber || remoteCallerName)) {
            const storeState = useActiveCallStore.getState();
            const storeCallControlId =
              storeState.call?.callControlId ||
              storeState.call?.call_control_id ||
              storeState.call?.id;
            const notificationCallControlId =
              call.callControlId || call.call_control_id || call.id;
            if (!storeCallControlId || storeCallControlId === notificationCallControlId) {
              setCallerInfo({
                fromNumber: remoteCallerNumber || undefined,
                fromName: remoteCallerName || undefined,
              });
            }
          }

          // For active calls, update status and attach audio
          if (activeCall && call && callState) {
            const activeCallControlId =
              activeCall.callControlId || activeCall.call_control_id || activeCall.id;
            const notificationCallControlId =
              call.callControlId || call.call_control_id || call.id;
            if (activeCallControlId === notificationCallControlId) {
              const lowerState = callState.toLowerCase();
              updateStatus(lowerState);
              hydrateRemoteAudio();
            }
          }
        }
      } catch (err) {
        console.error("[Softphone] Notification handler error:", err);
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
  }, [client, activeCall, hydrateRemoteAudio, setCallerInfo]);

  async function handleCallEnd() {
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

      // Get callControlId and interactionId for calls store
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

      // Update and remove call from calls store
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

      clearActiveCall();

      // Also trigger refresh event as backup
      window.dispatchEvent(
        new CustomEvent("contact-center:refresh-interactions")
      );
    } catch (err) {
      console.error("[Softphone] Error in handleCallEnd:", err);
      clearActiveCall();
    }
  }

  async function startCall() {
    const to = (toNumber || "").trim();
    let from = (fromNumber || "").trim();
    if (!client || !to || activeCall) return;

    let callerName = outboundCallerName;
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
          // Update the dial store with the fallback number
          setDialFromNumber(mainFromNumber);
        }
      } catch (_) {
        // If fetch fails, continue with empty from
      }
    }

    let directIntentId = null;
    let callAudio = null;
    try {
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
        customHeaders: directIntent.customHeaders,
        destinationNumber: directIntent.destination || to,
        callerNumber: from || undefined,
        callerName: callerName || undefined,
        audio: true,
        localStream: callAudio,
        video: false,
        ...(experimentalOptions.prefetchIceCandidates && {
          prefetchIceCandidates: true,
        }),
      });

      // Set active call in store (outbound call)
      setActiveCall(call, {
        direction: "outbound",
        fromNumber: from,
        toNumber: to,
        interactionId: directIntent.workItemId || null,
      });

      // Immediately update status to ensure UI reflects dialing state
      const initialState = call.state || "trying";
      if (initialState) {
        updateStatus(initialState);
      }

      wireCall(call);

      // Proactively try to attach audio with retries
      const retryDelays = [500, 1000, 2000, 3000];
      retryDelays.forEach((delay) => {
        setTimeout(() => {
          if (activeCall) {
            hydrateRemoteAudio();
          }
        }, delay);
      });
    } catch (err) {
      console.error("[Softphone] Failed to start call:", err);
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

  function wireCall(call) {
    try {
      hydrateRemoteAudio();

      const syncCallState = () => {
        try {
          const s = String(call.state || "").toLowerCase();
          if (s) {
            updateStatus(s);
          }

          try {
            const muted = call.muted !== undefined ? call.muted : call.isMuted;
            if (muted !== undefined) {
              storeSetMuted(muted);
            }
          } catch (_) {}

          try {
            const held = call.held !== undefined ? call.held : call.isHeld;
            if (held !== undefined) {
              storeSetHeld(held);
            }
          } catch (_) {}

          hydrateRemoteAudio();
        } catch (_) {}
      };

      if (typeof call.on === "function") {
        call.on("busy", () => handleDialFailure(call, "busy"));
        call.on("ringing", () => {
          updateStatus("ringing");
          syncCallState();
        });

        call.on("active", () => {
          markWebrtcCallConnected(call);
          updateStatus("active");
          syncCallState();
          hydrateRemoteAudio();
        });

        call.on("connected", () => {
          markWebrtcCallConnected(call);
          updateStatus("connected");
          syncCallState();
          hydrateRemoteAudio();
        });

        call.on("answered", () => {
          markWebrtcCallConnected(call);
          updateStatus("answered");
          syncCallState();
          hydrateRemoteAudio();
        });

        call.on("held", () => {
          storeSetHeld(true);
        });

        call.on("hangup", () => {
          updateStatus("ended");
          setTimeout(() => handleCallEnd(), 100);
        });

        call.on("destroy", () => {
          updateStatus("ended");
          setTimeout(() => handleCallEnd(), 100);
        });

        call.on("ended", () => {
          updateStatus("ended");
          setTimeout(() => handleCallEnd(), 100);
        });

        call.on("purge", () => {
          updateStatus("ended");
          setTimeout(() => handleCallEnd(), 100);
        });

        call.on("stateChanged", (newState) => {
          if (newState) {
            const lowerState = String(newState).toLowerCase();
            if (isWebrtcDialFailureState(lowerState)) {
              handleDialFailure(call, lowerState);
              return;
            }
            updateStatus(lowerState);

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
              setTimeout(() => handleCallEnd(), 100);
            }

            if (["active", "connected", "answered"].includes(lowerState)) {
              hydrateRemoteAudio();
            }
          }
          syncCallState();
        });
      }

      syncCallState();
    } catch (err) {
      console.error("[Softphone] wireCall error:", err);
    }
  }

  async function toggleMute() {
    try { await callStateActions.setMuted(!useActiveCallStore.getState().ui.isMuted); }
    catch (error) { notify({ title: "Mute failed", description: error.message, variant: "error" }); }
  }

  async function toggleHold() {
    try { await callStateActions.setHeld(!useActiveCallStore.getState().ui.isHeld); }
    catch (error) { notify({ title: "Hold failed", description: error.message, variant: "error" }); }
  }

  function handleAnswerCall() {
    try {
      if (!activeCall) {
        console.error("[Softphone] No call to answer");
        return;
      }

      hydrateRemoteAudio();
      activeCall.answer?.();
      // This answers the existing routed WebRTC leg. Calling the interaction
      // /answer endpoint as well would start a second transfer and make ACD
      // treat the original leg as an agent no-answer.
      updateStatus("answered");

      const retryDelays = [100, 300, 500, 1000];
      retryDelays.forEach((delay) => {
        setTimeout(() => {
          if (activeCall) {
            hydrateRemoteAudio();
          }
        }, delay);
      });
    } catch (err) {
      console.error("[Softphone] Error answering call:", err);
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

      activeCall.hangup?.();
    } catch (err) {
      // Error rejecting call
    }
  }

  function hangup() {
    try {
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
        console.log(
          "[Softphone] Dispatched disconnect event for interaction:",
          interactionId || callControlId
        );
      }

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

      const status = storeState.status;
      if (
        ["hangup", "ended", "destroy", "idle", "terminated"].includes(status)
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

      if (typeof activeCall.hangup === "function") {
        activeCall.hangup();

        setTimeout(() => {
          const currentState = useActiveCallStore.getState();
          if (currentState.call) {
            handleCallEnd();
          } else {
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
      }
    } catch (err) {
      console.error("[Softphone] Hangup error:", err);
      try {
        clearActiveCall();
        const storeState = useActiveCallStore.getState();
        const callControlId =
          storeState.callControlId ||
          storeState.call?.callControlId ||
          storeState.call?.call_control_id ||
          storeState.call?.id;
        const interactionId = storeState?.contactCenter?.interactionId;
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

  // Initialize default To/From from user profile
  useEffect(() => {
    (async () => {
      try {
        const res = await voiceFetch("/api/auth/me", { cache: "no-store" });
        const data = await res.json();
        const mobile = data?.user?.mobile || "";
        const voice = data?.user?.voiceNumber || "";
        const mainFromNumber = data?.user?.mainFromNumber || "";

        if (!toNumber && mobile) {
          setDialToNumber(mobile);
        }

        // Use user's voice number, or fallback to main from number if not set
        // Always set mainFromNumber if voice is not available
        const fromNumber = voice || mainFromNumber;
        if (fromNumber && fromNumber.trim() !== "") {
          setDialFromNumber(fromNumber);
        }
      } catch (_) {}
    })();
  }, []);

  const canCall = useMemo(() => {
    return !activeCall && isValidDialTo(toNumber);
  }, [activeCall, toNumber]);

  // Active call helper
  const isCallActive = useMemo(() => {
    const s = String(callStatus || "").toLowerCase();
    return ["connected", "active", "answered"].includes(s);
  }, [callStatus]);

  // DTMF handler
  const audioCtxRef = useRef(null);

  const handleKeypadDigit = useCallback(
    (digit) => {
      if (!isCallActive) return;
      playDtmfBeep(digit, audioCtxRef);
      setDtmfBuffer((prev) => (prev + String(digit)).slice(-32));
      const call = activeCall;
      try {
        if (typeof call?.dtmf === "function") {
          call.dtmf(String(digit));
          return;
        }
      } catch (_) {}
      try {
        if (typeof call?.sendDTMF === "function") {
          call.sendDTMF(String(digit));
          return;
        }
      } catch (_) {}
    },
    [isCallActive, activeCall]
  );

  const keypadDigits = useMemo(
    () => [
      ["1", "2", "3"],
      ["4", "5", "6"],
      ["7", "8", "9"],
      ["*", "0", "#"],
    ],
    []
  );

  return (
    <FloatingPhoneSurface toNumber={toNumber} displayedFromNumber={displayedFromNumber} isIncomingCall={isIncomingCall} isOutboundCall={isOutboundCall} isRinging={isRinging} activeCall={activeCall} isCallConnected={isCallConnected} callUI={callUI} canCall={canCall} startCall={startCall} handleAnswerCall={handleAnswerCall} handleRejectCall={handleRejectCall} hangup={hangup} toggleMute={toggleMute} toggleHold={toggleHold} setShowNumberModal={setShowNumberModal} showDtmf={showDtmf} setShowDtmf={setShowDtmf} dtmfBuffer={dtmfBuffer} keypadDigits={keypadDigits} handleKeypadDigit={handleKeypadDigit} isCallActive={isCallActive}
      onTransfer={() => setShowTransfer(true)} handoffBar={<HandoffEntryBar callInteractionId={interaction?.id ?? null} />}
    >
      {/* Number Selection Modal */}
      <NumberSelectionModal
        open={showNumberModal}
        onOpenChange={setShowNumberModal}
        mode="dial"
        onSelect={(number) => {
          setDialToNumber(number);
          setShowNumberModal(false);
        }}
      />

      {/* Transfer Modal - must stay mounted during consult process even when activeCall is null
          (because consult hangs up original call before initiating new WebRTC call) */}
      <TransferModal
        open={showTransfer}
        onOpenChange={setShowTransfer}
        interaction={interaction}
        onConsultCallCreated={(call) => {
          wireCall(call);
          hydrateRemoteAudio(call);
          for (const delay of [100, 300, 700, 1500]) {
            setTimeout(() => hydrateRemoteAudio(call), delay);
          }
        }}
        onTransfer={() => {
          setShowTransfer(false);
          console.log("[Softphone] Transfer successful");
        }}
      />
    </FloatingPhoneSurface>
  );
}

export default Softphone;
