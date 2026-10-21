import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeSipFrames, encodeSip, header, setHeader, responseCode, cseq } from './protocol.mjs';
import { SipPhoneSession } from './session.mjs';
import { anchorPhoneRoute, removeLocalRoute } from './routing.mjs';

// Opt-in LAN signaling controller. Dedicated TCP flows to Telnyx preserve SIP
// digest authentication. The command endpoint is a user-only Unix socket, never
// a LAN/web listener. The app's existing endpoint-token/lease checks precede it.
export async function startSipController({ pool, getPhones, host, port=5070, unixControl=true, originate, onEvent=()=>{} }) {
  if(!net.isIPv4(host)||!Object.values(os.networkInterfaces()).flat().some(i=>i?.address===host)) throw Error('sip_controller_requires_local_ipv4');
  const sessions=new Map(), connections=new Set();let inventory=new Map(), refreshing=false;
  async function refresh() {
    if(refreshing)return;refreshing=true;
    try {
      const rows=getPhones ? await getPhones() : (await pool.query(`SELECT p.id,p.ip_address,p.sip_username,p.settings,a.number AS extension
        FROM hp_phones p LEFT JOIN cc_phone_stations s ON s.phone_id=p.id
        LEFT JOIN cc_extension_assignments a ON a.station_id=s.id
        WHERE p.vendor='audiocodes' AND p.model IN ('420HD','440HD') AND p.provisioning_state<>'disabled'
        AND p.settings->>'cti_mode'='sip_controller'`)).rows;
      inventory=new Map(rows.filter(p=>net.isIPv4(p.ip_address)).map(p=>[p.ip_address,p]));
      for(const [id,session] of sessions) {
        const current=rows.find(p=>p.id===id&&p.ip_address===session.phone.ip_address);
        if(!current)session.disconnect();else session.phone=current;
      }
    } finally {refreshing=false;}
  }
  await refresh();
  const timer=setInterval(()=>refresh().catch(()=>{}),5000);timer.unref();
  const server=net.createServer(phoneSocket=>{
    const phone=inventory.get(phoneSocket.remoteAddress);
    if(!phone||sessions.has(phone.id)) {onEvent({name:'flow_rejected',phoneId:phone?.id,reason:phone?'existing_flow':'unknown_phone'});phoneSocket.destroy();return;}
    const upstream=net.createConnection({host:'sip.telnyx.com',port:5060});
    for(const socket of [phoneSocket,upstream]){socket.setNoDelay(true);socket.setKeepAlive(true,15000);connections.add(socket);}
    let stopped=false;
    const write=(socket,m)=>{ if(socket.destroyed)throw Error('sip_flow_closed');if(socket.writableLength>524288)throw Error('sip_backpressure');socket.write(encodeSip(m)); };
    const originalVias=new Map();let registeredContact="";
    const transaction=m=>`${header(m,"via").match(/;branch=([^;\s]+)/)?.[1]}:${cseq(m).method}`;
    const session=new SipPhoneSession({phone,host,port,onEvent,originate,
      toPhone:m=>{
        if(responseCode(m)) {
          const original=originalVias.get(transaction(m));if(original)setHeader(m,'Via',original);
          if(cseq(m).method==='REGISTER'&&registeredContact) {
            const contact=header(m,'contact');if(contact)setHeader(m,'Contact',contact.replace(/<[^>]+>/,registeredContact.match(/<[^>]+>/)?.[0] || contact));
          }
        }
        write(phoneSocket,anchorPhoneRoute(m,host,port));
      },toProvider:m=>{
        // A NAT-aware Telnyx registrar retains this authenticated TCP flow.
        // Make the proxy the advertised transport address, retaining user/tags.
        const via=header(m,'via');if(via&&!responseCode(m)) {
          const key=transaction(m);originalVias.set(key,via);setTimeout(()=>originalVias.delete(key),32000).unref?.();
          setHeader(m,'Via',via.replace(/^(SIP\/2.0\/TCP)\s+[^;\s]+/,`$1 ${host}:${port}`));
        }
        const contact=header(m,'contact');if(cseq(m).method==='REGISTER'&&!responseCode(m)&&contact)registeredContact=contact;
        if(contact&&contact!=='*')setHeader(m,'Contact',contact.replace(/(sips?:[^@<>\s]+@)[^;>\s]+/,`$1${host}:${port}`));
        removeLocalRoute(m,host,port);
        write(upstream,m);
      }});
    const stop=()=>{if(stopped)return;stopped=true;session.close();sessions.delete(phone.id);for(const s of [phoneSocket,upstream]){connections.delete(s);s.destroy();}onEvent({name:'flow_closed',phoneId:phone.id});};
    session.disconnect=stop;sessions.set(phone.id,session);
    for(const [side,socket] of [['phone',phoneSocket],['provider',upstream]]) {
      let buffer=Buffer.alloc(0);
      socket.on('data',chunk=>{
        try {
          buffer=Buffer.concat([buffer,chunk]);const parsed=decodeSipFrames(buffer);buffer=parsed.buffer;
          for(const message of parsed.messages) {
            if(side==='phone'&&message.start.startsWith('REGISTER ') && !header(message,'to').includes(`sip:${phone.sip_username}@`)) throw Error('sip_identity_mismatch');
            session.observe(side,message);
          }
        } catch(error) {onEvent({name:'flow_error',phoneId:phone.id,reason:error.message});stop();}
      });
      socket.on('error',error=>{onEvent({name:'flow_transport_error',phoneId:phone.id,side,reason:error.code});stop();});socket.on('close',()=>{if(!stopped)onEvent({name:'flow_peer_closed',phoneId:phone.id,side});stop();});
    }
    onEvent({name:'flow_opened',phoneId:phone.id});
  });
  const command=async({phoneId,action,callRef,digits,number,intentId,expiresAt})=>{
    const session=sessions.get(phoneId);
    if(!session)throw Error('phone_sip_controller_offline');
    return session.control(action,{callRef,digits,number,intentId,expiresAt});
  };
  const directory=unixControl ? await fs.mkdtemp(path.join(os.tmpdir(),'cc-phone-cti-')) : null;
  if(directory)await fs.chmod(directory,0o700);
  const socketPath=directory ? path.join(directory,'control.sock') : null;
  const control=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    try {
      if(req.method!=='POST'||req.url!=='/control')throw Error('invalid_controller_request');
      let text='';for await(const part of req){text+=part;if(text.length>4096)throw Error('controller_body_too_large');}
      const result=await command(JSON.parse(text));res.end(JSON.stringify(result));
    } catch(error) {res.statusCode=409;res.end(JSON.stringify({ok:false,reason:error.message}));}
  });
  control.requestTimeout=15000;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
    if(unixControl){
      await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(socketPath,resolve);});
      await fs.chmod(socketPath,0o600);
    }
  } catch(error) {clearInterval(timer);server.close();control.close();if(directory)await fs.rm(directory,{recursive:true,force:true});throw error;}
  return {socketPath, sessions, command, refresh, async stop(){
    clearInterval(timer);for(const s of sessions.values())s.disconnect();for(const s of connections)s.destroy();
    await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>control.close(r))]);
    if(directory)await fs.rm(directory,{recursive:true,force:true});
  }};
}
