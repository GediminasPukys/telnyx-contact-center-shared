import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { createBrowserAuth, bindBrowserAuth, completeBrowserAuth, cancelBrowserAuth } from '@/lib/desktop-browser-auth.mjs';

const headers = { 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer' };
const reply = (body, status = 200) => NextResponse.json(body, { status, headers });
const cookieName = id => `cc-desktop-${id}`;
const cookieOptions = secure => ({ httpOnly:true, secure, sameSite:'lax', path:'/', maxAge:300 });

export async function POST(request) {
  const canonical = new URL(process.env.NEXTAUTH_URL || request.url).origin;
  const origin = request.headers.get('origin');
  let trusted = false;
  try {
    const url = new URL(origin);
    trusted = url.origin === canonical || (url.host === request.headers.get('host') &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))));
  } catch {}
  if (!trusted) return reply({error:'Invalid request origin'},403);
  try {
    const body = await request.json(), pool = getPostgresPool();
    if (body.action === 'start') {
      const flow = await createBrowserAuth(pool,body.challenge,body.redirectUri);
      return reply({...flow,url:`${canonical}/signin/desktop?flow=browser&request=${flow.id}`});
    }
    if (body.action === 'begin') {
      const binding = await bindBrowserAuth(pool,body.id);
      if (!binding) return reply({error:'Sign-in expired. Start again in the desktop app.'},409);
      const response = reply({ok:true});
      const options = cookieOptions(canonical.startsWith('https:'));
      response.cookies.set(cookieName(body.id),binding,options);
      response.cookies.set('cc-desktop-active',body.id,options);
      return response;
    }
    if (body.action === 'cancel') {
      await cancelBrowserAuth(pool,body.id,body.verifier);
      return reply({ok:true});
    }
    return reply({error:'Invalid desktop request'},400);
  } catch { return reply({error:'Desktop sign-in could not be completed. Try again.'},400); }
}

export async function GET(request) {
  const url = new URL(request.url), id = url.searchParams.get('request');
  const binding = request.cookies.get(cookieName(id))?.value;
  const failed = url.searchParams.has('error');
  const token = failed ? null : await getToken({req:request,secret:process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET});
  const redirect = await completeBrowserAuth(getPostgresPool(), {
    id,binding,error:failed,userId:token?.id,provider:token?.authProvider,authenticatedAt:token?.authenticatedAt,
  });
  if (!redirect) return reply({error:'Sign-in expired or could not be verified. Start again in the desktop app.'},409);
  const response = NextResponse.redirect(redirect, {status:303,headers});
  const options = {...cookieOptions(new URL(process.env.NEXTAUTH_URL || request.url).protocol === 'https:'),maxAge:0};
  response.cookies.set(cookieName(id),'',options);
  if (request.cookies.get('cc-desktop-active')?.value === id) response.cookies.set('cc-desktop-active','',options);
  return response;
}
