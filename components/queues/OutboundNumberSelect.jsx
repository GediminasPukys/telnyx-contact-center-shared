"use client";
import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandItem, CommandGroup } from "@/components/ui/command";
import { Check, ChevronsUpDown, Phone } from "lucide-react";
import { useUiText } from "@/components/i18n/use-ui-text";

export default function OutboundNumberSelect({ value, number, onChange, endpoint = "/api/admin/queues/number-options", id = "queue-outbound-number", label, description }) {
  const tUi = useUiText();
  const trigger = useRef(null);
  const [portalContainer,setPortalContainer] = useState(undefined);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState(""), [page, setPage] = useState(1);
  const [result, setResult] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}&page=${page}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        setResult(data);
      } catch (e) { if (!controller.signal.aborted) setError(e.message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, page, open, endpoint]);
  const selectedNumber = selected?.id === value ? selected.number : number;
  function choose(item) {
    setSelected(item);
    onChange(item?.id || "", item?.number || "");
    setOpen(false);
  }
  return <div className="space-y-2">
    <Label htmlFor={id}>{label || tUi("Outbound caller ID (DID)")}</Label>
    <Popover modal open={open} onOpenChange={value => {
      if(value){setPortalContainer(trigger.current?.closest('[role="dialog"]') || undefined);setLoading(true);setError("");}
      setOpen(value);
    }}>
      <PopoverTrigger asChild>
        <Button ref={trigger} id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
          <span className="flex min-w-0 items-center gap-2"><Phone className="size-4 shrink-0 text-telnyx-green" /><span className="truncate">{value ? selectedNumber || tUi("Current number") : tUi("No outbound number")}</span></span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent portalContainer={portalContainer} align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false}>
          <CommandInput aria-label={tUi("Search Telnyx numbers")} placeholder={tUi("Search Telnyx numbers")} value={query} onValueChange={v => { setQuery(v); setPage(1); setLoading(true);setError(""); }} />
          <CommandList aria-busy={loading}>
            <CommandGroup><CommandItem value="none" onSelect={() => choose(null)}><Check className={`size-4 ${!value ? "opacity-100" : "opacity-0"}`} />{tUi("No outbound number")}</CommandItem></CommandGroup>
            {loading ? <div className="space-y-2 p-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
              : error ? <p role="alert" className="p-3 text-sm text-destructive">{error}</p>
              : <CommandGroup>{result?.items?.length ? result.items.map(n => <CommandItem key={n.id} value={n.id} onSelect={() => choose(n)}><Check className={`size-4 ${value === n.id ? "text-telnyx-green" : "opacity-0"}`} /><span className="font-mono">{n.number}</span></CommandItem>) : <p className="p-3 text-sm text-muted-foreground">{tUi("No numbers found")}</p>}</CommandGroup>}
          </CommandList>
        </Command>
        {Number(result?.meta?.total_pages || 1) > 1 && <div className="flex justify-between border-t p-1">
          <Button type="button" variant="ghost" size="sm" disabled={loading || page === 1} onClick={() => setPage(p => p - 1)}>{tUi("Previous")}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={loading || page >= Number(result?.meta?.total_pages || 1)} onClick={() => setPage(p => p + 1)}>{tUi("Next")}</Button>
        </div>}
      </PopoverContent>
    </Popover>
    <p className="text-xs text-muted-foreground">{description || tUi("Agents can use this number when calling on behalf of the queue. Inbound call routing is configured in Call & App Flows.")}</p>
  </div>;
}
