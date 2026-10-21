import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioRouter} from '../lib/headsets/audio-routing.mjs';
import {createAudioDeviceDiscovery, reconcileAudioSuggestion, shouldAutoOpenAudioSuggestion} from '../lib/headsets/audio-device-discovery.mjs';
import {acquireCallAudio} from '../lib/headsets/audio-preflight.mjs';
import {findAudioControlDevice} from '../lib/headsets/audio-control-match.mjs';
import {createAudioControlSelection} from '../lib/headsets/audio-control-selection.mjs';
import {createHeadsetControlService} from '../lib/headsets/headset-control-service.mjs';
import {fakeAdapter, tick} from './helpers/headset-fixtures.mjs';

const builtIn = [{kind:'audioinput',deviceId:'builtin-mic',label:'MacBook microphone',groupId:'builtin'}, {kind:'audiooutput',deviceId:'builtin-out',label:'MacBook speakers',groupId:'builtin'}];
const usb = [{kind:'audioinput',deviceId:'usb-mic',label:'USB Headset',groupId:'usb'}, {kind:'audiooutput',deviceId:'usb-out',label:'USB Headset',groupId:'usb'}];
test('unplugged headset falls back immediately and preserves both muted and unmuted calls', async()=>{
  for(const muted of [false,true]) {
    const ops=[];let saved;
    const call={state:'active',setAudioInDevice:async(id,value)=>ops.push([id,value]),muteAudio:()=>assert.fail('successful fallback must not change mute')};
    const router=createAudioRouter({getCall:()=>call,getClient:()=>null,getMuted:()=>muted,storage:{setItem:(_,s)=>saved=JSON.parse(s)}});
    const el={setSinkId:async id=>ops.push(id)};router.registerElement(el);
    await router.setRoute({inputId:'usb-mic',outputId:'usb-out'});
    ops.length=0;await router.checkDevices(builtIn);
    assert.deepEqual(ops,[['default',muted],'default']);
    assert.deepEqual(saved,{inputId:'default',outputId:'default'});
    assert.equal(router.getSnapshot().error,null);assert.equal(el.muted,false);
    ops.length=0;await router.checkDevices([...builtIn,...usb]);
    assert.deepEqual(ops,[],'reconnecting must not silently reclaim audio');
    await router.applyToCall();assert.ok(!ops.some(Array.isArray),'same call does not reacquire the microphone on each render');
  }
});
test('new physical device produces a paired suggestion, not a permission or default-alias prompt',()=>{
  let time=0;
  const discover=createAudioDeviceDiscovery({now:()=>time});
  assert.equal(discover(builtIn),null);
  assert.equal(discover([...builtIn,{kind:'audioinput',deviceId:'default',label:'Default'}]),null);
  assert.deepEqual(discover([...builtIn,...usb]),{name:'USB Headset',inputId:'usb-mic',outputId:'usb-out'});
  assert.equal(discover([...builtIn,...usb]),null);
  discover(builtIn);time+=4000;assert.ok(discover([...builtIn,...usb]));
  discover([]);time+=4000;assert.ok(discover(usb));
});
test('Jabra, Sennheiser/EPOS and Poly inventory churn is not a new physical headset',()=>{
  for(const label of ['Jabra PRO 930 (0b0e:1016)','Sennheiser SC230 USB CTRL II (1395:004d)','Sennheiser BTD 800 USB for Lync (1395:002d)','Plantronics BT600 (047f:02f7)']) {
    let time=0;
    const discover=createAudioDeviceDiscovery({now:()=>time});
    const headset=usb.map(d=>({...d,label}));
    discover(builtIn);
    assert.ok(discover([...builtIn,...headset]),label);
    // CTI reports and refreshed default aliases leave the concrete inventory alone.
    for(let i=0;i<4;i++)assert.equal(discover([...headset,...builtIn,{kind:'audiooutput',deviceId:'default',label:`Default - ${label}`}]),null,label);
    discover(builtIn);time+=500;
    assert.equal(discover([...builtIn,...headset]),null,'brief endpoint disappearance');
    discover([]);time+=500;
    assert.equal(discover([...builtIn,...headset]),null,'temporary empty enumeration');
    const profile=headset.map(d=>({...d,deviceId:d.deviceId+'-call'}));
    assert.equal(discover([...builtIn,...profile]),null,'same hardware group, new endpoint IDs');
    const rotated=profile.map(d=>({...d,deviceId:d.deviceId+'-rotated',groupId:'new-profile-group'}));
    // Clear old tombstones while the current profile remains present.
    time+=4000;discover([...builtIn,...profile]);
    assert.equal(discover([...builtIn,...rotated]),null,'unique replaced endpoints, unchanged labels');
    discover(builtIn);time+=4000;
    assert.ok(discover([...builtIn,...rotated]),'real reconnection after removal still prompts');
  }
});
test('permission labels, cameras and delayed output interfaces never trigger another prompt',()=>{
  const discover=createAudioDeviceDiscovery();
  assert.equal(discover(builtIn.map(d=>({...d,label:''}))),null);
  assert.equal(discover(builtIn),null);
  const offer=discover([...builtIn,usb[0]]);
  assert.deepEqual(offer,{name:'USB Headset',inputId:'usb-mic'});
  assert.equal(discover([...builtIn,...usb]),null);
  assert.deepEqual(reconcileAudioSuggestion(offer,[...builtIn,...usb]),{...offer,outputId:'usb-out'});
  assert.equal(discover([...builtIn,...usb,{kind:'videoinput',deviceId:'camera',label:'USB camera'}]),null);
});
test('two simultaneously connected identical headsets remain separate devices',()=>{
  const discover=createAudioDeviceDiscovery();
  discover([...builtIn,...usb]);
  const second=usb.map(d=>({...d,deviceId:d.deviceId+'2',groupId:'usb2'}));
  assert.deepEqual(discover([...builtIn,...usb,...second]),{name:'USB Headset',inputId:'usb-mic2',outputId:'usb-out2'});
});
test('pending suggestions stay referentially stable, drop stale IDs and clear once selected',()=>{
  const suggestion={name:'USB Headset',inputId:'usb-mic',outputId:'usb-out'};
  assert.equal(reconcileAudioSuggestion(suggestion,[...builtIn,...usb]),suggestion);
  assert.equal(reconcileAudioSuggestion(suggestion,usb,{inputId:'usb-mic',outputId:'usb-out'}),null);
  assert.equal(reconcileAudioSuggestion(suggestion,builtIn),null);
  assert.deepEqual(reconcileAudioSuggestion(suggestion,[usb[1]]),{name:'USB Headset',outputId:'usb-out'});
});
test('suggestions never auto-open during a call, ringing, dialing, hold or consultation',()=>{
  const suggestion={name:'New headset',inputId:'new'};
  for(const state of ['ringing','trying','active','held']) {
    assert.equal(shouldAutoOpenAudioSuggestion(suggestion,null,{call:{state},status:state}),false,state);
  }
  assert.equal(shouldAutoOpenAudioSuggestion(suggestion,null,{consultInProgress:true}),false);
  assert.equal(shouldAutoOpenAudioSuggestion(suggestion,null,{status:'idle',call:null}),true);
  assert.equal(shouldAutoOpenAudioSuggestion({...suggestion,outputId:'out'},suggestion,{status:'idle'}),false,'late output must not reopen a dismissed panel');
  assert.equal(shouldAutoOpenAudioSuggestion(suggestion,suggestion,{status:'ended'}),false,'ending the call must not open a queued prompt');
  assert.equal(shouldAutoOpenAudioSuggestion(null,null,{}),false);
});
test('saved missing microphone is replaced before capture and the captured stream is reused for the call',async()=>{
  let constraints;
  const stream={getAudioTracks:()=>[{readyState:'live'}]};
  const router=createAudioRouter({getCall:()=>null,getClient:()=>null,getMuted:()=>false,storage:{getItem:()=>JSON.stringify({inputId:'old-usb'})}});
  const result=await acquireCallAudio({router,mediaDevices:{enumerateDevices:async()=>builtIn,getUserMedia:async c=>{constraints=c;return stream;}}});
  assert.equal(result,stream);assert.deepEqual(constraints,{audio:true,video:false});
  assert.equal(router.getSnapshot().inputId,'default');
});
test('microphone denial and missing hardware fail before a call can reserve capacity',async()=>{
  for(const [name,pattern] of [['NotAllowedError',/Allow microphone/],['NotFoundError',/No microphone/]]) {
    await assert.rejects(acquireCallAudio({mediaDevices:{enumerateDevices:async()=>builtIn,getUserMedia:async()=>{throw Object.assign(new Error('capture failed'),{name});}}}),pattern);
  }
});
test('an ended microphone cannot be passed to the SDK',async()=>{
  let stopped=false;
  const track={readyState:'ended',stop:()=>stopped=true};
  await assert.rejects(acquireCallAudio({mediaDevices:{enumerateDevices:async()=>builtIn,getUserMedia:async()=>({getAudioTracks:()=>[track],getTracks:()=>[track]})}}),/No microphone/);
  assert.equal(stopped,true);
});

test('audio activation matches the authorized BT600 control interface and ignores audio-only duplicates',()=>{
 const poly={id:'bt600',vendor:'poly',vendorId:0x047f,productId:0x02f7,model:'Plantronics BT600',connectionState:'connected',controlReady:true};
 const duplicate={...poly,id:'audio-only',vendor:'epos',connectionState:'audio-only',controlReady:false};
 assert.equal(findAudioControlDevice({name:'Plantronics BT600 (047f:02f7)'},[duplicate,poly]),poly);
 assert.equal(findAudioControlDevice({name:'Plantronics BT600'},[duplicate,poly]),poly);
 assert.equal(findAudioControlDevice({name:'Plantronics BT600 (047f:02f7)'},[poly,{...poly,id:'second-bt600'}]),null);
 assert.equal(findAudioControlDevice({name:'Unknown Poly headset'},[poly]),null);
 assert.equal(findAudioControlDevice({name:'Plantronics BT600 (047f:02f7)'},[duplicate]),null);
});

test('all control-ready vendors match audio without depending on EPOS SDK product IDs', () => {
  const models = [
    ['epos','Sennheiser SC230 USB CTRL II','1395:004d',null,'epos-websocket'],
    ['epos','Sennheiser BTD 800 USB for Lync','1395:002d','1000227','epos-websocket'],
    ['epos','Sennheiser SC230 USB CTRL II','1395:004d',42,'epos-websocket'],
    ['jabra','Jabra PRO 930','0b0e:1016',0x1016,'jabra-webhid'],
    ['poly','Plantronics BT600','047f:02f7',0x02f7,'poly-webhid'],
    ['epos','Uncatalogued Sennheiser headset','1395:1234',null,'epos-websocket'],
  ];
  for (const [vendor,model,usb,productId,transport] of models) {
    const device={vendor,model,productId,transport,id:model,connectionState:'connected',controlReady:true};
    assert.equal(findAudioControlDevice({name:`${model} (${usb})`},[device]),device,model);
  }
});
test('known conflicting USB identities and duplicate models never fall back to an arbitrary headset', () => {
  const device={vendor:'poly',model:'Plantronics BT600',productId:0x1234,transport:'poly-webhid',connectionState:'connected'};
  assert.equal(findAudioControlDevice({name:'Plantronics BT600 (047f:02f7)'},[device]),null);
  const epos={vendor:'epos',model:'Sennheiser SC230 USB CTRL II',transport:'epos-websocket',connectionState:'connected'};
  assert.equal(findAudioControlDevice({name:'Sennheiser SC230 USB CTRL II (1395:004d)'},[epos,{...epos,id:'second'}]),null);
  assert.equal(findAudioControlDevice({name:'Sennheiser SC230 USB CTRL II (047f:004d)'},[epos]),null);
});

async function selectionFixture(t) {
  const adapter=fakeAdapter('epos'), service=createHeadsetControlService({adapters:[adapter]});
  let current=true, clock=0;
  const selection=createAudioControlSelection({service,isCurrentAudio:()=>current,now:()=>clock});
  t.after(async()=>{selection.dispose();await service.dispose();}); await service.init();
  const device={id:'sc230',model:'Sennheiser SC230 USB CTRL II',transport:'epos-websocket'};
  const suggestion={name:'Sennheiser SC230 USB CTRL II (1395:004d)',inputId:'usb'};
  return {adapter,service,selection,device,suggestion,routeChanged(){current=false;},expire(){clock=21000;}};
}
test('audio selection waits for a late EPOS control inventory and selects it once', async t => {
  const f=await selectionFixture(t);
  assert.equal(await f.selection.select(f.suggestion),false);
  f.adapter.devices([f.device]); await tick(); await tick();
  assert.equal(f.service.getSnapshot().selectedKey,'epos:sc230');
  f.adapter.devices([f.device]); await tick();
  assert.equal(f.adapter.selected.filter(id=>id==='sc230').length,1);
});
test('pending audio/control match does not override a newer manual choice, changed audio or active call', async t => {
  for(const action of ['manual','route','call','expired','cancelled']) {
    const f=await selectionFixture(t);
    await f.selection.select(f.suggestion);
    if(action==='route')f.routeChanged();
    if(action==='expired')f.expire();
    if(action==='cancelled')f.selection.cancel();
    if(action==='call')await f.service.setSoftphoneState({callId:'active',active:true});
    if(action==='manual') {f.adapter.devices([{id:'other',model:'Other headset'}]);await f.service.selectDevice('epos:other');}
    f.adapter.devices([f.device,{id:'other',model:'Other headset'}]); await tick();await tick();
    assert.equal(f.adapter.selected.includes('sc230'),false,action);
  }
});
