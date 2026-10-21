import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeadsetDiagnostics } from '../lib/headsets/diagnostics.mjs';
import { describePolyReports } from '../lib/headsets/adapters/poly-adapter.mjs';
import { polyFixture } from './helpers/headset-fixtures.mjs';
test('Export preserves unsupported Poly descriptor evidence without device, call or audio identifiers',()=>{
 const f=polyFixture();f.device.collections[0].outputReports[0].items[0].usages.push(0xff000001);f.device.collections[0].outputReports[0].items[0].reportCount++;
 const layout=describePolyReports(f.device.collections);
 const device={vendor:'poly',model:'Test model',id:'sensitive-device',serialNumber:'sensitive-serial',reports:{inputs:layout.inputs,outputs:layout.outputs,excluded:layout.excludedReports},capabilities:layout.capabilities};
 const report=createHeadsetDiagnostics({devices:[device],device:null,audio:{inputId:'sensitive-mic',outputId:'sensitive-speaker'},diagnostics:[{message:'Headset state synchronized',callId:'sensitive-call',raw:'sensitive-payload'}]}, {webHid:true,privateField:'sensitive-env'});
 assert.equal(report.devices[0].reports.outputs.length,0);assert(report.devices[0].reports.excluded.outputs[0].items[0].usages.includes(0xff000001));
 assert(!JSON.stringify(report).includes('sensitive-'));assert.equal(report.environment.webHid,true);
});
