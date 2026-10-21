"use client";

import { useCallback, useEffect, useState } from "react";
import { IconChevronRight, IconLock, IconUser, IconUsers } from "@tabler/icons-react";
import { useAuth } from "@/components/auth-provider";
import { useUiText } from "@/components/i18n/use-ui-text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import ExtensionAssignment, { directoryRequest } from "./ExtensionAssignment";
import { ObjectIcon, stationKindLabel } from "./ExtensionDirectory";
import StationArtwork from "./StationArtwork";

export function useStationCatalog(enabled) {
  const [stations, setStations] = useState(null), [error, setError] = useState("");
  const refresh = useCallback(async signal => {
    try {
      const data = await directoryRequest("/api/admin/stations", { signal });
      setStations(data.stations); setError("");
      return data.stations;
    } catch (e) { if (e.name !== "AbortError") setError(e.message); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const first = setTimeout(() => refresh(controller.signal), 0);
    const timer = setInterval(() => refresh(controller.signal), 15000);
    return () => { clearTimeout(first); clearInterval(timer); controller.abort(); };
  }, [enabled, refresh]);
  return { stations, error, refresh };
}

export function StationList({ stations, selectedId, onSelect, search = "" }) {
  const tUi = useUiText();
  if (!stations) return <div role="status" aria-label={tUi("Loading stations")} className="space-y-3 p-4">{[1, 2, 3, 4].map(n => <Skeleton key={n} className="h-20 w-full rounded-xl" />)}</div>;
  const visible = stations.filter(s => [s.name, s.model, s.kind, s.extension, s.occupant_name, s.owner_name].some(v => String(v || "").toLowerCase().includes(search.toLowerCase())));
  if (!visible.length) return <p className="p-8 text-center text-sm text-muted-foreground">{tUi("No matching stations.")}</p>;
  return <div className="divide-y">{visible.map(station => {
    const selected = selectedId === station.id;
    const status = !station.enabled ? "Disabled" : station.occupied ? "Occupied" : "Available";
    return <button key={station.id} type="button" onClick={() => onSelect(station)} aria-pressed={selected} aria-controls="extension-editor" data-testid="station-row"
      className={cn("flex w-full items-center gap-3 border-l-2 border-l-transparent px-4 py-4 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selected && "border-l-primary bg-primary/5")}>
      <ObjectIcon type="phone" kind={station.kind} />
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{station.name}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5"><Badge variant="outline" className="border-sky-500/25 bg-sky-500/10 font-normal text-sky-700 dark:text-sky-300">{tUi(stationKindLabel(station.kind))}</Badge>{station.model ? <Badge variant="outline" className="border-teal-500/20 bg-teal-500/5 font-normal text-teal-700 dark:text-teal-300">{station.model}</Badge> : null}</div>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">{station.occupied ? <IconLock className="size-3.5 shrink-0" /> : station.shared ? <IconUsers className="size-3.5 shrink-0" /> : <IconUser className="size-3.5 shrink-0" />}<span className="truncate">{station.occupied ? station.occupant_name : station.shared ? tUi("Shared workstation") : station.owner_name || tUi("No assigned user")}</span></p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2"><Badge variant="outline" className={cn("gap-1.5", !station.enabled ? "text-muted-foreground" : station.occupied ? "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}><span className="size-1.5 rounded-full bg-current" />{tUi(status)}</Badge><span className="font-mono text-xs text-muted-foreground">{station.extension ? `#${station.extension}` : tUi("Unassigned")}</span></div>
      <IconChevronRight className={cn("size-4 shrink-0 text-muted-foreground/40", selected && "text-primary")} />
    </button>;
  })}</div>;
}

export function StationEditor({ station, onSaved, onAssigned }) {
  const tUi = useUiText(), { can } = useAuth();
  const [draft, setDraft] = useState(() => station ? { ...station, ownerId: station.owner_id || "", connectionId: station.connection_id || "", sipUsername: station.sip_username || "" } : { name: "", kind: "sip", shared: true, enabled: true, ownerId: "", connectionId: "", sipUsername: "" });
  const [users, setUsers] = useState(null), [search, setSearch] = useState(""), [usersError, setUsersError] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false);
  const [release, setRelease] = useState(false), [reason, setReason] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => directoryRequest(`/api/admin/extensions?type=user&search=${encodeURIComponent(search)}`, { signal: controller.signal })
      .then(data => { setUsers(data.objects); setUsersError(""); })
      .catch(e => { if (e.name !== "AbortError") setUsersError(e.message); }), 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search]);
  const update = values => { setDraft(previous => ({ ...previous, ...values })); setSaved(false); };
  async function save(body) {
    setBusy(true); setError(""); setSaved(false);
    try {
      const result = await directoryRequest("/api/admin/stations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setRelease(false); setReason(""); setSaved(true);
      await onSaved(result.id || station?.id);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const editable = can(station ? "extensions:update" : "extensions:create") && !station?.lease_generation;
  return <div className="space-y-5">
    <div className="flex items-center gap-3"><StationArtwork station={station || draft} className="h-24 w-24 shrink-0" /><div className="min-w-0"><h2 className="break-words text-base font-semibold">{station?.name || tUi("Add SIP client")}</h2><Badge variant="outline" className="mt-2 border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300">{station?.model || tUi(stationKindLabel(draft.kind))}</Badge></div></div>
    {error ? <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{tUi(error)}</p> : null}
    {saved ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{tUi("Changes saved")}</p> : null}
    {station?.lease_generation ? <div className="space-y-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium"><IconLock className="size-4 text-amber-500" />{tUi("Signed in")}: {station.occupant_name}</p>
      <p className="text-xs text-muted-foreground">{tUi("Release this station before editing its assignment")}</p>
      {release ? <form className="space-y-3" onSubmit={e => { e.preventDefault(); save({ action: "release", stationId: station.id, generation: station.lease_generation, reason }); }}>
        <p className="text-xs text-muted-foreground">{tUi("Active calls and wrap-up cannot be interrupted. The release is recorded in the audit log.")}</p>
        <Input required aria-label={tUi("Reason")} placeholder={tUi("Reason")} value={reason} onChange={e => setReason(e.target.value)} />
        <div className="flex gap-2"><Button size="sm" disabled={busy || !reason.trim()}>{tUi("Release session")}</Button><Button size="sm" type="button" variant="ghost" onClick={() => setRelease(false)}>{tUi("Cancel")}</Button></div>
      </form> : <Button size="sm" variant="outline" disabled={!can("extensions:release")} onClick={() => setRelease(true)}>{tUi("Release session")}</Button>}
    </div> : null}
    <form className="space-y-4" onSubmit={e => { e.preventDefault(); save(draft); }}>
      <fieldset disabled={busy || !editable} className="space-y-4">
        <div className="space-y-2"><Label htmlFor="station-name">{tUi("Station name")}</Label><Input id="station-name" required maxLength={100} value={draft.name} onChange={e => update({ name: e.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="station-owner-search">{tUi("Assigned user")}</Label><Input id="station-owner-search" aria-label={tUi("Search users")} placeholder={tUi("Search users")} value={search} onChange={e => setSearch(e.target.value)} disabled={draft.kind === "webrtc"} />
          {!users && !usersError ? <Skeleton className="h-9 w-full" /> : <select aria-label={tUi("Assigned user")} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={draft.ownerId} disabled={draft.kind === "webrtc" || Boolean(usersError)} onChange={e => update({ ownerId: e.target.value })}>
            <option value="">{tUi("No assigned user")}</option>{draft.ownerId && !users?.some(u => u.id === draft.ownerId) ? <option value={draft.ownerId}>{draft.owner_name || draft.ownerId}</option> : null}{users?.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>}{usersError ? <p role="alert" className="text-xs text-destructive">{tUi(usersError)}</p> : null}
        </div>
        {draft.kind === "sip" ? <><div className="space-y-2"><Label htmlFor="station-connection">{tUi("Telnyx credential connection ID")}</Label><Input id="station-connection" required value={draft.connectionId} onChange={e => update({ connectionId: e.target.value })} /></div><div className="space-y-2"><Label htmlFor="station-sip">{tUi("SIP username")}</Label><Input id="station-sip" required value={draft.sipUsername} onChange={e => update({ sipUsername: e.target.value })} /></div></> : null}
        <div className="divide-y rounded-lg border px-3"><div className="flex items-center justify-between gap-3 py-3"><Label htmlFor="station-shared">{tUi("Shared workstation")}</Label><Switch id="station-shared" checked={draft.shared} disabled={draft.kind === "webrtc"} onCheckedChange={shared => update({ shared })} /></div><div className="flex items-center justify-between gap-3 py-3"><Label htmlFor="station-enabled">{tUi("Enabled")}</Label><Switch id="station-enabled" checked={draft.enabled} onCheckedChange={enabled => update({ enabled })} /></div></div>
        <Button type="submit" className="w-full">{busy ? tUi("Saving...") : tUi("Save station")}</Button>
      </fieldset>
    </form>
    {station?.id ? <ExtensionAssignment type="phone" targetId={station.id} onSaved={onAssigned} /> : null}
  </div>;
}
