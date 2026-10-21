"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Check, Lock, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useUiText } from "@/components/i18n/use-ui-text";
import { cn } from "@/lib/utils";
import { directoryRequest } from "./ExtensionAssignment";
import StationArtwork from "./StationArtwork";
import { browserVoiceDeviceId } from "@/lib/telephony/endpoint-client";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DesktopPhoneSetup from "./DesktopPhoneSetup";

export default function CompactPhonePicker({ onChoose, onCancel, currentChoice, busy, setBusy, disabled = false, callActive = false, initial = false }) {
  const tUi = useUiText();
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [search, setSearch] = useState(""), [selectedId, setSelectedId] = useState(currentChoice?.station_id || null);
  const [desktop,setDesktop]=useState(false),[nearby,setNearby]=useState(null),[scope,setScope]=useState("nearby"),[setup,setSetup]=useState(false);
  useEffect(()=>{
    const native=window.contactCenterDesktop;if(!native)return;
    let active=true;
    native.nearby().then(async r=>{if(active)setDesktop(true);return r.scannedAt?r:await native.discover();}).then(r=>{if(active)setNearby(r);}).catch(()=>{if(active){setDesktop(true);setNearby({phones:[],failed:true});}});
    return()=>{active=false;};
  },[]);
  const load = useCallback(async signal => {
    try { setData(await directoryRequest("/api/telephony/stations", { signal })); setError(""); }
    catch (e) { if (e.name !== "AbortError") setError(e.message); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const first = setTimeout(() => load(controller.signal), 0);
    const timer = setInterval(() => load(controller.signal), 10000);
    return () => { clearTimeout(first); clearInterval(timer); controller.abort(); };
  }, [load]);
  const stations = data?.stations.filter(s => (!desktop || s.kind==="webrtc" || (scope==="nearby"?nearby?.phones.some(p=>p.mac===s.mac):scope==="mine"?!s.shared:s.shared)) && [s.name, s.model, s.extension, s.mac, s.kind].some(value => String(value || "").toLowerCase().includes(search.toLowerCase()))) || [];
  const selected = data?.stations.find(s => s.id === selectedId);
  const choice = currentChoice || data?.choice;
  const blocked = busy || disabled;
  const [notice, setNotice] = useState("");
  async function choose(station) {
    if (blocked || station?.busy) return;
    if (!initial && station?.id === choice?.station_id) { onCancel(); return; }
    setBusy(true); setError("");
    try { await onChoose(station); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function identify() {
    setBusy(true); setError(""); setNotice("");
    try {
      await directoryRequest("/api/telephony/stations/identify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stationId: selected.id, deviceId: browserVoiceDeviceId() }) });
      setNotice(tUi("The identification ring has finished. Confirm that this is your phone."));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if(setup)return <DesktopPhoneSetup onBusyChange={setBusy} onClose={()=>{setSetup(false);window.contactCenterDesktop.nearby().then(setNearby);load();}} onComplete={()=>load()}/>;
  return <>

    {desktop?<><div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{tUi("Phones available to your account")}</p><Button size="sm" variant="outline" disabled={busy||callActive} onClick={()=>setSetup(true)}>{tUi("Find / configure phones")}</Button></div><Tabs value={scope} onValueChange={value=>{setScope(value);setSelectedId(null);}}><TabsList className="gap-4"><TabsTrigger value="nearby">{tUi("Nearby")}</TabsTrigger><TabsTrigger value="mine">{tUi("My phones")}</TabsTrigger><TabsTrigger value="organization">{tUi("Organization stations")}</TabsTrigger></TabsList></Tabs></>:null}

    <div className="relative"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input autoFocus className="pl-9" aria-label={tUi("Find a phone by name, model or extension")} placeholder={tUi("Find a phone by name, model or extension")} value={search} onChange={e => setSearch(e.target.value)} /></div>
    {callActive ? <p role="status" className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">{tUi("Finish the current call before changing phones.")}</p> : null}
    {error ? <div role="alert" className="flex items-center justify-between gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"><span>{tUi(error)}</span>{!data ? <Button variant="outline" size="sm" onClick={() => load()}>{tUi("Retry")}</Button> : null}</div> : null}
    {notice ? <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
    <div className="min-h-24 flex-1 overflow-y-auto pr-1" data-testid="phone-switch-list">
      {desktop&&scope==="nearby"&&!nearby?<div role="status" aria-label={tUi("Finding local phones")} className="mb-2 grid gap-2 sm:grid-cols-2"><Skeleton className="h-20 rounded-xl"/><Skeleton className="h-20 rounded-xl"/></div>:null}
      {desktop&&nearby?.failed?<p role="alert" className="mb-2 text-xs text-destructive">{tUi("Local discovery failed. Open Find / configure phones to retry.")}</p>:null}
      {!data && !error ? <div role="status" aria-label={tUi("Loading stations")} className="grid gap-2 sm:grid-cols-2">{[1, 2, 3, 4].map(n => <Skeleton key={n} className="h-28 rounded-xl" />)}</div> : data ? stations.length ? <div className="grid gap-2 sm:grid-cols-2">{stations.map(station => {
        const current = station.id === choice?.station_id, selected = station.id === selectedId;
        return <button key={station.id} type="button" aria-pressed={selected} disabled={blocked || station.busy} onClick={() => setSelectedId(station.id)} data-testid="phone-switch-option" data-station-id={station.id}
          className={cn("flex min-w-0 flex-col gap-2 rounded-xl border bg-muted/20 p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed", selected ? "border-emerald-500/60 bg-emerald-500/10" : "enabled:hover:border-emerald-500/40 enabled:hover:bg-muted/40", station.busy && "opacity-60")}>
          <div className="flex w-full items-center gap-2.5"><StationArtwork station={station} className="h-12 w-12 shrink-0 [&_img]:p-1 [&_svg]:size-7" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{station.name}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{station.model || (station.kind === "webrtc" ? "WebRTC" : "SIP")}{station.extension ? ` · #${station.extension}` : ""}</p></div>{selected ? <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> : null}</div>
          <div className="flex min-h-5 items-center gap-1.5 text-xs">{station.busy ? <><Lock className="size-3 shrink-0 text-amber-500" /><span className="truncate text-amber-700 dark:text-amber-300">{station.occupant_name || tUi("Occupied")}</span></> : current ? <Badge variant="outline" className="border-emerald-500/25 text-emerald-700 dark:text-emerald-300">{tUi("Current phone")}</Badge> : <span className="text-muted-foreground">{station.shared ? tUi("Shared workstation") : tUi("Assigned to you")}</span>}</div>
        </button>;
      })}</div> : <p className="px-4 py-8 text-center text-sm text-muted-foreground">{tUi("No matching phones are available for your account.")}</p> : null}
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t pt-4"><Button type="button" variant="ghost" size="sm" className="sm:mr-auto" disabled={blocked || (!initial && choice?.kind === "none")} onClick={() => choose(null)}>{tUi("Continue without voice")}</Button>{initial && selected && selected.kind !== "webrtc" && !choice?.station_id ? <Button type="button" variant="outline" size="icon" aria-label={tUi("Ring to identify")} title={tUi("Ring to identify")} disabled={blocked || selected.busy} onClick={identify}><BellRing className="size-4" /></Button> : null}<Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{initial ? tUi("Sign out") : tUi("Cancel")}</Button><Button type="button" disabled={blocked || !selected || selected.busy} onClick={() => choose(selected)}>{busy ? tUi("Switching…") : initial ? tUi("Start working") : tUi("Use this phone")}</Button></div>
  </>;
}
