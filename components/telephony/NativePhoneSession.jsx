"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePhoneChoice } from "./use-phone-choice";
import { voiceFetch, voiceEndpointRegistration, voiceLoginChoice } from "@/lib/telephony/endpoint-client";
import { nativeActionAllowed, nativePhoneState } from "@/lib/telephony/native-phone-state.mjs";
import useActiveCallStore from "@/lib/stores/active-call-store";
import { notify } from "@/components/ToastNotify";

const Context = createContext(null);
const initial = { observation:null, loading:true, error:"", busy:false };
export const useNativePhone = () => useContext(Context);

export default function NativePhoneSession({ children }) {
  const choice = usePhoneChoice();
  const native = ["deskphone", "sip"].includes(choice?.kind);
  const stationId = native ? choice.station_id : null;
  const [snapshot,setSnapshot] = useState(initial);
  const session = useRef(null);
  const stateKnown = choice?.native_control && ["polycom", "audiocodes", "yealink"].includes(choice?.vendor);
  const current = snapshot.stationId === stationId ? snapshot : initial;
  const view = nativePhoneState(current.observation, { callStateKnown:stateKnown && Boolean(current.observation) });

  useEffect(() => {
    if (!stationId) return;
    const token = { stationId, pending:false, busy:false, alive:true, observation:null, controller:new AbortController() };
    session.current = token;
    const publish = patch => { if (token.alive) setSnapshot(previous => ({...(previous.stationId === stationId ? previous : initial),...patch,stationId})); };
    async function request(action, params = {}) {
      if (!token.alive || voiceLoginChoice()?.station_id !== stationId) throw Error("The selected phone has changed.");
      const response = await voiceFetch("/api/telephony/stations/control", { method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,...params}),signal:token.controller.signal });
      const body = await response.json();
      if (!response.ok) throw Error(body.error || "Phone control failed");
      if (!token.alive || voiceLoginChoice()?.station_id !== stationId) throw Error("The selected phone has changed.");
      return body;
    }
    token.refresh = (afterAction = false) => {
      if (token.pending) return token.pending;
      if (!token.alive || (token.busy && !afterAction) || !choice.native_control || !voiceEndpointRegistration()) return;
      token.pending = (async () => { try {
        const result = await request("status");
        if (!token.alive) return;
        token.observation = result;
        publish({observation:result,loading:false,error:""});
        syncCall(result);
      } catch(error) { if (token.alive) publish({error:error.message,loading:false}); }
      finally { token.pending = null; } })();
      return token.pending;
    };
    function syncCall(observation) {
      const info = nativePhoneState(observation,{callStateKnown:stateKnown});
      const store = useActiveCallStore.getState();
      const owns = store.call?.transport === "station" && store.call.stationId === stationId;
      if (info.callCount > 0) {
        const id = `station:${stationId}:${info.callRef || "unknown"}`;
        const direction = observation.interaction?.attributes?.native_station_id ? "outbound" : info.direction;
        if (!store.call || (owns && store.call.id !== id)) {
          store.setActiveCall({id,stationId,transport:"station",state:info.status,callControlId:observation.interaction?.agent_call_control_id}, {direction,interactionId:observation.interaction?.id,fromNumber:info.direction === "inbound" ? info.remoteNumber : info.localNumber,toNumber:info.direction === "inbound" ? info.localNumber : info.remoteNumber,fromName:info.remoteName});
        }
        const current = useActiveCallStore.getState();
        if (current.call?.id === id) {
          if (observation.interaction?.id) current.setContactCenterMetadata({interactionId:observation.interaction.id});
          current.updateStatus(info.status);
          current.setHeld(info.isHeld);
          if (info.isMuted !== null) current.setMuted(info.isMuted);
        }
      } else if (owns && info.status === "idle") {
        store.updateStatus("ended");
        store.clearActiveCall();
        window.dispatchEvent(new CustomEvent("contact-center:refresh-interactions"));
      }
    }
    token.act = async action => {
      if (token.busy || !token.alive) return false;
      token.busy = true;
      publish({busy:true,error:""});
      try {
        // Finish an in-flight observation before issuing a device mutation.
        await token.pending;
        if (!nativeActionAllowed(nativePhoneState(token.observation,{callStateKnown:stateKnown}),action.name)) throw Error("This phone action is unavailable for the current call.");
        const info = nativePhoneState(token.observation);
        await request(action.name,{...action.params,callRef:info.callRef});
        return true;
      } catch(error) {
        publish({error:error.message});
        throw error;
      } finally {
        await token.refresh(true);
        token.busy = false;
        publish({busy:false});
      }
    };
    const first = setTimeout(() => {publish({...initial,loading:Boolean(choice.native_control)});void token.refresh();},0);
    const timer = setInterval(token.refresh,2500);
    return () => {
      token.alive = false; token.controller.abort(); clearTimeout(first);clearInterval(timer);
      if (session.current === token) session.current = null;
      const store = useActiveCallStore.getState();
      if (store.call?.transport === "station" && store.call.stationId === stationId) store.clearActiveCall();
    };
  },[stationId,choice?.native_control,stateKnown]);

  const act = useCallback(async(name,params = {}) => {
    try { if (!session.current) return false; return await session.current.act({name,params}); }
    catch(error) { notify({title:"Phone control failed",description:error.message,variant:"error"}); return false; }
  },[]);
  const refresh = useCallback(() => session.current?.refresh(),[]);
  return <Context.Provider value={{...current,choice,native,view,stateKnown,act,refresh}}>{children}</Context.Provider>;
}
