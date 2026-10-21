import { dialAudioCodes } from '../../lib/hardphones/audiocodes-native-dial.mjs';
import { startNativeController } from './native-controller.mjs';
import WebSocket from 'ws';
import { startSipController } from '../../lib/hardphones/sip-controller/server.mjs';
import { validateConfig, registryPhones, validateCommand } from './policy.mjs';

// This process receives only a bridge-scoped token, never the CC database or
// Telnyx API credentials. The remote renderer has no IPC access to it.
let controller, nativeController, socket, reconnect, heartbeat, reporting, config, phones=[], registry=[], stopping=false, starting=false;
const results=new Map();
const post=value=>process.parentPort.postMessage(value);
const send=value=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(value));};
function status() {
  post({type:'status',relay:socket?.readyState===WebSocket.OPEN?'connected':'offline',
    listener:controller?`${config.sipHost}:${config.sipPort}`:null,
    phones:phones.map(p=>({id:p.id,vendor:p.vendor,model:p.model,extension:p.extension,ip:p.ip_address,
      ...(p.vendor==='audiocodes'?controller?.sessions.get(p.id)?.snapshot():nativeController?.snapshot(p.id))}))});
}
async function command(message) {
  const id=message.command_id;
  if(typeof id!=='string'||id.length>128)return;
  // Coalesce retries; an expired/disconnected result is never replayed later.
  if(results.has(id))return send(await results.get(id));
  const pending=(async()=>{
    try {const args=validateCommand(message,phones);const phone=phones.find(p=>p.id===args.phoneId);const result=await (phone.vendor==='audiocodes'?controller:nativeController).command(args);
      return {type:'command_result',command_id:id,ok:true,result};}
    catch(error){return {type:'command_result',command_id:id,ok:false,result:{ok:false,reason:error.message},error:error.message};}
  })();
  results.set(id,pending);
  if(results.size>256)results.delete(results.keys().next().value);
  const result=await pending;send(result);status();
}
function connect() {
  if(stopping)return;
  const url=new URL(config.relayUrl);url.searchParams.set('bridge_id',config.bridgeId);
  socket=new WebSocket(url,{headers:{Authorization:`Bearer ${config.bridgeToken}`},maxPayload:262144,handshakeTimeout:10000});
  socket.on('open',()=>{
    send({type:'hello',site:'Contact Center Desktop',capabilities:{sip_cti:true,native_cti:true,models:['420HD','440HD','VVX 300','T22P'],media:'direct',prototype:true}});
    send({type:'phone_registry_request'});status();
  });
  socket.on('message',async raw=>{
    try {
      const message=JSON.parse(String(raw));
      if(message.type==='phone_registry'){
        registry=message.phones||[];
        phones=registryPhones(registry,config.allowedPhoneIds,config.nativePhones);
        await controller.refresh();await nativeController?.refresh();status();
      } else if(message.type==='command')await command(message);
      else if(message.type==='error')post({type:'error',error:'bridge_authentication_failed'});
    }catch(error){post({type:'error',error:error.message});}
  });
  socket.on('error',()=>post({type:'error',error:'bridge_connection_failed'}));
  socket.on('close',()=>{
    // SIP flows stay alive during transient cloud loss; no offline control queue.
    status();if(!stopping)reconnect=setTimeout(connect,3000);
  });
}
async function stop() {
  stopping=true;clearTimeout(reconnect);clearInterval(heartbeat);clearInterval(reporting);
  socket?.terminate();await controller?.stop();await nativeController?.stop();process.exit(0);
}
process.parentPort.on('message',async({data})=>{
  if(data.type==='stop')return stop();
  if(data.type==='update'){
    try{
      const next=validateConfig(data.config);
      if(['sipHost','sipPort','eventPort','bridgeId','bridgeToken','relayUrl'].some(k=>next[k]!==config[k]))throw Error('Bridge network changed; restart required');
      config=next;phones=registryPhones(registry,config.allowedPhoneIds,config.nativePhones);
      await controller.refresh();await nativeController?.refresh();
      send({type:'phone_registry_request'});status();post({type:'updated',id:data.id});
    }catch(error){post({type:'updated',id:data.id,error:error.message});}
    return;
  }
  if(data.type!=='start'||starting)return;starting=true;
  try {
    config=validateConfig(data.config);
    controller=await startSipController({getPhones:async()=>phones.filter(p=>p.vendor==='audiocodes'),host:config.sipHost,port:config.sipPort,unixControl:false,originate:dialAudioCodes,
      onEvent:event=>post({type:'event',event})});
    if(config.nativePhones?.length)nativeController=await startNativeController({getPhones:async()=>phones.filter(p=>p.vendor!=='audiocodes'),host:config.sipHost,port:config.eventPort,onEvent:event=>post({type:'event',event})});
    connect();
    heartbeat=setInterval(()=>{send({type:'heartbeat'});send({type:'phone_registry_request'});},15000);
    reporting=setInterval(status,1000);
  }catch(error){post({type:'error',error:error.message});await stop();}
});
