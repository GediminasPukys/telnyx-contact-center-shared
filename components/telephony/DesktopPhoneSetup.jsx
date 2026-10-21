"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Search, RefreshCw, LockKeyhole, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useUiText } from "@/components/i18n/use-ui-text";
import StationArtwork from "./StationArtwork";
const messages={auth_failed:"The password was not accepted.",rest_api_disabled:"Enable the REST API in the Poly phone's settings, then try again.",
  device_mac_mismatch:"The phone identity changed. Discover it again.",network_changed:"The network changed. Discover phones again.",
  device_idle_state_unavailable:"This legacy phone cannot confirm that it is idle. Ask an administrator to configure its SIP account.",
  unsupported_device_model:"This firmware or model has not been certified for automatic setup.",phone_has_active_call:"Finish the call on the phone before configuring it.",
  device_readback_mismatch:"The phone did not confirm its new settings. Check the setup result before retrying."};
const phases={preparing:"Preparing configuration and recovery copy…",saving:"Saving phone settings and administrator password…",checking_settings:"Verifying settings with the new administrator password…",connecting_bridge:"Connecting the desktop bridge…",preparing_restart:"Waiting for the phone to accept activation…",restarting:"Restarting the phone…",waiting_for_phone:"Waiting for the phone to come back online…",registering:"Checking SIP registration…",complete:"Phone configured",pending:"Settings saved · activation not yet confirmed",failed:"Phone setup could not be completed"};
export default function DesktopPhoneSetup({onClose,onComplete,onBusyChange}) {
  const tUi=useUiText(),[result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[query,setQuery]=useState("");
  const [selected,setSelected]=useState(null),[password,setPassword]=useState(""),[needsPassword,setNeedsPassword]=useState(false),[done,setDone]=useState(null),[progress,setProgress]=useState(null),[elapsed,setElapsed]=useState(0);
  useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
  useEffect(()=>{const native=window.contactCenterDesktop;let active=true;
    native.nearby().then(r=>{if(!active)return;setResult(r);if(r.progress){setProgress(r.progress);setSelected(r.phones.find(p=>p.candidateId===r.progress.candidateId)||null);if(r.progress.phase==='pending')setDone({pending:true});}}).catch(e=>{if(active)setError(e.message);});
    const unsubscribe=native.onSetupProgress(p=>{setProgress(p);});return()=>{active=false;unsubscribe();};
  },[]);
  useEffect(()=>{if(!busy||!progress?.startedAt)return;const tick=()=>setElapsed(Math.max(0,Math.floor((Date.now()-Date.parse(progress.startedAt))/1000)));tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);},[busy,progress?.startedAt]);
  async function run(fn){setBusy(true);setError("");try{return await fn();}catch(e){const raw=e.message.replace(/^Error invoking remote method '[^']+': Error: /,"");setError(messages[raw]||raw);}finally{setBusy(false);}}
  async function scan(){setSelected(null);setNeedsPassword(false);setPassword("");setDone(null);setProgress(null);await run(async()=>setResult(await window.contactCenterDesktop.discover()));}
  async function login(phone,provided){setSelected(phone);setDone(null);setProgress(null);await run(async()=>{
    const r=await window.contactCenterDesktop.authenticate(phone.candidateId,provided);
    setPassword("");setNeedsPassword(!!r.needsPassword);if(r.phone){setSelected(r.phone);setResult(old=>({...old,phones:old.phones.map(p=>p.candidateId===r.phone.candidateId?r.phone:p)}));}
  });}
  async function configure(verify=false){await run(async()=>{const r=await window.contactCenterDesktop[verify?'verify':'configure'](selected.candidateId);setDone(r);if(r.ok)onComplete?.();});}
  const phones=result?.phones?.filter(p=>[p.name,p.model,p.vendor,p.mac,p.ip].some(v=>String(v||"").toLowerCase().includes(query.toLowerCase())))||[];
  const working=busy&&progress&&!['failed','complete','pending'].includes(progress.phase);
  return <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="desktop-phone-setup" aria-busy={busy}>
    <div className="flex shrink-0 items-center justify-between gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}><ArrowLeft className="size-4"/>{tUi("Back to phones")}</Button><Button variant="outline" size="sm" disabled={busy} onClick={scan}><RefreshCw className={busy&&!selected?"size-4 animate-spin":"size-4"}/>{tUi("Find phones")}</Button></div>
    <p className="shrink-0 text-xs text-muted-foreground">{tUi("Connect your phone and computer to the same network. Choose a discovered phone to configure it.")}</p>
    <div className="relative shrink-0"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground"/><Input className="pl-9" placeholder={tUi("Find a local phone")} aria-label={tUi("Find a local phone")} value={query} onChange={e=>setQuery(e.target.value)}/></div>
    <div className="min-h-28 flex-1 overflow-y-auto pr-1" data-testid="discovered-phone-list"><div className="grid gap-2 sm:grid-cols-2">
      {!result&&!error?[1,2,3,4].map(n=><Skeleton key={n} className="h-20 rounded-xl"/>):null}
      {phones.map(p=><button type="button" disabled={busy} aria-pressed={p.candidateId===selected?.candidateId} key={p.candidateId} onClick={()=>login(p)} className={`flex min-w-0 items-center gap-2 rounded-xl border bg-muted/20 p-2.5 text-left disabled:cursor-wait ${p.candidateId===selected?.candidateId?'border-emerald-500/60':'hover:border-emerald-500/40'}`}><StationArtwork station={{...p,kind:"deskphone"}} className="h-12 w-12 shrink-0"/><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{p.model||p.name}</p><p className="text-xs text-muted-foreground">{p.ip}</p><p className="truncate font-mono text-[10px] text-muted-foreground">{p.mac}</p></div>{p.candidateId===selected?.candidateId&&busy?<Loader2 className="size-4 shrink-0 animate-spin text-emerald-500"/>:<Badge variant="outline" className="px-1 text-[10px] text-emerald-600 dark:text-emerald-300">{tUi("Nearby")}</Badge>}</button>)}
    </div>{result?.scannedAt&&!phones.length?<p className="py-4 text-center text-sm text-muted-foreground">{tUi("No phones found. Check the network and allow local network access for Contact Center Desktop.")}</p>:result&&!result.scannedAt?<p className="py-4 text-center text-sm text-muted-foreground">{tUi("Choose Find phones to search your local network.")}</p>:null}</div>
    {(selected||error)?<div className="max-h-[45%] shrink-0 space-y-3 overflow-y-auto border-t pt-3" data-testid="phone-setup-details">
      {selected?<div className="flex items-center justify-between gap-2"><p className="text-sm font-semibold">{selected.model||selected.name} <span className="font-normal text-muted-foreground">· {selected.ip}</span></p>{done?.extension?<Badge variant="outline">#{done.extension}</Badge>:null}</div>:null}
      {error?<p role="alert" className="rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{tUi(error)}</p>:null}
      {progress&&selected?<div role="status" aria-live="polite" className="flex items-start gap-2 text-sm">{working?<Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-emerald-500"/>:done?.ok?<CheckCircle2 className="size-4 text-emerald-500"/>:done?.pending?<AlertCircle className="size-4 text-amber-500"/>:null}<div><p>{tUi(phases[progress.phase]||"Checking your phone…")}{working?<span className="ml-2 text-xs text-muted-foreground">{elapsed}s</span>:null}</p>{working?<p className="mt-1 text-xs text-muted-foreground">{progress.verificationOnly?tUi("Checking status only. The phone will not restart."):tUi("Keep this app open. The phone may restart; verification can take up to four minutes.")}</p>:done?.pending?<p className="mt-1 text-xs text-muted-foreground">{tUi("Keep the bridge running. Check activation again without changing settings or restarting the phone.")}</p>:null}</div></div>:busy?<p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin"/>{tUi("Checking your phone…")}</p>:null}
      {!busy&&needsPassword?<form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();login(selected,password);}}><p className="w-full text-xs text-muted-foreground">{tUi("The factory password was not accepted. Enter this phone's administrator password.")}</p><Input className="min-w-0 flex-1" type="password" autoComplete="off" aria-label={tUi("Phone administrator password")} placeholder={tUi("Phone administrator password")} value={password} maxLength={128} onChange={e=>setPassword(e.target.value)}/><Button size="sm" type="submit" disabled={!password}><LockKeyhole className="size-4"/>{tUi("Connect to phone")}</Button></form>:null}
      {!busy&&selected?.authenticated&&!done?<div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{tUi("Access verified. Its extension will be assigned automatically.")}</p><Button size="sm" onClick={()=>configure()}>{tUi("Configure phone")}</Button></div>:null}
      {!busy&&done?.pending?<Button variant="outline" size="sm" onClick={()=>configure(true)}><RefreshCw className="size-4"/>{tUi("Check activation")}</Button>:null}
      {!busy&&done?.ok?<div className="flex items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{tUi(done.notice || "Return to the phone list and choose this phone to start working.")}</p><Button size="sm" onClick={onClose}>{tUi("Back to phones")}</Button></div>:null}
    </div>:null}
    {result?.limited?<p className="shrink-0 text-xs text-muted-foreground">{tUi("This network is larger than the automatic scan range. Ask your administrator about undiscovered stations.")}</p>:null}
  </div>;
}
