import React from 'react';
import { createRoot } from 'react-dom/client';
import { HeadsetStatusBadge } from '../../components/headsets/HeadsetStatusBadge';
import { initialize, simulateAudioConnection, simulateTransientAudio, simulateNewHeadset, simulateActiveCall, endSimulatedCall } from './mock-client.mjs';
createRoot(document.getElementById('root')).render(<>
  <div className="m-8 max-w-md space-y-4"><h1 className="text-lg font-semibold">Audio device test fixture</h1><p>Simulated device inventory; no hardware or calls are controlled.</p><div className="flex gap-4"><button onClick={()=>simulateAudioConnection(false)}>Disconnect test headset</button><button onClick={()=>simulateAudioConnection(true)}>Connect test headset</button></div></div>
  <div className="m-8 flex max-w-md flex-wrap gap-4"><button onClick={simulateTransientAudio}>Transient audio interfaces</button><button onClick={simulateNewHeadset}>Connect new test headset</button><button onClick={simulateActiveCall}>Start simulated call</button><button onClick={endSimulatedCall}>End simulated call</button></div>
  <div className="fixed right-4 top-4 flex items-center gap-3 rounded-full border bg-background px-4 py-2"><span className="text-sm">WebRTC</span><HeadsetStatusBadge/></div>
</>);
void initialize();
