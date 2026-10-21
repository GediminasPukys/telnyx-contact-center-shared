import test from 'node:test';import assert from 'node:assert/strict';
import {scopeMachOUuid} from '../tools/contact-center-desktop/mac-identity.mjs';
const executable=()=>{const b=Buffer.alloc(64);b.writeUInt32LE(0xfeedfacf);b.writeUInt32LE(1,16);b.writeUInt32LE(24,20);b.writeUInt32LE(0x1b,32);b.writeUInt32LE(24,36);b.fill(7,40,56);b.fill(9,56);return b;};
test('packaged executable identities are reproducible and distinct from Electron and each other',()=>{
 const original=executable(),a=scopeMachOUuid(original,'app'),b=scopeMachOUuid(original,'helper');
 assert.deepEqual(a,scopeMachOUuid(original,'app'));assert.notDeepEqual(a,b);assert.notDeepEqual(a,original);
 assert.deepEqual(a.subarray(0,40),original.subarray(0,40));assert.deepEqual(a.subarray(56),original.subarray(56));
 assert.deepEqual(original,executable());
});
test('identity patch rejects unsupported binaries and malformed command tables',()=>{
 assert.throws(()=>scopeMachOUuid(Buffer.alloc(2),'app'));
 for(const [offset,value] of [[0,0xcafebabe],[16,2],[20,9999],[32,0],[36,8],[36,999]]){
  const b=executable();b.writeUInt32LE(value,offset);assert.throws(()=>scopeMachOUuid(b,'app'));
 }
});
