import {createHash} from 'node:crypto';

// A renamed Electron executable still carries Electron's LC_UUID. macOS may
// then associate Local Network decisions with another Electron application.
// Give each app executable a reproducible identity before code signing. Shared
// frameworks retain their upstream UUID for crash symbolication (Apple TN3178).
export function scopeMachOUuid(source, identity) {
  const binary=Buffer.from(source);
  if(binary.length<32 || binary.readUInt32LE(0)!==0xfeedfacf)
    throw Error('Expected a single-architecture 64-bit Mach-O executable');
  const commands=binary.readUInt32LE(16),end=32+binary.readUInt32LE(20);
  if(end>binary.length)throw Error('Invalid Mach-O load command size');
  let offset=32,found=0;
  for(let i=0;i<commands;i++){
    if(offset+8>end)throw Error('Truncated Mach-O load command');
    const command=binary.readUInt32LE(offset),size=binary.readUInt32LE(offset+4);
    if(size<8 || offset+size>end)throw Error('Invalid Mach-O load command');
    if(command===0x1b){
      if(size!==24 || found++)throw Error('Invalid Mach-O UUID command');
      const uuid=createHash('sha256').update(identity).update(binary.subarray(offset+8,offset+24)).digest().subarray(0,16);
      uuid[6]=(uuid[6]&15)|0x50;uuid[8]=(uuid[8]&63)|0x80;
      uuid.copy(binary,offset+8);
    }
    offset+=size;
  }
  if(found!==1 || offset!==end)throw Error('Missing or invalid Mach-O UUID');
  return binary;
}
