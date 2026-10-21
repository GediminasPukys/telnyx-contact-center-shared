"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, AlertTriangle, Check, Download, Headphones, Info, RefreshCw, Settings, X } from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HandoffProblemNote } from "@/components/contact-center/handoff/HandoffParts";
import { getHeadsetControlService, getHeadsetAudioRouter, refreshHeadsetAudioDevices, selectAudioCallControl, selectHeadsetControlDevice } from "@/lib/headsets/client-headset-service";
import { headsetControlReady, headsetDeviceKey } from "@/lib/headsets/headset-control-service.mjs";
import { headsetCallInProgress } from "@/lib/headsets/call-controller.mjs";
import { shouldAutoOpenAudioSuggestion } from "@/lib/headsets/audio-device-discovery.mjs";
import { createHeadsetDiagnostics } from "@/lib/headsets/diagnostics.mjs";
import useHeadsetStore from "@/lib/stores/headset-store";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { HeadsetArtwork } from "./HeadsetArtwork";
import { getHeadsetDisplay, getPairedHeadsetModels } from "@/lib/headsets/headset-device-catalog";

const vendorLabels = { jabra: "Jabra", poly: "Poly", epos: "EPOS" };
const modelPreferenceKey = "cc.headset.paired-models.v1";
let sessionModelPreferences = "{}";
const readModelPreferences = () => {
  try { return window.localStorage.getItem(modelPreferenceKey) || sessionModelPreferences; }
  catch { return sessionModelPreferences; }
};
const subscribeModelPreferences = listener => {
  const onStorage = event => { if (!event.key || event.key === modelPreferenceKey) listener(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener("headsets:model-change", listener);
  return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("headsets:model-change", listener); };
};

export function HeadsetStatusBadge() {
  const tUi = useUiText();
  const [open, setOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(() => shouldAutoOpenAudioSuggestion(useHeadsetStore.getState().audioSuggestion, null, useActiveCallStore.getState()));
  const triggerRef = useRef(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState(null);
  const [tab, setTab] = useState("devices");
  const storedModels = useSyncExternalStore(subscribeModelPreferences, readModelPreferences, () => "{}");
  const pairedModels = useMemo(() => {
    try { const value = JSON.parse(storedModels); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  }, [storedModels]);
  const { device, devices, selectedKey, status, sync, error, busy, audio, audioDevices, audioLoading, diagnostics, audioSuggestion } = useHeadsetStore();
  const callInProgress = useActiveCallStore(state => state.consultInProgress || headsetCallInProgress(state.call, state.status));
  const ready = headsetControlReady(device);
  const owner = !["in-use", "unsupported", "disabled"].includes(status);
  const displayFor = value => getHeadsetDisplay(value, pairedModels[headsetDeviceKey(value)]);
  const display = displayFor(device);
  const pairedChoices = getPairedHeadsetModels(device);
  const choosePairedModel = id => {
    const next = { ...pairedModels, [selectedKey]: id };
    sessionModelPreferences = JSON.stringify(next);
    try { window.localStorage.setItem(modelPreferenceKey, sessionModelPreferences); } catch { /* Keep the session choice. */ }
    window.dispatchEvent(new Event("headsets:model-change"));
  };
  useEffect(() => { if (open || quickOpen) void refreshHeadsetAudioDevices(); }, [open, quickOpen]);
  useEffect(() => useHeadsetStore.subscribe((next, previous) => {
    if (shouldAutoOpenAudioSuggestion(next.audioSuggestion, previous.audioSuggestion, useActiveCallStore.getState())) setQuickOpen(true);
  }), []);
  const run = async operation => {
    setWorking(true); setProblem(null);
    try { await operation(); } catch (err) { setProblem(err.message); }
    finally { setWorking(false); }
  };
  const service = () => {
    const value = getHeadsetControlService();
    if (!value || !owner) throw new Error("Headset controls are unavailable in this tab.");
    return value;
  };
  const exportDiagnostics = () => {
    // Deliberately omit serial numbers, device IDs, call IDs and raw vendor payloads.
    const data = createHeadsetDiagnostics({ status, sync, device, devices, audio, diagnostics }, {
      secureContext: window.isSecureContext, webHid: Boolean(navigator.hid), audioOutputSelection: "setSinkId" in HTMLMediaElement.prototype,
    });
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "headset-diagnostics.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const selectAudio = (kind, id) => run(() => getHeadsetAudioRouter().setRoute({ [kind]: id }));
  const dismissAudioSuggestion = () => useHeadsetStore.getState().update({ audioSuggestion: null });
  const activateAudioSuggestion = () => run(async () => {
    const { name, ...route } = audioSuggestion;
    await getHeadsetAudioRouter().setRoute(route);
    if (owner && !callInProgress) await selectAudioCallControl(audioSuggestion);
    dismissAudioSuggestion();
  });
  const locked = working || busy;
  const statusText = ready ? (sync === "error" ? "Control synchronization failed" : "Headset selected")
    : status === "connecting" ? "Connecting to headsets" : status === "in-use" ? "Controls in another tab" : "Choose a headset";
  return (
    <>
      <Popover open={quickOpen} onOpenChange={setQuickOpen}>
        <PopoverTrigger asChild>
          <button ref={triggerRef} type="button" title={tUi(statusText)} aria-label={tUi("Headset controls")} data-testid="headset-trigger"
            className={`relative grid h-7 w-7 place-items-center rounded-full border transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green ${ready && sync !== "error" ? "border-telnyx-green text-emerald-700 dark:text-telnyx-green" : "border-border text-muted-foreground"}`}>
            <Headphones className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent data-testid="headset-quick-panel" align="end" side="bottom" sideOffset={10} collisionPadding={12}
          onCloseAutoFocus={event => { if (open) event.preventDefault(); }} aria-label={tUi("Headset and audio devices")}
          className="z-[1100] w-80 max-w-[calc(100vw-24px)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-2xl bg-popover p-4 shadow-xl">
          <div className="mb-3 flex items-center gap-2 border-b pb-3">
            <HeadsetArtwork device={display.artworkDevice} className="size-16" />
            <div className="min-w-0 flex-1"><p className="text-sm font-semibold leading-snug break-words">{display.name || tUi("Headset")}</p>{display.adapterName && <p className="mt-1 text-xs text-muted-foreground">{tUi("via {value0}", { value0: display.adapterName })}</p>}<p className="mt-1 text-xs text-muted-foreground" role="status">{tUi(statusText)}</p></div>
            <button type="button" aria-label={tUi("Headset settings and tests")} title={tUi("Headset settings and tests")} data-testid="headset-settings" onClick={() => { setQuickOpen(false); setOpen(true); }}
              className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green"><Settings className="size-5" /></button>
          </div>
          <div className="space-y-3">
            {audioSuggestion && <div role="status" className="rounded-xl border border-telnyx-green/30 bg-muted p-3 text-sm">
              <p className="font-medium">{tUi("New audio device detected")}</p>
              <p className="mt-1 break-words text-muted-foreground">{audioSuggestion.name}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" disabled={working} onClick={activateAudioSuggestion}>{tUi("Use this device")}</Button>
                <Button size="sm" variant="ghost" disabled={working} onClick={dismissAudioSuggestion}>{tUi("Keep current audio")}</Button>
              </div>
            </div>}
            {audio.notice && !audio.error && <p role="status" className="text-xs text-muted-foreground">{tUi("Audio device disconnected. Using system audio.")}</p>}
            {(problem || error || audio.error) && <HandoffProblemNote problem={tUi(problem || error || audio.error)} />}
            {status === "connecting" && !devices.length ? <Skeleton className="h-10 rounded-xl" /> : <label className="block text-xs font-medium">{tUi("Control device")}
              <select aria-label={tUi("Control device")} value={selectedKey || ""} disabled={locked || callInProgress || !owner} onChange={event => run(() => selectHeadsetControlDevice(event.target.value || null))} className="mt-1 h-10 w-full rounded-xl border bg-background px-3 text-sm">
                <option value="">{tUi("No call controls")}</option>
                {selectedKey && !devices.some(d => headsetDeviceKey(d) === selectedKey) && <option value={selectedKey}>{tUi("Selected headset disconnected")}</option>}
                {devices.map(d => { const view = displayFor(d); return <option key={headsetDeviceKey(d)} value={headsetDeviceKey(d)} disabled={!headsetControlReady(d)}>{view.name || d.vendorLabel}{view.adapterName ? ` · ${view.adapterName}` : ""}{headsetControlReady(d) ? "" : ` — ${tUi("unavailable")}`}</option>; })}
              </select>
            </label>}
            {device?.transport && <p className="text-xs text-muted-foreground">{device.vendorLabel} · {device.transport}{typeof device.battery?.levelPercent === "number" ? ` · ${Math.round(device.battery.levelPercent)}%` : ""}</p>}
            <HeadsetAudioSelectors audio={audio} devices={audioDevices} loading={audioLoading} disabled={locked} onSelect={selectAudio} />
          </div>
        </PopoverContent>
      </Popover>
      <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[1150] bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content data-testid="headset-dialog" onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}
          className="fixed left-1/2 top-1/2 z-[1160] flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border shadow-2xl"
          style={{ backgroundColor: "var(--modal, var(--background))", color: "var(--modal-foreground, var(--foreground))", borderColor: "var(--modal-border, var(--border))" }}>
          <div className="relative shrink-0 px-5 pb-3 pt-5">
            <Dialog.Close className="absolute right-3 top-3 rounded-full p-2 text-muted-foreground hover:bg-muted" aria-label={tUi("Close")}><X className="size-4" /></Dialog.Close>
            <Dialog.Title className="text-lg font-semibold">{tUi("Headset controls")}</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-muted-foreground" role="status">{tUi(statusText)}</Dialog.Description>
          </div>
            <Tabs value={tab} onValueChange={setTab} className="min-h-0 gap-0 px-5 pb-5">
            <TabsList aria-label={tUi("Headset settings")} className="mb-4">
              <TabsTrigger value="devices">{tUi("Devices")}</TabsTrigger>
              <TabsTrigger value="diagnostics">{tUi("Diagnostics")}</TabsTrigger>
            </TabsList>
            <TabsContent value="devices" className="min-h-0 space-y-4 overflow-y-auto data-[state=inactive]:hidden">
              {(problem || error || audio.error) && <HandoffProblemNote problem={tUi(problem || error || audio.error)} />}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{tUi("Control device")}</h3>
                  {selectedKey && <button type="button" disabled={locked || callInProgress || !owner} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50" onClick={() => run(() => selectHeadsetControlDevice(null))}>{tUi("Disconnect call controls")}</button>}
                </div>
                {status === "connecting" && !devices.length ? <div className="space-y-2" aria-label={tUi("Loading headsets")}><Skeleton className="h-16 rounded-2xl" /><Skeleton className="h-16 rounded-2xl" /></div>
                  : devices.length ? devices.map(item => {
                    const key = headsetDeviceKey(item), selected = key === selectedKey, available = headsetControlReady(item), view = displayFor(item);
                    return <button key={key} type="button" aria-pressed={selected} disabled={locked || callInProgress || !available || !owner} onClick={() => run(() => selectHeadsetControlDevice(key))}
                      className={`flex w-full items-center gap-3 rounded-xl border bg-muted px-3 py-2 text-left disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-telnyx-green ${selected ? "border-telnyx-green" : ""}`}>
                      <HeadsetArtwork device={view.artworkDevice} className="size-10 shrink-0" /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold leading-snug break-words">{view.name || item.vendorLabel}</span><span className="block text-xs text-muted-foreground">{!available ? tUi(item.connectionState === "audio-only" ? "Audio only" : "Call control unavailable") : view.adapterName ? tUi("via {value0}", { value0: view.adapterName }) : item.vendorLabel}</span></span>{selected && <Check className="size-4 shrink-0 text-emerald-700 dark:text-telnyx-green" />}
                    </button>;
                  }) : <p className="rounded-xl border bg-muted p-3 text-sm text-muted-foreground">{tUi("No headset connected")}</p>}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={locked || !owner || callInProgress} onClick={() => run(() => service().requestPermission("jabra"))}>{tUi("Add Jabra")}</Button>
                  <Button variant="outline" size="sm" disabled={locked || !owner || callInProgress} onClick={() => run(() => service().requestPermission("poly"))}>{tUi("Add Poly")}</Button>
                </div>
                {!devices.some(item => item.vendor === "epos" && headsetControlReady(item)) && <p className="text-xs text-muted-foreground">{tUi("For EPOS / Sennheiser, start EPOS Connect on this computer. For Jabra and Poly, use desktop Chrome or Edge and allow device access.")}</p>}
                {pairedChoices.length > 0 && <div>
                  <label className="block text-xs font-medium">{tUi("Paired headset model")}
                    <select aria-label={tUi("Paired headset model")} value={display.pairedModelId} disabled={locked} onChange={event => choosePairedModel(event.target.value)} className="mt-1 h-10 w-full rounded-xl border bg-background px-3 text-sm">
                      <option value="">{tUi("Not specified — show USB adapter")}</option>
                      {pairedChoices.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                    </select>
                  </label>
                </div>}
              </div>
              <div className="space-y-2 border-t pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{tUi("Call audio")}</h3>
                  <Button variant="ghost" size="sm" disabled={locked || audioLoading} onClick={() => run(() => refreshHeadsetAudioDevices(true))} aria-label={tUi("Allow microphone access and refresh")}><RefreshCw className="size-3.5" />{tUi("Refresh")}</Button>
                </div>
                <HeadsetAudioSelectors audio={audio} devices={audioDevices} loading={audioLoading} disabled={locked} onSelect={selectAudio} columns />
              </div>
              <div className="flex flex-wrap gap-2 border-t pt-3">
                <Button variant="outline" size="sm" disabled={locked || callInProgress || !ready || !device.capabilities?.ring} onClick={() => run(() => service().sendTestCommand("ring"))}>{tUi("Test")} · {tUi("Ring indication")}</Button>
                <Button variant="ghost" size="sm" disabled={locked || callInProgress} onClick={() => window.dispatchEvent(new Event("headsets:retry"))}>{tUi("Reconnect headset services")}</Button>
              </div>
            </TabsContent>
            <TabsContent value="diagnostics" className="flex min-h-0 flex-col gap-3 data-[state=inactive]:hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">{tUi("Control status")}</span>
                <span className="flex gap-2"><span className="rounded-md border bg-muted px-2 py-1 capitalize">{status}</span><span className="rounded-md border bg-muted px-2 py-1 capitalize">{sync}</span></span>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{tUi("Headset events")} <span className="ml-1 text-xs font-normal tabular-nums text-muted-foreground">{diagnostics.length}</span></h3>
                <Button variant="outline" size="sm" onClick={exportDiagnostics}><Download className="size-4" />{tUi("Export diagnostics")}</Button>
              </div>
              <ol className="min-h-0 max-h-96 overflow-y-auto rounded-xl border bg-muted" aria-label={tUi("Headset events")} tabIndex={0}>
                {diagnostics.length ? diagnostics.map((entry, i) => {
                  const level = entry.level || "info";
                  const Icon = level === "error" ? AlertCircle : level === "warn" ? AlertTriangle : Info;
                  const tone = level === "error" ? "text-destructive" : level === "warn" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground";
                  const time = entry.at ? new Date(entry.at) : null;
                  const validTime = time && !Number.isNaN(time.getTime());
                  return <li key={`${entry.at}-${i}`} className="flex gap-3 border-b px-3 py-3 last:border-b-0">
                    <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                        <span className="font-semibold">{vendorLabels[entry.vendor] || entry.vendor || tUi("Headset")}</span>
                        <span className={`font-medium uppercase ${tone}`}>{level}</span>
                        <time className="ml-auto font-mono tabular-nums text-muted-foreground" dateTime={validTime ? time.toISOString() : undefined} title={validTime ? time.toLocaleString() : undefined}>{validTime ? time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—"}</time>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{tUi(entry.message)}</p>
                    </div>
                  </li>;
                }) : <li className="p-5 text-center text-sm text-muted-foreground">{tUi("No headset events recorded.")}</li>}
              </ol>
            </TabsContent>
            </Tabs>
        </Dialog.Content>
      </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function HeadsetAudioSelectors({ audio, devices, loading, disabled, onSelect, columns = false }) {
  const tUi = useUiText();
  const layout = columns ? "grid gap-3 sm:grid-cols-2" : "space-y-2";
  if (loading) return <div className={layout} aria-label={tUi("Loading audio devices")}><Skeleton className="h-14 rounded-xl" /><Skeleton className="h-14 rounded-xl" /></div>;
  return <div className={layout}>{[["inputId", "audioinput", "Microphone"], ["outputId", "audiooutput", "Speaker"]].map(([key, kind, label]) => <label key={key} className="block min-w-0 text-xs font-medium">{tUi(label)}
    <select aria-label={tUi(label)} value={audio[key]} disabled={disabled} onChange={event => onSelect(key, event.target.value)} className="mt-1 h-10 w-full min-w-0 rounded-xl border bg-background px-3 text-sm">
      <option value="">{tUi("System default")}</option>
      {audio[key] && !devices.some(d => d.kind === kind && d.deviceId === audio[key]) && <option value={audio[key]}>{tUi("Selected device unavailable")}</option>}
      {devices.filter(d => d.kind === kind).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || tUi("Audio device {value0}", { value0: i + 1 })}</option>)}
    </select>
  </label>)}</div>;
}
