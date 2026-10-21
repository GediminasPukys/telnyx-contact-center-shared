"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useUiText } from "@/components/i18n/use-ui-text";
import { directoryRequest } from "./ExtensionAssignment";
import { setVoiceLoginChoice } from "@/lib/telephony/endpoint-client";
export default function PhoneSelectionGate({children}) {
  const router=useRouter(),tUi=useUiText(),[ready,setReady]=useState(false),[error,setError]=useState("");
  useEffect(()=>{
    let alive=true;
    directoryRequest("/api/telephony/stations").then(data=>{
      if(!alive)return;
      if(!data.choice){router.replace("/signin/phone");return;}
      setVoiceLoginChoice(data.choice);setReady(true);
    }).catch(e=>{if(alive)setError(e.message);});
    return()=>{alive=false;};
  },[router]);
  if(ready)return children;
  return <div className="m-auto w-full max-w-xl space-y-4 p-8">{error?<><p role="alert" className="text-destructive">{tUi(error)}</p><Button onClick={()=>router.replace("/signin/phone")}>{tUi("Choose your phone")}</Button></>:<><Skeleton className="h-10 w-2/3"/><Skeleton className="h-48 w-full"/><Skeleton className="h-10 w-full"/></>}</div>;
}
