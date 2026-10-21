"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { directoryRequest } from "./ExtensionAssignment";
import CompactPhonePicker from "./CompactPhonePicker";
import { adoptStationRegistration, browserVoiceDeviceId, resetVoiceEndpoint, setVoiceLoginChoice } from "@/lib/telephony/endpoint-client";

export default function PhoneSelection() {
  const tUi = useUiText(), router = useRouter();
  const [busy, setBusy] = useState(false);
  async function choose(station) {
    const result = await directoryRequest("/api/telephony/stations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stationId: station?.id, kind: station?.kind || "none", deviceId: browserVoiceDeviceId() }) });
    resetVoiceEndpoint(); setVoiceLoginChoice(result.choice);
    if (result.registration) adoptStationRegistration(result);
    router.replace("/"); router.refresh();
  }
  return <div className="flex max-h-[min(640px,calc(100svh-300px))] min-h-80 flex-col gap-4" data-testid="login-phone-selection">
    <header className="shrink-0 space-y-2"><p className="flex items-center gap-1.5 text-xs font-medium text-emerald-400"><Check className="size-4" />{tUi("Signed in")}</p><h1 className="text-xl font-semibold">{tUi("Choose your phone")}</h1><p className="text-sm text-muted-foreground">{tUi("Choose the phone you want to use for this session.")}</p></header>
    <CompactPhonePicker initial busy={busy} setBusy={setBusy} onChoose={choose} onCancel={async () => { await signOut({ redirect: false }); window.location.replace("/signin"); }} />
  </div>;
}
