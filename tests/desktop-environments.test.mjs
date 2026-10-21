import {test} from 'node:test';
import assert from 'node:assert/strict';
import environments from '../tools/contact-center-desktop/environments.cjs';
const {normalizeUrl,createEnvironmentStore,assertCanSwitch}=environments;
function memory(initial){let data=structuredClone(initial);return {read:()=>structuredClone(data),write:value=>{data=structuredClone(value);}};}

test('first launch has no hard-coded environment and normalizes a customer domain',()=>{
  const store=memory(null),manager=createEnvironmentStore(store);
  assert.deepEqual(manager.publicState(),{environments:[],defaultId:null,activeId:null});
  const id=manager.save({name:'Customer',url:' cc.customer.example/ '});
  assert.equal(manager.publicState().defaultId,id);
  assert.equal(manager.get(id).url,'https://cc.customer.example');
  assert.equal(manager.get(id).private.config.appUrl,'https://cc.customer.example');
  assert.ok(manager.get(id).partition.startsWith('persist:contact-center-'));
  assert.equal(createEnvironmentStore(store).getActive().id,id);
});
test('migration preserves the legacy browser partition, enrollment and recovery copies exactly once',()=>{
  const old={config:{appUrl:'http://localhost:3000',computerId:'old-computer',bridgeToken:'secret',allowedPhoneIds:['phone'],nativePhones:[{admin_password:'secret'}]},backups:{phone:{plan:{secret:'backup'}}}};
  const store=memory(old),manager=createEnvironmentStore(store,{appUrl:'https://ignored.example'});
  assert.equal(manager.getActive().name,'Dev');
  assert.equal(manager.getActive().partition,'persist:contact-center-desktop');
  assert.deepEqual(manager.scopedStore.read(),old);
  const publicData=JSON.stringify(manager.publicState());
  assert.ok(!publicData.includes('secret'));assert.ok(!publicData.includes('computerId'));
  assert.equal(createEnvironmentStore(store,{appUrl:'https://ignored.example'}).getActive().id,manager.getActive().id);
});
test('environment cookies, bridge credentials and recovery data never cross profiles',()=>{
  const manager=createEnvironmentStore(memory({config:{appUrl:'http://localhost:3000',bridgeToken:'dev-only'},backups:{phone:'dev-backup'}}));
  const dev=manager.getActive(),prod=manager.save({name:'Production',url:'https://cc.customer.example'});
  manager.activate(prod);
  assert.notEqual(manager.getActive().partition,dev.partition);
  assert.notEqual(manager.getActive().private.config.computerId,dev.private.config.computerId);
  assert.equal(manager.scopedStore.read().config.bridgeToken,undefined);
  manager.scopedStore.write({...manager.scopedStore.read(),backups:{phone:'prod-backup'}});
  manager.activate(dev.id);
  assert.equal(manager.scopedStore.read().config.bridgeToken,'dev-only');
  assert.deepEqual(manager.scopedStore.read().backups,{phone:'dev-backup'});
  const copy=manager.scopedStore.read();copy.config.bridgeToken='mutated';
  assert.equal(manager.scopedStore.read().config.bridgeToken,'dev-only');
});
test('startup default is independent of the current environment, renaming retains identity',()=>{
  const store=memory(null),manager=createEnvironmentStore(store);
  const a=manager.save({name:'A',url:'https://a.example'}),b=manager.save({name:'B',url:'https://b.example'});
  manager.activate(a);manager.setDefault(b);
  assert.equal(manager.publicState().activeId,a);
  assert.equal(createEnvironmentStore(store).getActive().id,b);
  const partition=manager.get(b).partition;
  manager.save({id:b,name:'New name',url:'https://b.example/'});
  assert.equal(manager.get(b).partition,partition);
  assert.throws(()=>manager.save({id:b,name:'B',url:'https://different.example'}),/Add a new/);
  assert.throws(()=>manager.save({name:'Duplicate',url:'https://a.example:443/'}),/already saved/);
  assert.throws(()=>manager.scopedStore.write({config:{appUrl:'https://b.example'}}),/cannot change/);
});
test('remove protects active enrollments and recovery copies; unused default gets a fallback',()=>{
  const manager=createEnvironmentStore(memory({config:{appUrl:'https://enrolled.example',allowedPhoneIds:['phone']}}));
  const enrolled=manager.getActive().id,a=manager.save({name:'A',url:'https://a.example'}),b=manager.save({name:'B',url:'https://b.example',makeDefault:true});
  assert.throws(()=>manager.remove(enrolled),/Switch to another/);
  manager.activate(a);
  assert.throws(()=>manager.remove(enrolled),/enrolled phones/);
  const partition=manager.get(b).partition;
  assert.equal(manager.remove(b),partition);
  assert.equal(manager.publicState().defaultId,enrolled);
});
test('URL validation rejects credentials, deep links, unsafe protocols and remote plaintext',()=>{
  for(const url of ['','http://cc.example','ftp://cc.example','javascript:alert(1)','https://user:pass@cc.example','https://cc.example/signin','https://cc.example?token=x','https://cc.example#token','file:///tmp/a'])
    assert.throws(()=>normalizeUrl(url),undefined,url);
  for(const url of ['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000','https://customer.example'])assert.equal(normalizeUrl(url),url);
});
test('switch is blocked for phone setup, sign-in and either WebRTC or deskphone calls',()=>{
  assert.doesNotThrow(()=>assertCanSwitch({phones:[{call:[]}]}));
  for(const value of [{setupBusy:true},{authBusy:true},{callBusy:true},{phones:[{call:[{state:'held'}]}]}])assert.throws(()=>assertCanSwitch(value));
});
