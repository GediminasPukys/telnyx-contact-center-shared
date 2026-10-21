import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, registryPhones, validateCommand } from '../tools/contact-center-desktop/policy.mjs';
const config={appUrl:'https://cc.example.com',relayUrl:'wss://cc.example.com/hardphone-bridge',
  bridgeId:'test',bridgeToken:'a'.repeat(64),sipHost:'192.168.1.2',sipPort:5070,allowedPhoneIds:['420']};
const phone={phone_id:'420',ip:'192.168.1.10',vendor:'audiocodes',model:'420HD',sip_username:'phone1',cti_mode:'desktop_bridge',extension:'1002'};
test('desktop rejects cleartext remote servers and credentials embedded in URLs',()=>{
  assert.equal(validateConfig(config),config);
  assert.throws(()=>validateConfig({...config,appUrl:'http://cc.example.com'}),/https/);
  assert.throws(()=>validateConfig({...config,relayUrl:'ws://cc.example.com'}),/wss/);
  assert.throws(()=>validateConfig({...config,relayUrl:'wss://cc.example.com/?token=secret'}),/credentials/);
  assert.doesNotThrow(()=>validateConfig({...config,appUrl:'http://localhost:3130',relayUrl:'ws://127.0.0.1:3131'}));
});
test('registry can only grant supported models from the local allowlist',()=>{
  const rows=registryPhones([phone,{...phone,phone_id:'other'},{...phone,model:'450HD'},{...phone,cti_mode:'telnyx'}],['420']);
  assert.equal(rows.length,1);assert.equal(rows[0].id,'420');
});
test('cloud commands cannot change the target host or run arbitrary phone requests',()=>{
  const phones=registryPhones([phone],['420']);
  const command={phone_id:'420',host:phone.ip,vendor:'audiocodes',action:'hold',payload:{callRef:'call-1'}};
  assert.equal(validateCommand(command,phones).phoneId,'420');
  assert.throws(()=>validateCommand({...command,host:'192.168.1.1'},phones),/authorized/);
  assert.throws(()=>validateCommand({...command,phone_id:'other'},phones),/authorized/);
  assert.throws(()=>validateCommand({...command,action:'reboot'},phones),/unsupported/);
  assert.throws(()=>validateCommand({...command,payload:{}},phones),/reference/);
});
