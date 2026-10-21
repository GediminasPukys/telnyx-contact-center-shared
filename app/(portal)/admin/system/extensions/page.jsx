"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconAdjustmentsHorizontal, IconDeviceLandlinePhone, IconHash, IconListDetails, IconPlus, IconRefresh, IconSearch } from "@tabler/icons-react";
import { SystemSectionPage } from "@/components/admin/SystemSectionNav";
import { AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import ExtensionAssignment, { directoryRequest } from "@/components/telephony/ExtensionAssignment";
import { CategoryBadge, DirectoryList, ObjectIcon, PoolEditor, PoolTile, categoryFor, extensionCategories } from "@/components/telephony/ExtensionDirectory";
import { StationEditor, StationList, useStationCatalog } from "@/components/telephony/StationAdministration";

export default function ExtensionsPage() {
  const tUi = useUiText(), { can } = useAuth();
  const [data, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false), [saveError, setSaveError] = useState("");
  const [search, setSearch] = useState(""), [type, setType] = useState(""), [tab, setTab] = useState("directory");
  const [stationSearch, setStationSearch] = useState("");
  const [editor, setEditor] = useState({ kind: "pool", category: "phone" });
  const editorRef = useRef(null);
  const layoutRef = useRef(null);
  const catalog = useStationCatalog(tab === "stations" || editor.kind === "station");
  const load = useCallback(async signal => {
    setLoading(true);
    try {
      const next = await directoryRequest(`/api/admin/extensions?${new URLSearchParams({ search, type })}`, { signal });
      setData(next); setError("");
    } catch (e) { if (e.name !== "AbortError") setError(e.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [search, type]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => load(controller.signal), 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [load]);

  function select(next) {
    setEditor(next); setSaveError("");
    if (window.matchMedia("(min-width: 1280px)").matches) editorRef.current?.scrollTo({ top: 0 });
    else if (editorRef.current && layoutRef.current) {
      const container = layoutRef.current;
      const top = editorRef.current.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top, behavior: "smooth" });
    }
  }
  async function mutate(body, method = "POST") {
    setBusy(true); setSaveError("");
    try {
      await directoryRequest(`/api/admin/extensions${method === "DELETE" ? `?id=${body.id}` : ""}`, {
        method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
      if (body.types) setEditor({ kind: "pool", category: body.types[0] });
      await load();
      if (tab === "stations") await catalog.refresh();
    } catch (e) { setSaveError(e.message); } finally { setBusy(false); }
  }
  async function stationSaved(id) {
    const next = await catalog.refresh();
    const station = next?.find(s => s.id === id);
    if (station) setEditor({ kind: "station", station });
    await load();
  }
  const pool = data?.pools.find(p => p.types.includes(editor.category));
  const selectedObject = editor.kind === "object" ? data?.objects.find(o => o.type === editor.object.type && o.id === editor.object.id) || editor.object : null;
  const selectedStation = editor.kind === "station" ? catalog.stations?.find(s => s.id === editor.station.id) || editor.station : null;
  const unusedCategory = extensionCategories.find(c => !data?.pools.some(p => p.types.includes(c.id)));

  return <AdminPageShell>
    <AdminPageHeader title={tUi("Extensions & stations")} icon={IconHash} actions={<>
      <Button variant="outline" disabled={busy || !can("extensions:create")} onClick={() => mutate({ action: "sync" })}><IconRefresh className={cn("size-4", busy && "animate-spin")} />{tUi("Sync phone catalog")}</Button>
      <Button disabled={!data || !unusedCategory || !can("extensions:create")} onClick={() => select({ kind: "pool", category: unusedCategory.id })}><IconPlus className="size-4" />{tUi("Add pool")}</Button>
    </>} />
    <SystemSectionPage activeId="extensions">
      <div ref={layoutRef} className="grid min-h-0 flex-1 gap-4 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_380px] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
        <section aria-label={tUi("Extension directory")} className="flex min-h-0 min-w-0 flex-col gap-4" data-testid="extensions-overview">
          <Card className="shrink-0">
            <CardHeader className="p-4"><CardTitle className="flex items-center gap-2 text-lg"><IconHash className="size-5 text-sky-500" />{tUi("Number pools")}</CardTitle><p className="text-sm text-muted-foreground">{tUi("Separate number pools for phones, users and queues. One shared directory.")}</p></CardHeader>
            <CardContent className="px-4 pb-4">
              {error ? <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{tUi(error)}<Button size="sm" variant="outline" onClick={() => load()}>{tUi("Retry")}</Button></div> : null}
              {data || loading ? <div className="grid gap-3 md:grid-cols-3">{extensionCategories.map(category => <PoolTile key={category.id} category={category} pool={data?.pools.find(p => p.types.includes(category.id))} count={data?.counts?.[category.id]} loading={!data && loading} selected={editor.kind === "pool" && editor.category === category.id} onSelect={() => select({ kind: "pool", category: category.id })} />)}</div> : null}
            </CardContent>
          </Card>
          <Card className="flex h-[min(600px,65svh)] min-h-64 flex-col overflow-hidden xl:h-auto xl:min-h-0 xl:flex-1" data-testid="extension-objects-card">
            <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
              <div className="shrink-0 px-4 pt-3">
                <TabsList aria-label={tUi("Extension directory")}>
                  <TabsTrigger value="directory"><IconListDetails />{tUi("Number assignments")}</TabsTrigger>
                  <TabsTrigger value="stations"><IconDeviceLandlinePhone />{tUi("Phones & occupancy")}</TabsTrigger>
                </TabsList>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 p-4">
                <div className="relative min-w-36 flex-1"><IconSearch className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" aria-label={tUi("Search name, model or extension")} placeholder={tUi("Search name, model or extension")} value={tab === "directory" ? search : stationSearch} onChange={e => tab === "directory" ? setSearch(e.target.value) : setStationSearch(e.target.value)} /></div>
                {tab === "directory" ? <select aria-label={tUi("Object category")} className="h-9 rounded-md border bg-background px-3 text-sm" value={type} onChange={e => setType(e.target.value)}><option value="">{tUi("All objects")}</option>{extensionCategories.map(c => <option key={c.id} value={c.id}>{tUi(c.name)}</option>)}</select> : null}
                {tab === "stations" ? <Button size="sm" variant="outline" disabled={!can("extensions:create")} onClick={() => select({ kind: "new-station" })}><IconPlus className="size-4" />{tUi("Add SIP client")}</Button> : data && !loading ? <Badge variant="outline" className="font-normal tabular-nums">{tUi("{value0} shown", { value0: data.objects.length })}</Badge> : null}
              </div>
              <TabsContent value="directory" className="min-h-0 overflow-y-auto overscroll-contain" data-testid="extension-objects-scroll">
                <DirectoryList objects={data?.objects} loading={loading} selected={selectedObject} onSelect={object => select({ kind: "object", object })} />
              </TabsContent>
              <TabsContent value="stations" className="min-h-0 overflow-y-auto overscroll-contain" data-testid="extension-stations-scroll">
                {catalog.error ? <div role="alert" className="flex items-center justify-between gap-3 px-4 pb-4 text-sm text-destructive">{tUi(catalog.error)}<Button variant="outline" size="sm" onClick={() => catalog.refresh()}>{tUi("Retry")}</Button></div> : null}
                {catalog.stations || !catalog.error ? <StationList stations={catalog.stations} search={stationSearch} selectedId={selectedStation?.id} onSelect={station => select({ kind: "station", station })} /> : null}
              </TabsContent>
            </Tabs>
          </Card>
        </section>
        <aside id="extension-editor" ref={editorRef} aria-label={tUi("Extensions configuration")} className="min-w-0 xl:min-h-0 xl:overflow-y-auto">
          <Card className="min-h-80">
            <CardHeader className="border-b pb-4"><div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground"><IconAdjustmentsHorizontal className="size-4 text-amber-500" />{tUi("Configuration")}</div><p className="text-xs text-muted-foreground">{tUi("Select a range or an object to edit its configuration.")}</p></CardHeader>
            <CardContent className="space-y-5 pt-5">
              {saveError ? <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{tUi(saveError)}</p> : null}
              {editor.kind === "pool" ? !data ? loading ? <div className="space-y-5"><Skeleton className="h-12 w-full" />{[1, 2, 3].map(n => <Skeleton key={n} className="h-16 w-full" />)}</div> : <p className="text-sm text-muted-foreground">{tUi("Reload the directory to configure a number pool.")}</p> : <PoolEditor key={`${editor.category}:${pool?.id || "new"}`} pool={pool} category={categoryFor(editor.category)} pools={data.pools} busy={busy} onSave={body => mutate(body)} onDelete={id => mutate({ id }, "DELETE")} /> : null}
              {selectedObject ? <>
                <div className="flex items-start gap-3"><ObjectIcon type={selectedObject.type} kind={selectedObject.kind} /><div className="min-w-0"><h2 className="break-words text-base font-semibold">{selectedObject.name}</h2><div className="mt-2"><CategoryBadge type={selectedObject.type} /></div></div></div>
                <div className="rounded-lg border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">{tUi(selectedObject.type === "phone" ? "Model / client" : "Object")}</p><p className="mt-1 break-words text-sm font-medium">{selectedObject.detail}</p></div>
                <ExtensionAssignment key={`${selectedObject.type}:${selectedObject.id}`} type={selectedObject.type} targetId={selectedObject.id} onSaved={() => load()} />
              </> : null}
              {editor.kind === "station" || editor.kind === "new-station" ? <StationEditor key={selectedStation?.id || "new"} station={selectedStation} onSaved={stationSaved} onAssigned={() => stationSaved(selectedStation?.id)} /> : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </SystemSectionPage>
  </AdminPageShell>;
}
