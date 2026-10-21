"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, Settings } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useUiText } from "@/components/i18n/use-ui-text";
import { usePhoneChoice } from "./use-phone-choice";
import PhoneSwitchDialog from "./PhoneSwitchDialog";
import StationArtwork from "./StationArtwork";
import PhoneDeviceIcon from "./PhoneDeviceIcon";
import { useNativePhone } from "./NativePhoneSession";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

export default function StationPhoneMenu() {
  const tUi = useUiText(), choice = usePhoneChoice();
  const [open, setOpen] = useState(false), [switchOpen, setSwitchOpen] = useState(false);
  const trigger = useRef(null);
  const phone = useNativePhone();
  return <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><button ref={trigger} type="button" data-testid="station-phone-badge" aria-label={tUi("Phone connection and call devices")} title={choice?.name || tUi("Choose your phone")}
        className="flex size-8 items-center justify-center rounded-full border border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-sky-300"><PhoneDeviceIcon kind={choice?.kind} className="size-4" /></button></PopoverTrigger>
      <PopoverContent align="end" sideOffset={10} className="z-[1100] w-80 rounded-2xl p-4" aria-label={tUi("Phone connection and call devices")} onCloseAutoFocus={event => { if (switchOpen) event.preventDefault(); }}>
        <div className="mb-4 flex items-center gap-2 border-b pb-3"><StationArtwork station={choice || {}} className="size-10 shrink-0 [&_svg]:size-5" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{choice?.name || tUi("Voice disabled for this session")}</p><p className="mt-1 text-xs text-muted-foreground">{tUi("Current phone")}</p></div>
          <button type="button" data-testid="change-phone" aria-label={tUi("Change phone")} title={tUi("Change phone")} onClick={() => { setOpen(false); setSwitchOpen(true); }} className="rounded-full p-1.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeftRight className="size-5" /></button>
          <Link href="/profile?tab=devices" aria-label={tUi("Manage call devices")} title={tUi("Manage call devices")} onClick={() => setOpen(false)} className="rounded-full p-1.5 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Settings className="size-5" /></Link>
        </div>
        {choice?.kind === "none" ? <p className="text-xs text-muted-foreground">{tUi("Choose a phone to enable voice for this session.")}</p> : <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{choice?.model || (choice?.kind === "sip" ? "SIP" : tUi("Desk phone"))}</p>
          {phone?.loading ? <Skeleton className="h-5 w-32" /> : <p role="status" className="text-sm">{tUi(phone?.error || (!phone?.stateKnown ? "Use the handset controls" : phone?.view.status === "idle" ? "Phone idle" : phone?.view.status === "unknown" ? "Call status unavailable" : "Call in progress"))}</p>}
          <p className="text-xs text-muted-foreground">{tUi("Audio is handled by your selected phone.")}</p>
          {choice?.native_control ? <Button variant="outline" size="sm" onClick={phone?.refresh} disabled={phone?.busy}>{tUi("Refresh")}</Button> : null}
        </div>}
      </PopoverContent>
    </Popover>
    <PhoneSwitchDialog open={switchOpen} onOpenChange={setSwitchOpen} onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} />
  </>;
}
