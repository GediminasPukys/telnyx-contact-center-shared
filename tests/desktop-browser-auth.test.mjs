import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {prepareAcdTestPool} from './helpers/acd-test-db.mjs';
import * as auth from '../lib/desktop-browser-auth.mjs';
import {consumeDesktopAuth,pollDesktopAuth} from '../lib/desktop-auth.mjs';
import {listenForAuth} from '../tools/contact-center-desktop/auth-loopback.cjs';
import {signInWithBrowser} from '../tools/contact-center-desktop/auth-flow.cjs';
const secret=()=>randomBytes(32).toString('base64url');
const hash=value=>createHash('sha256').update(value).digest('base64url');
const redirect=()=>`http://127.0.0.1:49152/callback/${secret()}`;
const pool=await prepareAcdTestPool('cc_test_desktop_browser_auth');
await pool.query("INSERT INTO users(id,username,active) VALUES('desktop-user','desktop-test@example.test',true),('disabled-user','disabled@example.test',false)");
test.after(()=>pool.end());
async function start(){const verifier=secret(),flow=await auth.createBrowserAuth(pool,hash(verifier),redirect());return {...flow,verifier,binding:await auth.bindBrowserAuth(pool,flow.id)};}
const finish=(flow,extra={})=>auth.completeBrowserAuth(pool,{...flow,userId:'desktop-user',provider:'google',authenticatedAt:Date.now()+1,...extra});

test('only literal loopback callbacks with an ephemeral port and random state are accepted',async()=>{
 const valid=redirect();assert.equal(auth.validDesktopRedirect(valid),true);
 for(const value of [valid.replace('127.0.0.1','localhost'),valid.replace('127.0.0.1','10.0.0.5'),valid.replace('127.0.0.1','2130706433'),valid.replace(':49152',':80'),valid+'?next=https://evil.test',valid+'#fragment',valid.replace('http:','https:'),'file:///callback/test','http://127.0.0.1:49152/callback/short',valid.replace('127.0.0.1','user@127.0.0.1')]){
  assert.equal(auth.validDesktopRedirect(value),false,value);await assert.rejects(auth.createBrowserAuth(pool,secret(),value));
 }
});
test('native grant requires fresh Google login, correct browser cookie and active user',async()=>{
 const flow=await start();
 assert.equal(await auth.bindBrowserAuth(pool,flow.id),null);
 for(const extra of [{binding:secret()},{provider:'credentials'},{authenticatedAt:Date.now()-60000},{userId:'disabled-user'},{userId:'missing'}])assert.equal(await finish(flow,extra),null);
 const callback=await finish(flow);assert.ok(callback);
 const code=new URL(callback).searchParams.get('code');
 assert.equal(await finish(flow),null,'browser completion cannot be replayed');
 assert.equal(await auth.consumeBrowserAuth(pool,flow.id,secret(),code),null);
 assert.equal(await auth.consumeBrowserAuth(pool,flow.id,flow.verifier,secret()),null);
 assert.equal(await consumeDesktopAuth(pool,flow.id,flow.verifier),null,'legacy exchange cannot redeem a browser grant without its code');
 assert.deepEqual(await pollDesktopAuth(pool,flow.id,flow.verifier),{expired:true},'polling never discloses the browser grant');
 const outcomes=await Promise.all(Array.from({length:6},()=>consumeDesktopAuth(pool,flow.id,flow.verifier,code)));
 assert.equal(outcomes.filter(Boolean).length,1);assert.equal(outcomes.find(Boolean),'desktop-user');
});
test('expiration, cancellation, mismatched flow and disabled-after-approval reject redemption',async()=>{
 for(const scenario of ['expired','cancelled','disabled','mismatch']){
  const flow=await start(),callback=await finish(flow),code=new URL(callback).searchParams.get('code');
  if(scenario==='expired')await pool.query("UPDATE cc_desktop_browser_auth SET expires_at=now()-interval '1 second' WHERE id=$1",[flow.id]);
  if(scenario==='cancelled')await auth.cancelBrowserAuth(pool,flow.id,flow.verifier);
  if(scenario==='disabled')await pool.query("UPDATE users SET active=false WHERE id='desktop-user'");
  assert.equal(await auth.consumeBrowserAuth(pool,scenario==='mismatch'?(await start()).id:flow.id,flow.verifier,code),null);
  await pool.query("UPDATE users SET active=true WHERE id='desktop-user'");
 }
 const flow=await start();await auth.cancelBrowserAuth(pool,flow.id,secret());assert.equal(await auth.inspectBrowserAuth(pool,flow.id),true);
 const callback=await finish(flow,{error:true});assert.equal(new URL(callback).searchParams.get('error'),'cancelled');
 assert.equal(await auth.inspectBrowserAuth(pool,flow.id),false);assert.equal(await finish(flow),null);
});
test('real loopback listener rejects wrong state, host, verb and duplicate callbacks',async()=>{
 const controller=new AbortController(),listener=await listenForAuth({signal:controller.signal}),code=secret();
 try{
  for(const [url,options] of [[listener.redirectUri.replace(/.$/,'!')+'?code='+code,{}],[listener.redirectUri+'?code='+code,{method:'POST'}],[listener.redirectUri+'?code='+code+'&code='+code,{}]])assert.equal((await fetch(url,options)).status,400);
  const wrongHost = await new Promise(resolve => { const req=http.get(listener.redirectUri+'?code='+code,{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',()=>resolve(0)); });
  assert.equal(wrongHost,400);
  assert.equal((await fetch(listener.redirectUri+'?code='+code)).status,200);assert.equal(await listener.result,code);
  assert.equal((await fetch(listener.redirectUri+'?code='+code)).status,400);
 }finally{listener.close();}
 await assert.rejects(fetch(listener.redirectUri));
});
test('loopback cancellation and deadline close the listening socket',async()=>{
 for(const reason of [Object.assign(Error('cancel'),{code:'CANCELLED'}),new DOMException('expired','TimeoutError')]){
  const controller=new AbortController(),listener=await listenForAuth({signal:controller.signal});controller.abort(reason);
  await assert.rejects(listener.result,error=>error===reason);await assert.rejects(fetch(listener.redirectUri));
 }
});
test('native flow delivers a real loopback grant to the original environment, then verifies the session',async()=>{
 const origin='https://tenant.example.test',statuses=[];let flow,redirectUri,redeemed=false;
 const session={fetch:async(url,options)=>{
  assert.equal(new URL(url).origin,origin);assert.equal(options.redirect,'error');
  const path=new URL(url).pathname;
  if(path==='/api/auth/desktop/browser'){
   const body=JSON.parse(options.body);
   if(body.action==='start'){redirectUri=body.redirectUri;flow=await auth.createBrowserAuth(pool,body.challenge,redirectUri);return Response.json({...flow,url:`https://oauth.example.test/signin/desktop?flow=browser&request=${flow.id}`});}
   throw Error('Unexpected cancellation');
  }
  if(path==='/api/auth/csrf')return Response.json({csrfToken:'csrf'});
  if(path==='/api/auth/callback/desktop'){
   const body=new URLSearchParams(options.body);assert.equal(body.get('callbackUrl'),'/signin/phone');assert.equal(body.get('csrfToken'),'csrf');
   assert.equal(await consumeDesktopAuth(pool,body.get('requestId'),body.get('verifier'),body.get('authorizationCode')),'desktop-user');redeemed=true;
   return Response.json({url:origin+'/signin/phone'});
  }
  assert.equal(path,'/api/auth/session');assert.equal(redeemed,true);return Response.json({user:{id:'desktop-user'}});
 }};
 const result=await signInWithBrowser({origin,session,signal:AbortSignal.timeout(5000),onStatus:s=>statuses.push(s),openExternal:async url=>{
  assert.equal(new URL(url).searchParams.has('code'),false);
  const binding=await auth.bindBrowserAuth(pool,flow.id),callback=await finish({...flow,binding});
  assert.equal((await fetch(callback)).status,200);
 }});
 assert.deepEqual(result,{ok:true});assert.deepEqual(statuses,['browser','completing']);await assert.rejects(fetch(redirectUri));
});
test('browser launch failure cancels server request and closes the listener; non-web launch is rejected',async()=>{
 for(const launchFailure of [true,false]){
  let flow,redirectUri,cancelled=false;
  const session={fetch:async(_url,options)=>{
   const body=JSON.parse(options.body);
   if(body.action==='start'){redirectUri=body.redirectUri;flow=await auth.createBrowserAuth(pool,body.challenge,redirectUri);return Response.json({...flow,url:launchFailure?`https://cc.test/signin/desktop?flow=browser&request=${flow.id}`:'file:///etc/passwd'});}
   assert.equal(body.action,'cancel');await auth.cancelBrowserAuth(pool,body.id,body.verifier);cancelled=true;return Response.json({ok:true});
  }};
  await assert.rejects(signInWithBrowser({origin:'https://cc.test',session,signal:AbortSignal.timeout(5000),openExternal:async()=>{throw Error('No default browser');}}),launchFailure?/No default browser/:/Invalid sign-in address/);
  assert.equal(cancelled,true);assert.equal(await auth.inspectBrowserAuth(pool,flow.id),false);await assert.rejects(fetch(redirectUri));
 }
});

test('actual browser API handlers bind HttpOnly cookies, enforce Origin and redirect only after fresh OAuth',async()=>{
 const {loadRoute}=await import('./helpers/route-harness.mjs');
 const {NextRequest,NextResponse}=await import('next/server.js');
 let token=null;
 const route=await loadRoute('app/api/auth/desktop/browser/route.js',{
  env:{NEXTAUTH_URL:'https://cc.example.test'},'next/server':{NextResponse},
  'next-auth/jwt':{getToken:async()=>token},'@/lib/postgres.mjs':{getPostgresPool:()=>pool},'@/lib/desktop-browser-auth.mjs':auth,
 });
 const post=(body,origin='https://cc.example.test')=>route.POST(new NextRequest('https://cc.example.test/api/auth/desktop/browser',{method:'POST',headers:{Origin:origin,Host:'cc.example.test','Content-Type':'application/json'},body:JSON.stringify(body)}));
 const verifier=secret(),body={action:'start',challenge:hash(verifier),redirectUri:redirect()};
 assert.equal((await post(body,'https://evil.test')).status,403);assert.equal((await post({...body,redirectUri:'http://192.168.1.1:5000/'})).status,400);
 const flow=await(await post(body)).json();assert.equal(new URL(flow.url).origin,'https://cc.example.test');
 const bound=await post({action:'begin',id:flow.id});assert.equal(bound.status,200);
 const cookie=bound.cookies.get(`cc-desktop-${flow.id}`);assert.ok(cookie.httpOnly);assert.ok(cookie.secure);assert.equal(cookie.sameSite,'lax');
 const finishUrl=`https://cc.example.test/api/auth/desktop/browser?request=${flow.id}`;
 const get=cookieHeader=>route.GET(new NextRequest(finishUrl,{headers:cookieHeader?{cookie:cookieHeader}:{}}));
 assert.equal((await get()).status,409);
 token={id:'desktop-user',authProvider:'google',authenticatedAt:Date.now()+1};
 assert.equal((await get(`cc-desktop-${flow.id}=${secret()}`)).status,409);
 const completion=await get(`cc-desktop-${flow.id}=${cookie.value}; cc-desktop-active=${flow.id}`);
 assert.equal(completion.status,303);assert.equal(completion.headers.get('referrer-policy'),'no-referrer');
 const callback=new URL(completion.headers.get('location'));assert.equal(callback.origin,new URL(body.redirectUri).origin);
 assert.equal(await consumeDesktopAuth(pool,flow.id,verifier,callback.searchParams.get('code')),'desktop-user');
 assert.equal(completion.cookies.get('cc-desktop-active').maxAge,0);
});

test('native flow rejects missing CSRF, failed exchange and absent session, then cleans up',async()=>{
 for(const failure of ['csrf','exchange','session']){
  let redirectUri,cancelled=false;const id='a'.repeat(48);
  const session={fetch:async(url,options)=>{
   const path=new URL(url).pathname;
   if(path==='/api/auth/desktop/browser'){
    const body=JSON.parse(options.body);if(body.action==='cancel'){cancelled=true;return Response.json({ok:true});}
    redirectUri=body.redirectUri;return Response.json({id,url:`https://cc.test/signin/desktop?flow=browser&request=${id}`});
   }
   if(path==='/api/auth/csrf')return Response.json(failure==='csrf'?{}:{csrfToken:'csrf'});
   if(path==='/api/auth/callback/desktop')return Response.json({url:failure==='exchange'?'https://cc.test/signin?error=CredentialsSignin':'https://cc.test/signin/phone'});
   assert.equal(path,'/api/auth/session');return Response.json({});
  }};
  await assert.rejects(signInWithBrowser({origin:'https://cc.test',session,signal:AbortSignal.timeout(5000),openExternal:()=>fetch(redirectUri+'?code='+secret())}),/Desktop session could not/);
  assert.equal(cancelled,true);await assert.rejects(fetch(redirectUri));
 }
});
