import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import puppeteer from 'puppeteer';
const output=process.env.HEADSET_UI_OUTPUT || 'the internal documentation';await fs.mkdir(output,{recursive:true});
const bundle=await build({entryPoints:['tests/headsets-browser/entry.jsx'],bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':process.cwd()},define:{'process.env.NODE_ENV':'"test"'},banner:{js:'window.process={env:{NODE_ENV:"test"}};'},plugins:[{name:'headset-fixtures',setup(b){
 b.onResolve({filter:/client-headset-service$/},()=>({path:path.resolve('tests/headsets-browser/mock-client.mjs')}));
 b.onResolve({filter:/use-ui-text$/},()=>({path:'i18n',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const useUiText=()=>((text,args={})=>text.replace(/\\{(\\w+)\\}/g,(_,key)=>args[key]??key));',loader:'js'}));
}}]});
const buildDirectory=process.env.NEXT_DIST_DIR || '.next';
const cssFiles=(await fs.readdir(buildDirectory+'/static/chunks')).filter(f=>f.endsWith('.css'));
const css=(await Promise.all(cssFiles.map(f=>fs.readFile(buildDirectory+'/static/chunks/'+f,'utf8')))).join('\n');
// Serve only files enumerated from the fixture asset directories at startup.
const artwork = new Map();
for (const theme of ['light', 'dark']) {
 const directory = path.join('public/images/headsets', theme);
 for (const name of await fs.readdir(directory)) {
  if (/^[a-z0-9-]+\.webp$/.test(name)) artwork.set(`/images/headsets/${theme}/${name}`, await fs.readFile(path.join(directory, name)));
 }
}
const server=createServer(async(req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}else if(artwork.has(req.url)){res.setHeader('Content-Type','image/webp');res.end(artwork.get(req.url));}else res.end('<html><head><link rel="stylesheet" href="/style.css"></head><body style="background:var(--background)"><div id="root"></div><script src="/bundle.js"></script></body></html>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
if(process.argv.includes('--manual')){console.log(`Audio UI fixture: http://127.0.0.1:${server.address().port}`);await new Promise(()=>{});}
const browser=await puppeteer.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const page=await browser.newPage();page.setDefaultTimeout(15000);const errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));
const step=async(name,run)=>{await run();results.push({name,outcome:'PASS'});console.log('PASS',name);};
const settled=selector=>page.waitForFunction(selector=>{
 const panel=document.querySelector(selector);
 return panel&&Number(getComputedStyle(panel).opacity)>0.99&&panel.getAnimations({subtree:true}).every(a=>a.playState!=='running')&&[...panel.querySelectorAll('img')].filter(img=>getComputedStyle(img).display!=='none').every(img=>img.complete&&img.naturalWidth>0);
}, {},selector);
try{
 await page.setViewport({width:1280,height:900});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.testHeadsets?.service.getDevices().length===3);
 await step('compact panel anchored under trigger, with three device/audio selectors',async()=>{
  await page.click('[data-testid="headset-trigger"]');await page.waitForSelector('[data-testid="headset-quick-panel"]');await page.waitForFunction(()=>document.querySelectorAll('[data-testid="headset-quick-panel"] select').length===3);
  const rects=await page.evaluate(()=>{const a=document.querySelector('[data-testid="headset-trigger"]').getBoundingClientRect(),b=document.querySelector('[data-testid="headset-quick-panel"]').getBoundingClientRect();return {triggerBottom:a.bottom,panelTop:b.top,width:b.width};});assert(rects.panelTop>=rects.triggerBottom);assert(rects.width<=330);assert.equal(await page.$('[data-testid="headset-dialog"]'),null);
  await page.select('[aria-label="Control device"]','jabra:a');await page.select('[aria-label="Microphone"]','mic');await page.select('[aria-label="Speaker"]','speaker');
  await settled('[data-testid="headset-quick-panel"]');await page.screenshot({path:output+'/quick-panel.png'});
 });
 await step('gear opens advanced settings, Escape restores focus to headset icon',async()=>{
  await page.click('[data-testid="headset-settings"]');await page.waitForSelector('[data-testid="headset-dialog"]');await page.waitForSelector('[data-testid="headset-quick-panel"]',{hidden:true});
  await page.waitForSelector('[aria-label="Microphone"]');await settled('[data-testid="headset-dialog"]');await page.screenshot({path:output+'/advanced-panel.png'});
  await page.click('[role="tab"][data-state="active"]');await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent.includes('Control status'));
  assert.equal(await page.$eval('[role="tab"][data-state="active"]',el=>el.textContent),'Diagnostics');
  await page.keyboard.press('ArrowLeft');await page.waitForSelector('[aria-label="Microphone"]');
  assert.equal(await page.$eval('[role="tab"][data-state="active"]',el=>el.textContent),'Devices');
  await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});await page.waitForFunction(()=>document.activeElement.dataset.testid==='headset-trigger');
 });
 await step('missing hardware reports an error, then recovers to system defaults',async()=>{
  await page.click('[data-testid="headset-trigger"]'); await page.evaluate(()=>window.testHeadsets.audio.checkDevices([]));
  await page.waitForFunction(()=>document.querySelector('[data-testid="headset-quick-panel"]').textContent.includes('No microphone is available.'));
  await page.click('[data-testid="headset-settings"]');await page.waitForSelector('[data-testid="headset-dialog"]');
  assert((await page.$eval('[data-testid="headset-dialog"]',e=>e.textContent)).includes('No microphone is available.'));
  await page.evaluate(()=>window.testHeadsets.audio.checkDevices([{kind:'audioinput',deviceId:'mic'},{kind:'audiooutput',deviceId:'speaker'}]));
  await page.waitForFunction(()=>!document.querySelector('[data-testid="headset-dialog"]').textContent.includes('No microphone is available.'));
  await page.keyboard.press('Escape'); await page.click('[data-testid="headset-trigger"]');
  assert(!(await page.$eval('[data-testid="headset-quick-panel"]',e=>e.textContent)).includes('No microphone is available.'));
  await page.waitForSelector('[aria-label="Microphone"]');assert.equal(await page.$eval('[aria-label="Microphone"]',e=>e.value),'default'); assert.equal(await page.$eval('[aria-label="Speaker"]',e=>e.value),'default');await page.select('[aria-label="Microphone"]','mic');await page.select('[aria-label="Speaker"]','speaker');await page.keyboard.press('Escape');
 });
 for(const vendor of ['jabra','epos','poly'])await step(`${vendor} hardware ↔ shared call controller and selected-device state`,async()=>{
  const key=await page.evaluate(vendor=>window.testHeadsets.service.getDevices().find(d=>d.vendor===vendor).id,vendor);await page.evaluate(async key=>window.testHeadsets.service.selectDevice(key),vendor+':'+key);
  await page.evaluate(()=>window.testHeadsets.incoming());await page.waitForFunction(()=>window.testHeadsets.service.getSoftphoneState().ringing);
  await page.evaluate(vendor=>{const f=window.testHeadsets;if(vendor==='jabra')f.jabra.rings.at(-1)(true);else if(vendor==='epos')f.epos.receive({Event:'InCallAccepted',EventType:'Request'});else f.poly.input(1);},vendor);
  await page.waitForFunction(()=>window.testHeadsets.snapshot().status==='active');
  await page.evaluate(vendor=>{const f=window.testHeadsets;if(vendor==='jabra')f.jabra.control.muteState.emit('muted');else if(vendor==='epos')f.epos.receive({Event:'MuteSoftphone',EventType:'Request'});else f.poly.input(3);},vendor);
  await page.waitForFunction(()=>window.testHeadsets.snapshot().ui.isMuted);
  await page.evaluate(()=>window.testHeadsets.actions.setHeld(true));await page.waitForFunction(()=>window.testHeadsets.snapshot().headset.sync==='synced');
  const snapshot=await page.evaluate(()=>window.testHeadsets.snapshot());assert(snapshot.ui.isHeld);if(vendor==='poly')assert.equal(snapshot.reports.at(-1).bytes[0],13);if(vendor==='epos')assert(snapshot.epos.some(m=>m.Event==='CallHold'));if(vendor==='jabra')assert(snapshot.jabra.some(m=>m[0]==='hold'));
  await page.click('[data-testid="headset-trigger"]');assert.equal(await page.$eval('[aria-label="Control device"]',e=>e.disabled),true);await page.keyboard.press('Escape');
  await page.evaluate(()=>window.testHeadsets.end());await page.waitForFunction(()=>window.testHeadsets.snapshot().headset.sync==='synced');
 });
 await step('terminal call objects release both headset panels; a transfer still prevents switching',async()=>{
  await page.evaluate(()=>window.testHeadsets.incoming('retained-ended-call'));
  await page.click('[data-testid="headset-trigger"]');
  await page.waitForFunction(()=>document.querySelector('[aria-label="Control device"]').disabled);
  await page.evaluate(()=>{
   const active=window.testHeadsets.store;
   active.getState().call.state='destroy';
   active.setState({status:'ended',ui:{...active.getState().ui,isRinging:false}});
  });
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Control device"]').disabled);
  assert(!(await page.$eval('[data-testid="headset-quick-panel"]',e=>e.textContent)).includes('Finish the call'));
  await page.select('[aria-label="Control device"]','epos:epos-a');
  await page.click('[data-testid="headset-settings"]');
  await page.waitForSelector('[data-testid="headset-dialog"]');
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Ring indication')&&!b.disabled));
  assert(!(await page.$eval('[data-testid="headset-dialog"]',e=>e.textContent)).includes('Finish the call'));
  await page.evaluate(()=>window.testHeadsets.store.setState({consultInProgress:true}));
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Ring indication')&&b.disabled));
  await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});await page.click('[data-testid="headset-trigger"]');
  assert.equal(await page.$eval('[aria-label="Control device"]',e=>e.disabled),true);
  await page.evaluate(()=>{window.testHeadsets.store.setState({consultInProgress:false});window.testHeadsets.end();});
  await page.keyboard.press('Escape');
 });
 for(const theme of ['light','dark']) await step(`${theme} compact and advanced panels display matching SC230 artwork`,async()=>{
  await page.evaluate(async theme=>{document.documentElement.classList.toggle('dark',theme==='dark');await window.testHeadsets.service.selectDevice('epos:epos-a');},theme);
  await page.click('[data-testid="headset-trigger"]');await page.waitForSelector('[data-testid="headset-quick-panel"]');
  await page.waitForFunction(theme=>[...document.querySelectorAll('[data-testid="headset-quick-panel"] [data-headset-artwork="epos-sc230-usb-ctrl-ii"] img')].some(img=>getComputedStyle(img).display!=='none'&&img.complete&&img.naturalWidth>0&&img.src.includes('/'+theme+'/')),{},theme);
  await page.waitForSelector('[aria-label="Microphone"]');await settled('[data-testid="headset-quick-panel"]');await page.screenshot({path:output+`/quick-panel-${theme}.png`});
  await page.click('[data-testid="headset-settings"]');await page.waitForSelector('[data-testid="headset-dialog"]');
  await page.waitForSelector('[aria-label="Microphone"]');await settled('[data-testid="headset-dialog"]');
  assert.equal(await page.$$eval('[data-testid="headset-dialog"] [data-headset-artwork="epos-sc230-usb-ctrl-ii"]',els=>els.length),1);
  await page.screenshot({path:output+`/advanced-panel-${theme}.png`});await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});
 });
 for(const theme of ['light','dark']) await step(`${theme} PRO 930 artwork loads in compact and advanced panels`,async()=>{
  await page.evaluate(async theme=>{document.documentElement.classList.toggle('dark',theme==='dark');await window.testHeadsets.service.selectDevice('jabra:a');},theme);
  await page.click('[data-testid="headset-trigger"]');await settled('[data-testid="headset-quick-panel"]');
  const artwork='[data-headset-artwork="jabra-pro-930-mono"]';
  assert.equal(await page.$$eval('[data-testid="headset-quick-panel"] '+artwork,els=>els.length),1);
  assert.equal(await page.$eval('[aria-label="Control device"]',el=>el.selectedOptions[0].textContent),'Jabra PRO 930');
  await page.screenshot({path:output+`/pro930-quick-${theme}.png`});
  await page.click('[data-testid="headset-settings"]');await settled('[data-testid="headset-dialog"]');
  assert.equal(await page.$$eval('[data-testid="headset-dialog"] '+artwork,els=>els.length),1);
  const images=await page.$$eval('[data-testid="headset-dialog"] '+artwork+' img',els=>els.filter(el=>getComputedStyle(el).display!=='none').map(el=>({src:el.src,width:el.naturalWidth})));
  assert(images.every(img=>img.width===320&&img.src.includes('/'+theme+'/')));
  await page.screenshot({path:output+`/pro930-advanced-${theme}.png`});
  await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});
 });
 await step('BTD 800 is selectable; explicit MB Pro 2 artwork persists without changing audio or endpoint identity',async()=>{
  const discover=async()=>page.evaluate(async()=>{
   window.testHeadsets.epos.receive({Event:'HeadsetConnected',EventType:'Notification',HeadsetPath:'Sennheiser BTD 800 USB for Lync',HeadsetName:'Sennheiser BTD 800 USB for Lync',HeadsetType:'Sennheiser BTD 800 USB for Lync'});
  });
  await discover();await page.click('[data-testid="headset-trigger"]');
  await page.select('[aria-label="Control device"]','epos:Sennheiser BTD 800 USB for Lync');
  await page.click('[data-testid="headset-settings"]');await page.waitForSelector('[aria-label="Paired headset model"]');
  assert.equal(await page.$eval('[aria-label="Paired headset model"]',el=>el.value),'');
  await page.select('[aria-label="Paired headset model"]','epos-mb-pro-2');
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
   await settled('[data-testid="headset-dialog"]');
   assert.equal(await page.$$eval('[data-testid="headset-dialog"] [data-headset-artwork="epos-mb-pro-2"]',els=>els.length),1);
   assert((await page.$eval('[data-testid="headset-dialog"]',el=>el.textContent)).includes('via Sennheiser BTD 800 USB for Lync'));
   await page.screenshot({path:output+`/mb-pro-2-advanced-${theme}.png`});
   await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});await page.click('[data-testid="headset-trigger"]');await settled('[data-testid="headset-quick-panel"]');
   assert.equal(await page.$eval('[data-testid="headset-quick-panel"] [data-headset-artwork]',el=>el.dataset.headsetArtwork),'epos-mb-pro-2');
   await page.screenshot({path:output+`/mb-pro-2-quick-${theme}.png`});await page.click('[data-testid="headset-settings"]');
  }
  const snapshot=await page.evaluate(()=>({device:window.testHeadsets.service.getDevice(),audio:window.testHeadsets.audio.getSnapshot()}));
  assert.equal(snapshot.device.model,'Sennheiser BTD 800 USB for Lync');assert.equal(snapshot.audio.inputId,'mic');assert.equal(snapshot.audio.outputId,'speaker');
  await page.reload();await page.waitForFunction(()=>window.testHeadsets?.service.getDevices().length===3);await discover();
  await page.evaluate(()=>window.testHeadsets.service.selectDevice('epos:Sennheiser BTD 800 USB for Lync'));
  await page.click('[data-testid="headset-trigger"]');await page.click('[data-testid="headset-settings"]');
  await page.waitForSelector('[aria-label="Paired headset model"]');assert.equal(await page.$eval('[aria-label="Paired headset model"]',el=>el.value),'epos-mb-pro-2');
  await page.select('[aria-label="Paired headset model"]','');await settled('[data-testid="headset-dialog"]');
  assert.equal(await page.$$eval('[data-testid="headset-dialog"] [data-headset-artwork="epos-btd-800-usb"]',els=>els.length),1);
  await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});
 });
 await step('captured BT600 supports call impulses and paired Focus UC artwork with truthful sensor capabilities',async()=>{
  const descriptor=JSON.parse(await fs.readFile('tests/fixtures/poly-bt600-02f7.json','utf8'));
  await page.evaluate(async descriptor=>{
   const f=window.testHeadsets;
   f.poly.hidEvents.disconnect({device:f.poly.device});
   Object.assign(f.poly.device,descriptor);
   f.poly.hidEvents.connect({device:f.poly.device});
   await f.service.selectDevice('poly:'+f.service.getDevices().find(device=>device.vendor==='poly').id);
  },descriptor);
  await page.click('[data-testid="headset-trigger"]');
  await settled('[data-testid="headset-quick-panel"]');
  assert.equal(await page.$eval('[data-testid="headset-quick-panel"] [data-headset-artwork]',el=>el.dataset.headsetArtwork),'poly-bt600-usb-a');
  await page.click('[data-testid="headset-settings"]');
  await page.waitForSelector('[aria-label="Paired headset model"]');
  await page.select('[aria-label="Paired headset model"]','poly-voyager-focus-uc');
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.classList.toggle('dark',theme==='dark'),theme);
   await settled('[data-testid="headset-dialog"]');
   const text=await page.$eval('[data-testid="headset-dialog"]',el=>el.textContent);
   assert(!text.includes('automatic hold and custom sensor actions are unavailable'));
   assert(!text.includes('Hold ✓'));
   assert(!text.includes('press the Call button twice to hold an active call'));
   assert.equal(await page.$$eval('[data-testid="headset-dialog"] [data-headset-artwork="poly-voyager-focus-uc"]',els=>els.length),1);
   await page.screenshot({path:output+`/focus-uc-advanced-${theme}.png`});
   await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});
   await page.click('[data-testid="headset-trigger"]');await settled('[data-testid="headset-quick-panel"]');
   assert.equal(await page.$eval('[data-testid="headset-quick-panel"] [data-headset-artwork]',el=>el.dataset.headsetArtwork),'poly-voyager-focus-uc');
   await page.screenshot({path:output+`/focus-uc-quick-${theme}.png`});
   await page.click('[data-testid="headset-settings"]');
  }
  await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});
  await page.evaluate(()=>window.testHeadsets.incoming('bt600-call'));
  await page.waitForFunction(()=>window.testHeadsets.service.getSoftphoneState().ringing);
  await page.evaluate(()=>{window.testHeadsets.poly.input([1,0],21);window.testHeadsets.poly.input([0,0],21);});
  await page.waitForFunction(()=>window.testHeadsets.snapshot().status==='active'&&window.testHeadsets.snapshot().headset.sync==='synced');
  for(const muted of [true,false,true,false]){
   await page.evaluate(()=>{window.testHeadsets.poly.input(3);window.testHeadsets.poly.input(1);});
   await page.waitForFunction(muted=>window.testHeadsets.snapshot().ui.isMuted===muted&&window.testHeadsets.snapshot().headset.sync==='synced',{},muted);
  }
  for(const held of [true,false,true,false]){
   await page.evaluate(()=>{window.testHeadsets.poly.input([4,0],21);window.testHeadsets.poly.input([0,0],21);});
   await page.waitForFunction(held=>window.testHeadsets.snapshot().ui.isHeld===held&&window.testHeadsets.snapshot().headset.sync==='synced',{},held);
   assert.equal((await page.evaluate(()=>window.testHeadsets.snapshot())).ui.isMuted,false);
  }
  await page.evaluate(()=>{window.testHeadsets.poly.input([1,0],21);window.testHeadsets.poly.input([0,0],21);});
  await page.waitForFunction(()=>window.testHeadsets.snapshot().status==='idle');
 });
 await step('EPOS connection loss exposes setup guidance until call controls reconnect',async()=>{
  await page.click('[data-testid="headset-trigger"]');await page.click('[data-testid="headset-settings"]');
  const hint='For EPOS / Sennheiser, start EPOS Connect on this computer.';
  await settled('[data-testid="headset-dialog"]');
  assert(!(await page.$eval('[data-testid="headset-dialog"]',el=>el.textContent)).includes(hint));
  await page.evaluate(()=>window.testHeadsets.epos.socket.close());
  await page.waitForFunction(hint=>document.querySelector('[data-testid="headset-dialog"]').textContent.includes(hint),{},hint);
  await page.screenshot({path:output+'/epos-connect-guidance.png'});
  await page.evaluate(()=>{window.testHeadsets.epos.login();window.testHeadsets.epos.discover();});
  await page.waitForFunction(hint=>!document.querySelector('[data-testid="headset-dialog"]').textContent.includes(hint),{},hint);
  await page.click('[data-testid="headset-dialog"] [aria-label="Close"]');await page.waitForSelector('[data-testid="headset-dialog"]',{hidden:true});
 });
 await step('responsive quick panel fits a narrow viewport',async()=>{await page.setViewport({width:390,height:844});await page.click('[data-testid="headset-trigger"]');const rect=await page.$eval('[data-testid="headset-quick-panel"]',e=>({left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}));assert(rect.left>=0&&rect.right<=390);await page.waitForFunction(()=>document.querySelector('[data-testid="headset-quick-panel"]').getAnimations({subtree:true}).every(a=>a.playState!=='running'));await page.screenshot({path:output+'/quick-panel-mobile.png'});});
 assert.deepEqual(errors,[]);await fs.writeFile(output+'/browser-tests.json',JSON.stringify({at:new Date().toISOString(),browser:await browser.version(),results,errors},null,2));
}catch(error){await page.screenshot({path:output+'/ui-failure.png'});await fs.writeFile(output+'/ui-failure.html',await page.content());throw error;}finally{await browser.close();await new Promise(r=>server.close(r));}
