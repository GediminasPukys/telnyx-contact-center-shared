import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import { installHeadsetTransportProbe } from './transport-probe.mjs';
const output = process.env.HEADSET_UI_OUTPUT || 'the internal documentation';
await fs.mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:`import {createJabraAdapter} from './lib/headsets/adapters/jabra-adapter.mjs';
window.adapter=createJabraAdapter({partnerKey:'',logger:{write:e=>console.log(e.message)}}); window.devices=[]; window.commands=[];
adapter.onDevicesChange(d=>window.devices=d);adapter.onCommand(c=>window.commands.push(c));
window.ready=adapter.init();`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NEXT_PUBLIC_JABRA_PARTNER_KEY':'""','process.env.NEXT_PUBLIC_JABRA_APP_ID':'"cc-sdk-test"','process.env.NEXT_PUBLIC_JABRA_APP_NAME':'"Contact Center Test"'}});
const server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);}else res.end('<!doctype html><script src="/bundle.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await puppeteer.launch({headless:true}),page=await browser.newPage(),results=[],logs=[];
page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>logs.push('ERROR '+e.message));
const step=async(name,run)=>{await run();results.push({name,outcome:'PASS'});console.log('PASS',name);};
const state=async value=>page.evaluate(value=>adapter.setSoftphoneState(value),value);
const hardware=async action=>page.evaluate(async action=>{window.__headsetFixture.jabra(action);await new Promise(r=>setTimeout(r,35));},action);
const command=async type=>page.waitForFunction(type=>window.commands.some(c=>c.type===type),{},type);
try {
 await page.evaluateOnNewDocument(installHeadsetTransportProbe);await page.goto(`http://127.0.0.1:${server.address().port}`);
 await step('Real Jabra SDK loads without partner key and discovers WebHID call control',async()=>{
  await page.waitForFunction(()=>window.devices?.length===1); const devices=await page.evaluate(()=>window.devices);
  assert.equal(devices[0].transport,'jabra-webhid');assert(devices[0].controlReady);await page.evaluate(()=>adapter.setSelectedDevice(window.devices[0].id));
 });
 await step('Real SDK hardware answer, GUI mute/hold/resume and hardware hangup',async()=>{
  await state({callId:'c',ringing:true});await page.waitForFunction(()=>window.__headsetFixture.jabraReports.at(-1)?.bytes[0]&2);await hardware('answer');await command('answer');
  await state({callId:'c',active:true,muted:true});await state({callId:'c',active:true,held:true});await state({callId:'c',active:true});
  await hardware('hangup');await command('hangup');await state({});
 });
 await step('Real SDK outgoing call, hardware mute/unmute and hold/resume',async()=>{
  await page.evaluate(()=>window.commands=[]);await state({callId:'out',direction:'outgoing'});await state({callId:'out',active:true});
  await hardware('mute');await command('mute');await state({callId:'out',active:true,muted:true});
  await hardware('unmute');await page.waitForFunction(()=>window.commands.some(c=>c.type==='mute'&&c.muted===false));await state({callId:'out',active:true});
  await hardware('hold');await command('hold');await state({callId:'out',active:true,held:true});
  await hardware('resume');await page.waitForFunction(()=>window.commands.some(c=>c.type==='hold'&&c.held===false));await state({callId:'out',active:true});await state({});
 });
 await step('Real SDK hardware rejection and GUI answer/end do not repeat completed actions',async()=>{
  await page.evaluate(()=>window.commands=[]);await state({callId:'reject',ringing:true});await page.waitForFunction(()=>window.__headsetFixture.jabraReports.at(-1)?.bytes[0]&2);await hardware('reject');await command('reject');await state({});
  await state({callId:'gui',ringing:true});await state({callId:'gui',active:true});await state({});
 });
 await step('Real SDK ring test times out without rejecting an already rejected offer',async()=>{
  await page.evaluate(()=>adapter.sendTestCommand('ring'));
  assert.equal(await page.evaluate(()=>Boolean(window.__headsetFixture.jabraReports.at(-1)?.bytes[0]&2)),false);
 });
 await step('Real SDK USB disconnect tears down call control without a duplicate-teardown exception',async()=>{
  await page.evaluate(()=>window.__headsetFixture.jabraDisconnect());await page.waitForFunction(()=>window.devices.length===0);
  assert.deepEqual(logs.filter(line=>line.startsWith('ERROR ')),[]);
 });
} finally {
 await fs.writeFile(output+'/jabra-sdk.json',JSON.stringify({sdk:'4.4.6',transport:'actual SDK; simulated USB HID endpoint',results,logs},null,2)+'\n');
 await page.evaluate(()=>window.adapter?.dispose()).catch(()=>{});await browser.close();await new Promise(resolve=>server.close(resolve));
}
