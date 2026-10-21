import test from 'node:test';
import assert from 'node:assert/strict';
import {dialAudioCodes} from '../lib/hardphones/audiocodes-native-dial.mjs';
for(const model of ['420HD','440HD'])test(`${model} native dialing uses the observed case-sensitive HTTPS form`,async()=>{
 const calls=[],name=model==='420HD'?'dial.htm':'Dial.htm';
 const phone={model,admin_password:'private',certificate_fingerprint:'pinned'};
 const inspect=async(p,enrollment)=>{assert.equal(enrollment.certificate_fingerprint,'pinned');return {idle:true,registered:true,session:{send:async(path,opts)=>{calls.push({path,opts});return {raw:`<form name="DIAL" method="POST" action="${name}"><input name="number" value=""></form>`};}}};};
 assert.equal((await dialAudioCodes(phone,{number:'+48600000001',expiresAt:Date.now()+1000},{inspect})).ok,true);
 assert.equal(calls.length,2);assert.equal(calls[1].path,`/mainform.cgi/${name}`);
 assert.equal(new URLSearchParams(calls[1].opts.body).get('number'),'+48600000001');
});
test('native dialing cannot POST after expiry, on a busy phone, or to an unexpected form',async()=>{
 const phone={model:'420HD',admin_password:'private',certificate_fingerprint:'pinned'};let posts=0;
 for(const mode of ['expired','busy','wrong-action','new-incoming-call']){
 const inspect=async()=>({idle:mode!=='busy',registered:true,session:{send:async(_,opts)=>{if(opts)posts++;return {raw:`<form name="DIAL" method="POST" action="${mode==='wrong-action'?'reset.htm':'dial.htm'}"><input name="number"></form>`};}}});
 const result=await dialAudioCodes(phone,{number:'1005',expiresAt:mode==='expired'?0:Date.now()+1000,canDial:()=>mode!=='new-incoming-call'},{inspect});assert.equal(result.ok,false);assert.equal(result.definitive,true);
 }assert.equal(posts,0);
});
test('a lost POST response is ambiguous and must never cause automatic redial',async()=>{
 const result=await dialAudioCodes({model:'440HD',admin_password:'private',certificate_fingerprint:'pinned'}, {number:'1005',expiresAt:Date.now()+1000}, {inspect:async()=>({idle:true,registered:true,session:{send:async(_,opts)=>{if(opts)throw Error('connection_lost');return {raw:'<form name="DIAL" method="POST" action="Dial.htm"><input name="number"></form>'};}}})});
 assert.equal(result.ok,false);assert.equal(result.definitive,false);
});
