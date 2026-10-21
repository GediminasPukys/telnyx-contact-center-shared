import { createHeadsetControlService } from '../../lib/headsets/headset-control-service.mjs';
import { createPolyAdapter } from '../../lib/headsets/adapters/poly-adapter.mjs';
import { createAudioRouter } from '../../lib/headsets/audio-routing.mjs';
import { createAudioDeviceDiscovery, reconcileAudioSuggestion } from '../../lib/headsets/audio-device-discovery.mjs';
import { createAudioControlSelection } from '../../lib/headsets/audio-control-selection.mjs';
import { createCallStateActions, createHeadsetCommandController, headsetCallInProgress } from '../../lib/headsets/call-controller.mjs';
import { jabraFixture, eposFixture, polyFixture } from '../helpers/headset-fixtures.mjs';
import store from '../../lib/stores/headset-store';
import active from '../../lib/stores/active-call-store';
const jabra = jabraFixture(), epos = eposFixture(), poly = polyFixture();
jabra.device.name = 'Jabra PRO 930'; poly.device.productName = 'Poly Voyager Focus 2';
const service = createHeadsetControlService({ adapters: [jabra.adapter, epos.adapter, createPolyAdapter({hid:poly.hid})] });
const audio = createAudioRouter({getCall:()=>active.getState().call,getClient:()=>null,getMuted:()=>active.getState().ui.isMuted,onChange:audio=>store.getState().update({audio})});
const actions = createCallStateActions({getState:active.getState,submitHold:async()=>{}});
const changes = [];
const end = () => { active.setState({call:null,status:'idle',ui:{...active.getState().ui,isRinging:false,isMuted:false,isHeld:false}});changes.push('end'); };
const controller = createHeadsetCommandController({getState:active.getState,isCurrent:service.isCurrentCommand,getHandlers:()=>({answer:async()=>{active.getState().call.state='active';active.setState({status:'active',ui:{...active.getState().ui,isRinging:false}});changes.push('answer');},hangup:end,reject:end,...actions})});
service.onCommand(c=>controller.execute(c)); service.onChange(value=>store.getState().update({...value,status:value.busy?'connecting':value.device?.connectionState||'disconnected'}));service.onDiagnostic(d=>store.getState().recordDiagnostic(d));
active.subscribe(value=>{void service.setSoftphoneState(headsetCallInProgress(value.call,value.status)?{callId:value.call?.id,ringing:value.ui.isRinging,active:['active','held'].includes(value.status),muted:value.ui.isMuted,held:value.ui.isHeld}:{});});
export const getHeadsetControlService=()=>service,getHeadsetAudioRouter=()=>audio;
const selection=createAudioControlSelection({service,isCurrentAudio:suggestion=>['inputId','outputId'].every(kind=>!suggestion[kind]||suggestion[kind]===audio.getSnapshot()[kind])});
export const selectAudioCallControl=suggestion=>selection.select(suggestion);
export const selectHeadsetControlDevice=key=>{selection.cancel();return service.selectDevice(key);};
const discoverAudio = createAudioDeviceDiscovery();
const systemAudio = [{deviceId:'default',kind:'audioinput',label:'System microphone'},{deviceId:'default',kind:'audiooutput',label:'System speaker'}];
const usbAudio = [{deviceId:'mic',kind:'audioinput',label:'USB headset microphone',groupId:'usb'},{deviceId:'speaker',kind:'audiooutput',label:'USB headset speaker',groupId:'usb'}];
const extraAudio = [{deviceId:'new-mic',kind:'audioinput',label:'New test headset',groupId:'new-usb'},{deviceId:'new-speaker',kind:'audiooutput',label:'New test headset',groupId:'new-usb'}];
let audioInventory = [...systemAudio,...usbAudio];
const publishAudio = () => {
  const suggestion=discoverAudio(audioInventory) || store.getState().audioSuggestion;
  store.getState().update({audioDevices:audioInventory,audioSuggestion:reconcileAudioSuggestion(suggestion,audioInventory,audio.getSnapshot())});
};
export async function refreshHeadsetAudioDevices(){store.getState().update({audioLoading:true});await new Promise(r=>setTimeout(r,100));publishAudio();store.getState().update({audioLoading:false});}
export async function simulateAudioConnection(connected){
  discoverAudio(audioInventory);
  audioInventory=connected?[...systemAudio,...usbAudio]:systemAudio;
  publishAudio();
  await audio.checkDevices(audioInventory);
}
export async function simulateTransientAudio(){await simulateAudioConnection(false);await new Promise(r=>setTimeout(r,300));await simulateAudioConnection(true);}
export function simulateNewHeadset(){audioInventory=[...systemAudio,...usbAudio,...extraAudio];publishAudio();}
export function simulateActiveCall(){
  const call={id:'simulated-audio-call',state:'active',setAudioInDevice:async()=>{}};
  active.setState({call,status:'active',ui:{...active.getState().ui,isRinging:false,isMuted:false,isHeld:false}});
}
export const endSimulatedCall=end;
export async function initialize(){await service.init();epos.login();epos.discover({ProductName:'Sennheiser SC230 USB CTRL II'});await refreshHeadsetAudioDevices();}
window.testHeadsets={
  changes,service,jabra,epos,poly,actions,audio,store:active,
  incoming(id='call1'){
    const call={id,state:'ringing',muteAudio(){changes.push('mute');},unmuteAudio(){changes.push('unmute');},hold(){call.state='held';changes.push('hold');},unhold(){call.state='active';changes.push('resume');},setAudioInDevice:async()=>{}};
    active.setState({call,status:'ringing',ui:{...active.getState().ui,isRinging:true,isMuted:false,isHeld:false}});
  },end,
  snapshot:()=>({call:active.getState().call?.id,status:active.getState().status,ui:active.getState().ui,headset:service.getSnapshot(),reports:poly.reports,epos:epos.sent,jabra:jabra.calls}),
};
