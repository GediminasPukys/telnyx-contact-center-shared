"use client";
import { useEffect, useState } from "react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

export function HeadsetRolloutSettings() {
  const tUi = useUiText();
  const [value, setValue] = useState(null), [error, setError] = useState(null), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/headsets", { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("Headset settings could not be loaded.");
      setValue(await response.json());
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, []);
  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const response = await fetch("/api/admin/headsets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || "Headset settings could not be saved.");
      setValue(result); setSaved(true); window.dispatchEvent(new Event("experimental-features:refresh"));
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };
  return <Card><CardHeader><CardTitle className="text-base">{tUi("USB headset controls")}</CardTitle></CardHeader><CardContent className="space-y-3">
    <p className="text-sm text-muted-foreground">{tUi("Enable call controls for approved users. Individual access is managed in each user's profile. Changes reach open clients within 15 seconds.")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{tUi(error)}</p>}
    {!value && !error ? <><Skeleton className="h-8 w-full" /><Skeleton className="h-24 w-full" /></> : value && <>
      {[["all", "Enable headset controls"], ["jabra", "Jabra"], ["epos", "EPOS / Sennheiser"], ["poly", "Poly / Plantronics"]].map(([key, label]) => <label key={key} className="flex items-center justify-between gap-3 text-sm">{tUi(label)}<Switch aria-label={tUi(label)} disabled={saving} checked={key === "all" ? value.enabled : !value.disabledVendors.includes(key)} onCheckedChange={checked => { setSaved(false); setValue(current => key === "all" ? { ...current, enabled: checked } : { ...current, disabledVendors: checked ? current.disabledVendors.filter(v => v !== key) : [...new Set([...current.disabledVendors, key])] }); }} /></label>)}
      <Button onClick={save} disabled={saving}>{tUi(saving ? "Saving…" : "Save headset settings")}</Button>
      {saved && <p role="status" className="text-xs text-muted-foreground">{tUi("Headset settings saved.")}</p>}
    </>}
  </CardContent></Card>;
}
