const {randomBytes,createHash} = require('node:crypto');
const {listenForAuth} = require('./auth-loopback.cjs');

async function signInWithBrowser({origin,session,openExternal,signal,onStatus = () => {}}) {
  const verifier = randomBytes(32).toString('base64url');
  const listener = await listenForAuth({signal});
  let flow, completed = false;
  const request = async (path,options = {},requestSignal = signal) => {
    const response = await session.fetch(`${origin}${path}`, {
      ...options,signal:AbortSignal.any([requestSignal,AbortSignal.timeout(20000)]),redirect:'error',
    });
    if (!response.ok) throw Error('Desktop sign-in could not be completed');
    return response.json();
  };
  const post = (body,requestSignal) => request('/api/auth/desktop/browser', {
    method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body),
  },requestSignal);
  try {
    flow = await post({action:'start',challenge:createHash('sha256').update(verifier).digest('base64url'),redirectUri:listener.redirectUri});
    const url = new URL(flow.url);
    if (!/^[a-f0-9]{48}$/.test(flow.id) ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) ||
        url.username || url.password || url.hash || url.pathname !== '/signin/desktop' ||
        url.searchParams.size !== 2 || url.searchParams.get('request') !== flow.id || url.searchParams.get('flow') !== 'browser') {
      throw Error('Invalid sign-in address');
    }
    signal.throwIfAborted();
    onStatus('browser');
    await openExternal(url.href);
    const authorizationCode = await listener.result;
    signal.throwIfAborted();
    onStatus('completing');
    const csrf = await request('/api/auth/csrf');
    if (!csrf.csrfToken) throw Error('Desktop session could not be created');
    const response = await request('/api/auth/callback/desktop', {
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:origin},
      body:new URLSearchParams({csrfToken:csrf.csrfToken,requestId:flow.id,verifier,authorizationCode,callbackUrl:'/signin/phone',json:'true'}).toString(),
    });
    if (!response.url || new URL(response.url,origin).searchParams.has('error')) throw Error('Desktop session could not be created');
    const signedIn = await request('/api/auth/session');
    if (!signedIn.user?.id) throw Error('Desktop session could not be verified');
    completed = true;
    return {ok:true};
  } finally {
    listener.close();
    if (flow?.id && !completed) {
      await post({action:'cancel',id:flow.id,verifier},AbortSignal.timeout(3000)).catch(() => {});
    }
  }
}
module.exports = {signInWithBrowser};
