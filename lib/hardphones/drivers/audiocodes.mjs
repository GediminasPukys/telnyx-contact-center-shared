import http from 'node:http';
function command(phone,action,params={}) {
  const socketPath=process.env.HARDPHONE_SIP_CONTROLLER_SOCKET;
  if(!socketPath)return Promise.resolve({ok:false,reason:'phone_sip_controller_offline'});
  return new Promise(resolve=>{
    const body=JSON.stringify({phoneId:phone.id,action,callRef:params.callRef,digits:params.digits,number:params.number,intentId:params.intentId,expiresAt:params.expiresAt});
    const req=http.request({socketPath,path:'/control',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:12000},res=>{
      let data='';res.on('data',p=>{data+=p;if(data.length>65536)req.destroy();});res.on('end',()=>{try{resolve(JSON.parse(data));}catch{resolve({ok:false,reason:'invalid_controller_response'});}});
    });
    req.on('timeout',()=>req.destroy());req.on('error',()=>resolve({ok:false,reason:'phone_sip_controller_offline'}));req.end(body);
  });
}
export const audioCodesDriver={
  status:phone=>command(phone,'status'),answer:(phone,p)=>command(phone,'answer',p),hangup:(phone,p)=>command(phone,'hangup',p),
  hold:(phone,p)=>command(phone,'hold',p),resume:(phone,p)=>command(phone,'resume',p),mute:(phone,value,p)=>command(phone,value?'mute':'unmute',p),
  dial:(phone,number,p)=>command(phone,'dial',{...p,number}),sendDtmf:(phone,digits,p)=>command(phone,'send_dtmf',{...p,digits}),
  reprovision:async()=>({ok:false,reason:'use_https_provisioning'}),reboot:async()=>({ok:false,reason:'reboot_not_supported'}),
};
