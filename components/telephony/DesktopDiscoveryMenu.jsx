"use client";
import {useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {useUiText} from '@/components/i18n/use-ui-text';
import DesktopPhoneSetup from './DesktopPhoneSetup';
import useActiveCallStore from '@/lib/stores/active-call-store';
export default function DesktopDiscoveryMenu(){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),tUi=useUiText();
  useEffect(()=>window.contactCenterDesktop?.onDiscoveryRequested(()=>setOpen(true)),[]);
  useEffect(()=>{
    const report=window.contactCenterDesktop?.reportCallBusy;
    if(!report)return;
    const sync=state=>report(Boolean(state.call && !['idle','ended','done','destroy','purge','hangup'].includes(state.status)));
    sync(useActiveCallStore.getState());
    return useActiveCallStore.subscribe(sync);
  },[]);
  return <Dialog open={open} onOpenChange={next=>{if(!busy)setOpen(next);}}><DialogContent className="flex h-[min(700px,88dvh)] flex-col overflow-hidden sm:max-w-[680px]" showCloseButton={!busy} onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}><DialogHeader><DialogTitle>{tUi('Local phones')}</DialogTitle><DialogDescription>{tUi('Find and configure a phone on this network.')}</DialogDescription></DialogHeader><DesktopPhoneSetup onBusyChange={setBusy} onClose={()=>setOpen(false)}/></DialogContent></Dialog>;
}
