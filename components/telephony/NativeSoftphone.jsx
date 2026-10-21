"use client";

import { useState } from "react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { usePhoneUi } from "@/components/phone-ui-provider";
import { MiniPhoneSurface, FloatingPhoneSurface } from "./PhoneSurface";
import { useNativePhone } from "./NativePhoneSession";
import StationPhoneMenu from "./StationPhoneMenu";
import { NumberSelectionModal } from "@/components/contact-center/NumberSelectionModal";
import useDialStore from "@/lib/stores/dial-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { nativeActionAllowed } from "@/lib/telephony/native-phone-state.mjs";
import { voiceFetch } from "@/lib/telephony/endpoint-client";
import { TransferModal } from "@/components/contact-center/TransferModal";
import { notify } from "@/components/ToastNotify";

export default function NativeSoftphone({ mini = false }) {
  const tUi = useUiText(), phone = useNativePhone(), { toggle } = usePhoneUi();
  const { toNumber, setToNumber } = useDialStore();
  const activeCall = useActiveCallStore(s => s.call);
  const [showNumberModal,setShowNumberModal] = useState(false);
  const [showTransfer,setShowTransfer] = useState(false), [dialing,setDialing] = useState(false);
  const [showDtmf,setShowDtmf] = useState(false), [dtmfBuffer,setDtmfBuffer] = useState("");
  const { view, act, choice } = phone;
  const interaction = phone.observation?.interaction;
  async function startCall() {
    if (dialing || activeCall || !toNumber.trim()) return;
    setDialing(true);
    try {
      const response = await voiceFetch("/api/voice/direct-intent",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({requestId:crypto.randomUUID(),target:toNumber.trim(),outboundIdentity:useDialStore.getState().outboundIdentity})});
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      await phone.refresh();
      notify({title:"Calling",description:data.handsetOriginated?"Your phone is dialing the selected destination.":"Answer your selected phone to connect the call."});
    } catch(e) {notify({title:"Could not start call",description:e.message,variant:"error"});}
    finally {setDialing(false);}
  }
  const disabledActions = Object.entries({answer:"answer",reject:"hangup",disconnect:"hangup",hangup:"hangup",hold:view.isHeld?"resume":"hold",mute:view.isMuted?"unmute":"mute",dtmf:"send_dtmf",transfer:"transfer"})
    .filter(([,action]) => phone.loading || phone.error || (action === "transfer" ? !interaction?.call_control_id || !view.isConnected : !nativeActionAllowed(view,action))).map(([name]) => name);
  const dialUnavailableReason = "Select a number to call. Dialing starts directly on your phone.";
  const outbound = Boolean(interaction?.attributes?.native_station_id);
  const destination = interaction?.attributes?.dial_target;
  const remoteDisplay = outbound ? [destination?.label,destination?.extension].filter(Boolean).join(" · ") || toNumber : "";
  const incomingCallerDisplay = outbound ? remoteDisplay : [...new Set([view.remoteName,view.remoteNumber].filter(Boolean))].join(" · ");
  const common = { activeCall, callUI:{isMuted:view.isMuted === true,isHeld:view.isHeld},isRinging:view.isRinging,isIncomingCall:(view.isRinging || !outbound && view.direction === "inbound") && view.callCount > 0,isOutboundCall:(outbound || view.direction === "outbound") && view.callCount > 0,isCallConnected:view.isConnected,
    testInteractionId:interaction?.id,
    canCall:phone.stateKnown && view.status === "idle" && !phone.error && !phone.loading && !view.callCount && !interaction && Boolean(toNumber.trim()) && !dialing,startCall,dialUnavailableReason,disabledActions,busy:phone.busy || dialing,
    onTransfer:() => setShowTransfer(true),
    handleAnswerCall:() => act("answer"),handleRejectCall:() => act("hangup"),hangup:() => act("hangup"),toggleMute:() => act(view.isMuted?"unmute":"mute"),toggleHold:() => act(view.isHeld?"resume":"hold"),setShowNumberModal,
  };
  const modal = <><NumberSelectionModal open={showNumberModal} onOpenChange={setShowNumberModal} mode="dial" onSelect={number => {setToNumber(number);setShowNumberModal(false);}} />
    <TransferModal open={showTransfer} onOpenChange={setShowTransfer} interaction={interaction} nativePhone onNativeAction={act} onTransfer={() => {setShowTransfer(false);phone.refresh();}} /></>;
  if (mini) return <MiniPhoneSurface {...common} transport="station" telephonyStatus={phone.observation && !phone.error ? "connected" : "disconnected"} callStatus={view.status}
    incomingCallerDisplay={incomingCallerDisplay} miniInputDisplay={view.callCount ? incomingCallerDisplay || toNumber : toNumber} shouldMarqueeMiniInput={false} toggle={toggle} connectionIndicator={<StationPhoneMenu />}>
    {modal}
  </MiniPhoneSurface>;
  const notice = phone.error || (phone.loading ? "Checking phone…" : !choice?.native_control ? "Answer and control calls using your SIP client. Routing and agent availability are managed here." : !phone.stateKnown ? "Call status is unavailable for this phone. Use the handset controls." : view.status === "unknown" ? "Select and control the call on your phone." : null);
  return <FloatingPhoneSurface {...common} toNumber={outbound ? remoteDisplay : view.direction === "outbound" && view.callCount ? view.remoteNumber : toNumber} displayedFromNumber={view.direction === "inbound" && view.callCount ? incomingCallerDisplay : view.localNumber}
    notice={notice ? tUi(notice) : null} showDtmf={showDtmf} setShowDtmf={setShowDtmf} dtmfBuffer={dtmfBuffer} keypadDigits={[["1","2","3"],["4","5","6"],["7","8","9"],["*","0","#"]]} isCallActive={view.isConnected && !view.isHeld}
    handleKeypadDigit={async digit => {if(await act("send_dtmf",{digits:digit}))setDtmfBuffer(value => value + digit);}}>{modal}</FloatingPhoneSurface>;
}
