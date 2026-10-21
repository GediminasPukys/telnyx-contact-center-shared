"use client";
import { useCallback, useEffect, useState } from "react";
import { IconPhone, IconPhoneOff, IconPlayerPause, IconPlayerPlay, IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useUiText } from "@/components/i18n/use-ui-text";
import { voiceFetch, voiceEndpointRegistration } from "@/lib/telephony/endpoint-client";
import { usePhoneChoice } from "./use-phone-choice";
export default function NativePhoneControls() {
  const tUi=useUiText(),choice=usePhoneChoice(),hardware=["deskphone","sip"].includes(choice?.kind);
  const [state,setState]=useState(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const control=useCallback(async(action)=>{
    const response=await voiceFetch("/api/telephony/stations/control",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action})});
    const body=await response.json();
    if(!response.ok)throw new Error(body.error||"Phone control failed");
    return body;
  },[]);
  useEffect(()=>{
    if(choice?.kind!=="deskphone" || !choice.native_control)return;
    let alive=true,pending=false;
    const refresh=async()=>{
      if(pending||!voiceEndpointRegistration())return;
      pending=true;
      try{const next=await control("status");if(alive){setState(next);setError("");}}
      catch(e){if(alive)setError(e.message);}finally{pending=false;}
    };
    const first=setTimeout(refresh,500),timer=setInterval(refresh,5000);
    return()=>{alive=false;clearTimeout(first);clearInterval(timer);};
  },[choice?.kind,choice?.native_control,control]);
  async function act(action) {
    setBusy(true);setError("");
    try{await control(action);setState(await control("status"));}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  const calls=Array.isArray(state?.call)?state.call:state?.call?[state.call]:[];
  return <div className="space-y-3">
    {choice?.native_control?<p className="text-xs text-muted-foreground">{calls.length?tUi("Call in progress"):state?tUi("Phone idle"):tUi("Checking phone…")}</p>:null}
    {hardware&&!choice.native_control?<p className="mt-2 text-xs text-muted-foreground">{tUi("Answer and control calls using your SIP client. Routing and agent availability are managed here.")}</p>:null}
    {choice?.kind==="deskphone"&&choice.native_control?<div className="mt-2 space-y-2">{!state&&!error?<Skeleton className="h-8 w-full"/>:<div className="grid grid-cols-2 gap-2">{[
      ["answer","Answer",IconPhone],["hangup","Hang up",IconPhoneOff],["hold","Hold",IconPlayerPause],["resume","Resume",IconPlayerPlay],["mute","Mute",IconMicrophoneOff],["unmute","Unmute",IconMicrophone],
    ].map(([action,label,Icon])=><Button key={action} variant="outline" size="sm" disabled={busy||!calls.length} onClick={()=>act(action)}><Icon size={15}/>{tUi(label)}</Button>)}</div>}
      {error?<p role="alert" className="text-xs text-destructive">{tUi(error)}</p>:null}</div>:null}
  </div>;
}
