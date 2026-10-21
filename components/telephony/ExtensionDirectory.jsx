"use client";

import { useState } from "react";
import { IconCheck, IconChevronRight, IconDeviceDesktop, IconDeviceLandlinePhone, IconDeviceMobile, IconHash, IconRoute, IconTrash, IconUsers } from "@tabler/icons-react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const extensionCategories = [
  { id: "phone", name: "Phones", icon: IconDeviceLandlinePhone, tone: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  { id: "user", name: "Users", icon: IconUsers, tone: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  { id: "queue", name: "Queues", icon: IconRoute, tone: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
];
export const categoryFor = type => extensionCategories.find(c => c.id === type) || extensionCategories[0];
export const stationKindLabel = kind => kind === "webrtc" ? "WebRTC" : kind === "sip" ? "SIP client" : "Desk phone";

export function ObjectIcon({ type, kind, className }) {
  const category = categoryFor(type);
  const Icon = type === "phone" && kind === "webrtc" ? IconDeviceDesktop
    : type === "phone" && kind === "sip" ? IconDeviceMobile : category.icon;
  return <span className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-xl border", category.tone, className)}><Icon className="size-5" stroke={1.7} /></span>;
}

export function CategoryBadge({ type, className }) {
  const tUi = useUiText();
  const category = categoryFor(type);
  return <Badge variant="outline" className={cn("font-medium", category.tone, className)}>{tUi(category.name)}</Badge>;
}

export function PoolTile({ category, pool, count, loading, selected, onSelect }) {
  const tUi = useUiText();
  const capacity = pool ? pool.end_number - pool.start_number + 1 : 0;
  return <button type="button" onClick={onSelect} disabled={loading} aria-pressed={selected} aria-controls="extension-editor"
    data-testid={`pool-${category.id}`}
    className={cn("@container/pool-tile min-w-0 overflow-hidden rounded-xl border bg-card p-3 text-left shadow-sm transition hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected && "border-muted-foreground/60 ring-1 ring-border")}>
    <div className="space-y-3">
      <div className="flex min-h-9 items-center gap-1.5" data-testid="pool-heading">
        <ObjectIcon type={category.id} className="size-7 rounded-lg [&_svg]:size-4 @min-[230px]/pool-tile:size-9 @min-[230px]/pool-tile:[&_svg]:size-5" />
        {loading ? <Skeleton className="h-5 min-w-0 flex-1" /> : <p className="min-w-0 flex-1 text-xs font-semibold leading-tight tracking-tight tabular-nums @min-[230px]/pool-tile:text-base">{pool ? `${pool.start_number} – ${pool.end_number}` : tUi("No pool configured")}</p>}
        <CategoryBadge type={category.id} className="px-1.5 text-[10px] @min-[230px]/pool-tile:text-xs" />
      </div>
      {loading ? <><Skeleton className="h-12 w-full" /><Skeleton className="h-5 w-3/4" /></> : <>
        <div className="grid grid-cols-2 gap-2 border-t border-border/60 pt-3">
          <div><p className="text-lg font-semibold tabular-nums">{count ?? "—"}</p><p className="text-xs text-muted-foreground">{tUi("Defined objects")}</p></div>
          <div><p className="text-lg font-semibold tabular-nums">{pool?.used ?? "—"}<span className="text-xs font-normal text-muted-foreground">{pool ? ` / ${capacity}` : ""}</span></p><p className="text-xs text-muted-foreground">{tUi("Assigned numbers")}</p></div>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-muted-foreground/50 transition-all" style={{ width: `${capacity ? Math.min(100, pool.used / capacity * 100) : 0}%` }} /></div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{pool ? tUi("{value0} available · {value1} digits", { value0: capacity - pool.used, value1: pool.digits }) : tUi("Configure range")}</span>
          {selected ? <IconCheck className="size-4 text-primary" /> : <IconChevronRight className="size-4" />}
        </div>
      </>}
    </div>
  </button>;
}

export function PoolEditor({ pool, category, pools, busy, onSave, onDelete }) {
  const tUi = useUiText(), { can } = useAuth();
  const [draft, setDraft] = useState(() => pool ? { ...pool, start: pool.start_number, end: pool.end_number } : { name: "", digits: 4, start: "", end: "", types: [category.id] });
  const allowed = can(pool ? "extensions:update" : "extensions:create");
  return <form className="space-y-5" onSubmit={e => { e.preventDefault(); onSave(draft); }}>
    <div className="flex items-center gap-3"><ObjectIcon type={draft.types[0]} /><div><h2 className="text-base font-semibold">{pool ? tUi("Edit number pool") : tUi("Create number pool")}</h2><p className="mt-1 text-xs text-muted-foreground">{tUi("One separate range for each object category.")}</p></div></div>
    <fieldset disabled={busy || !allowed} className="space-y-4">
      <div className="space-y-2"><Label htmlFor="pool-name">{tUi("Pool name")}</Label><Input id="pool-name" required maxLength={80} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></div>
      <div className="grid grid-cols-[1fr_90px] gap-3">
        <div className="space-y-2"><Label htmlFor="pool-category">{tUi("Object category")}</Label><select id="pool-category" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={draft.types[0]} disabled={Boolean(pool)} onChange={e => setDraft({ ...draft, types: [e.target.value] })}>
          {extensionCategories.filter(c => c.id === draft.types[0] || !pools.some(p => p.types.includes(c.id))).map(c => <option key={c.id} value={c.id}>{tUi(c.name)}</option>)}
        </select></div>
        <div className="space-y-2"><Label htmlFor="pool-digits">{tUi("Digits")}</Label><select id="pool-digits" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={draft.digits} onChange={e => setDraft({ ...draft, digits: Number(e.target.value) })}>{[3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2"><Label htmlFor="pool-start">{tUi("First extension")}</Label><Input id="pool-start" required inputMode="numeric" pattern="[0-9]{3,5}" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} /></div>
        <div className="space-y-2"><Label htmlFor="pool-end">{tUi("Last extension")}</Label><Input id="pool-end" required inputMode="numeric" pattern="[0-9]{3,5}" value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })} /></div>
      </div>
      <Button className="w-full" type="submit">{busy ? tUi("Saving...") : tUi("Save pool")}</Button>
    </fieldset>
    {pool ? <div className="space-y-2 border-t pt-4"><Button className="w-full" type="button" variant="outline" disabled={busy || pool.used > 0 || !can("extensions:delete")} onClick={() => onDelete(pool.id)}><IconTrash className="size-4" />{tUi("Delete empty pool")}</Button>{pool.used > 0 ? <p className="text-xs text-muted-foreground">{tUi("Reassign allocated numbers before deleting this pool.")}</p> : null}</div> : null}
  </form>;
}

export function DirectoryList({ objects, selected, onSelect, loading }) {
  const tUi = useUiText();
  if (loading) return <div role="status" aria-label={tUi("Loading objects")} className="space-y-3 p-4">{[1, 2, 3, 4, 5].map(n => <div key={n} className="flex items-center gap-3"><Skeleton className="size-10 rounded-xl" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div><Skeleton className="h-7 w-16" /></div>)}</div>;
  if (!objects) return null;
  if (!objects.length) return <div className="flex flex-col items-center gap-3 p-8 text-center"><span className="rounded-full bg-muted p-3"><IconHash className="size-6 text-muted-foreground" /></span><p className="text-sm text-muted-foreground">{tUi("No matching objects. Sync the phone catalog to include provisioned phones and WebRTC phones.")}</p></div>;
  return <div>
    <div className="sticky top-0 z-10 flex items-center justify-between border-y bg-card px-4 py-2 text-xs font-medium text-muted-foreground"><span>{tUi("Object / model")}</span><span className="pr-6">{tUi("Extension")}</span></div>
    <div className="divide-y">{objects.map(object => {
      const active = selected?.type === object.type && selected?.id === object.id;
      return <button type="button" key={`${object.type}:${object.id}`} onClick={() => onSelect(object)} aria-pressed={active} aria-controls="extension-editor"
        className={cn("group flex w-full items-center gap-3 border-l-2 border-l-transparent px-4 py-3.5 text-left transition hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", active && "border-l-primary bg-primary/5")}
        data-testid={`directory-${object.type}`}>
        <ObjectIcon type={object.type} kind={object.kind} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{object.name}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><CategoryBadge type={object.type} />
            {object.type === "phone" ? <Badge variant="outline" className="border-teal-500/20 bg-teal-500/5 font-normal text-teal-700 dark:text-teal-300">{object.detail}</Badge>
              : object.type === "user" ? <span className="truncate text-xs text-muted-foreground">{object.detail}</span> : null}
          </div>
        </div>
        <Badge variant="outline" className={cn("shrink-0 px-2.5 py-1 font-mono text-sm", object.number ? categoryFor(object.type).tone : "border-dashed text-muted-foreground")}>{object.number || tUi("Unassigned")}</Badge>
        <IconChevronRight className={cn("size-4 shrink-0 text-muted-foreground/40 group-hover:text-foreground", active && "text-primary")} />
      </button>;
    })}</div>
  </div>;
}
