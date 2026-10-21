const http = require('node:http');
const {randomBytes} = require('node:crypto');
const {renderAuthResultPage, contentSecurityPolicy} = require('./auth-result-page.cjs');

// Shared by macOS and Windows. Never listen on the LAN. The random path is
// state; the one-use grant still requires the native PKCE proof to redeem.
async function listenForAuth({signal}) {
  const path = `/callback/${randomBytes(32).toString('base64url')}`;
  let resolve, reject, settled = false;
  const result = new Promise((yes,no) => {resolve=yes;reject=no;});
  result.catch(() => {});
  const server = http.createServer((request,response) => {
    const host = `127.0.0.1:${server.address()?.port}`;
    let url;
    try { url = new URL(request.url,'http://127.0.0.1'); }
    catch { response.writeHead(400);response.end();return; }
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Content-Security-Policy',contentSecurityPolicy);
    const code = url.searchParams.get('code'), error = url.searchParams.get('error');
    if (settled || request.method !== 'GET' || request.headers.host !== host || url.pathname !== path ||
        url.origin !== 'http://127.0.0.1' ||
        !(url.searchParams.size === 1 && (/^[A-Za-z0-9_-]{43}$/.test(code || '') || error === 'cancelled'))) {
      response.writeHead(400);response.end('Invalid sign-in callback.');return;
    }
    settled = true;
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    response.end(renderAuthResultPage({cancelled:!!error}));
    if (error) reject(Object.assign(Error('Sign-in cancelled'),{code:'CANCELLED'}));
    else resolve(code);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const close = () => {server.close();server.closeAllConnections();signal.removeEventListener('abort',abort);};
  const abort = () => {settled=true;reject(signal.reason);close();};
  await new Promise((yes,no) => {server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const redirectUri = `http://127.0.0.1:${server.address().port}${path}`;
  signal.addEventListener('abort',abort,{once:true});
  if (signal.aborted) abort();
  return {redirectUri,result,close};
}
module.exports = {listenForAuth};
