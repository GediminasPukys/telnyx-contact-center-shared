"use client";

import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useTelnyx } from "@/components/telephony-provider";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { hasLiveVoiceCall } from "@/lib/telephony/phone-indicator.mjs";
import { usePhoneChoice } from "./use-phone-choice";
import CompactPhonePicker from "./CompactPhonePicker";

export default function PhoneSwitchDialog({ open, onOpenChange, onCloseAutoFocus }) {
  const tUi = useUiText(), choice = usePhoneChoice();
  const [busy, setBusy] = useState(false);
  const { changePhone, client, status } = useTelnyx();
  const call = useActiveCallStore(s => s.call), callStatus = useActiveCallStore(s => s.status);
  const callActive = hasLiveVoiceCall({ call, status: callStatus }, client);
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="z-[1300] flex h-[min(700px,88dvh)] flex-col gap-4 overflow-hidden rounded-2xl sm:max-w-[680px]" overlayClassName="z-[1299]" showCloseButton={!busy} onCloseAutoFocus={onCloseAutoFocus}
      onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader className="shrink-0 pr-7"><DialogTitle className="flex items-center gap-2"><ArrowLeftRight className="size-5 text-emerald-500" />{tUi("Change phone")}</DialogTitle><DialogDescription>{tUi("Choose the phone you want to use for this session.")}</DialogDescription></DialogHeader>
      {status === "connecting" ? <p role="status" className="text-xs text-muted-foreground">{tUi("Wait for the phone connection to finish.")}</p> : null}
      {open ? <CompactPhonePicker busy={busy} setBusy={setBusy} currentChoice={choice} callActive={callActive} disabled={callActive || status === "connecting"}
        onCancel={() => onOpenChange(false)} onChoose={async station => { await changePhone(station); onOpenChange(false); }} /> : null}
    </DialogContent>
  </Dialog>;
}
