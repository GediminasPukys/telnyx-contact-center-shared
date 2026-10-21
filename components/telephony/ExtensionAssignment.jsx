"use client";
import { useCallback, useEffect, useState } from "react";
import { useUiText } from "@/components/i18n/use-ui-text";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

export async function directoryRequest(url, options) {
  const response = await fetch(url,{cache:"no-store",...options});
  const body = await response.json().catch(()=>({error:"Request failed"}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}
export default function ExtensionAssignment({ type, targetId, onSaved }) {
  const tUi = useUiText(), { can } = useAuth();
  const [data,setData]=useState(null), [error,setError]=useState(""), [search,setSearch]=useState("");
  const [number,setNumber]=useState(""), [saving,setSaving]=useState(false), [loading,setLoading]=useState(true);
  const allowed=can?.("extensions:read");
  const load=useCallback(async signal=>{
    if (!targetId || !allowed) return;
    setLoading(true);setError("");
    try {
      const value=await directoryRequest(`/api/admin/extensions?${new URLSearchParams({type,targetId,search})}`,{signal});
      setData(value);setNumber(value.current || "");
    } catch(e) { if(e.name!=="AbortError")setError(e.message); }
    finally {if(!signal?.aborted)setLoading(false);}
  },[type,targetId,search,allowed]);
  useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>load(controller.signal),150);return()=>{clearTimeout(timer);controller.abort();};},[load]);
  if(!allowed)return null;
  async function save() {
    setSaving(true);setError("");
    try {
      await directoryRequest("/api/admin/extensions",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"assign",type,targetId,number:number||null,expectedNumber:data.current})});
      const previousNumber = data.current || "";
      await load();onSaved?.({number:number || "",previousNumber});
    }catch(e){setError(e.message);}finally{setSaving(false);}
  }
  return <div className="rounded-xl border bg-card p-4 space-y-3" data-testid={`extension-${type}`}>
    <div><Label>{tUi("Internal extension")}</Label><p className="text-xs text-muted-foreground mt-1">{tUi("One number from the pool assigned to this object category.")}</p></div>
    {!targetId ? <p className="text-sm text-muted-foreground">{tUi("Save this object before assigning its extension.")}</p> : <>
      {loading&&!data ? <Skeleton className="h-10 w-full"/> : data ? <>
        <p className="text-xs text-muted-foreground">{data.pool ? `${data.pool.name} · ${data.pool.start_number}–${data.pool.end_number}` : tUi("No pool is configured for this object category.")}</p>
        {data.pool ? <div className="flex flex-wrap items-end gap-2">
          <Input className="w-36" aria-label={tUi("Search available extensions")} placeholder={tUi("Find number")} value={search} onChange={e=>setSearch(e.target.value)} inputMode="numeric"/>
          <select aria-label={tUi("Available extension")} className="h-9 min-w-36 rounded-md border bg-background px-3 text-sm" value={number} onChange={e=>setNumber(e.target.value)} disabled={loading||saving}>
            <option value="">{tUi("Unassigned")}</option>
            {[...new Set([data.current,...data.numbers].filter(Boolean))].map(n=><option key={n} value={n}>{n}{n===data.current?` · ${tUi("Current")}`:""}</option>)}
          </select>
          <Button size="sm" type="button" onClick={save} disabled={saving||loading||!can?.("extensions:assign")||number===(data.current||"")}>{saving?tUi("Saving..."):tUi("Save extension")}</Button>
        </div> : null}
        {loading?<Skeleton className="h-1 w-full"/>:null}
      </> : null}
      {error?<p className="text-sm text-destructive" role="alert">{tUi(error)}</p>:null}
    </>}
  </div>;
}
