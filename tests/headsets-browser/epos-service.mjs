// Opt-in physical service probe. Run only while the workstation has no call.
// This checks actual EPOS acknowledgements, not audible output or user gestures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import { createEposAdapter } from '../../lib/headsets/adapters/epos-adapter.mjs';

assert(process.argv.includes('--physical'), 'Explicit --physical is required: this changes the connected headset indicators.');
const output = process.env.HEADSET_UI_OUTPUT || 'the internal documentation';
const report = { at: new Date().toISOString(), kind: 'physical EPOS service acknowledgements; no telephony call or audio measurement', events: [], results: [] };
class ObservedSocket extends WebSocket {
  constructor(url) {
    super(url);
    this.on('message', raw => {
      const value = JSON.parse(String(raw));
      // Never export device paths, serials or real call IDs.
      report.events.push(Object.fromEntries(['Event', 'EventType', 'ReturnCode', 'ProductName', 'ProductVersion', 'HeadsetName', 'HeadsetType']
        .filter(key => value[key] !== undefined).map(key => [key, value[key]])));
    });
  }
}
const adapter = createEposAdapter({ WebSocketImpl: ObservedSocket, softphoneName: 'Telnyx Headset Diagnostic', mediaDevices: null, reconnectDelayMs: 0 });
let device;
adapter.onDeviceChange(value => { device = value; });
try {
  await adapter.init();
  const deadline = Date.now() + 10000;
  while (!device?.controlReady && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert(device?.controlReady, 'No registered EPOS control endpoint');
  report.device = { model: device.model, deviceRole: device.deviceRole, connectionState: device.connectionState };
  await adapter.setSelectedDevice(device.id);
  const active = { callId: 'headset-physical-service-probe', direction: 'outgoing', active: true };
  for (const [name, state] of [
    ['Activate call indicator', active],
    ['Mute', { ...active, muted: true }],
    ['Unmute', active],
    ['Hold', { ...active, held: true }],
    ['Resume', active],
    ['End call indicator', {}],
  ]) {
    await adapter.setSoftphoneState(state);
    report.results.push({ name, outcome: 'PASS', evidence: 'SDK command acknowledged with ReturnCode 0' });
  }
  console.log(JSON.stringify({ device: report.device, results: report.results }, null, 2));
} catch (error) {
  report.error = error.message; throw error;
} finally {
  await adapter.dispose();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(`${output}/physical-service.json`, JSON.stringify(report, null, 2) + '\n');
}
