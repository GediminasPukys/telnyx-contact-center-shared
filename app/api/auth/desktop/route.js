import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../[...nextauth]/route';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { createDesktopAuth, approveDesktopAuth, pollDesktopAuth } from '@/lib/desktop-auth.mjs';
const reply=(data,status=200)=>NextResponse.json(data,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request) {
  // Native requests also send Origin. Approval must never be cross-site.
  const origin=request.headers.get('origin');
  const canonical=new URL(process.env.NEXTAUTH_URL || request.url).origin;
  let sameOrigin=false;
  try { const u=new URL(origin);sameOrigin=u.origin===canonical || (u.host===request.headers.get('host') && (u.protocol==='https:' || (u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))); } catch {}
  if(!sameOrigin)return reply({error:'Invalid request origin'},403);
  try {
    const body=await request.json(), pool=getPostgresPool();
    if(body.action==='start') {
      const flow=await createDesktopAuth(pool,body.challenge);
      return reply({...flow,url:`${canonical}/signin/desktop?request=${flow.id}`});
    }
    if(body.action==='poll')return reply(await pollDesktopAuth(pool,body.id,body.verifier));
    if(body.action==='approve') {
      const session=await getServerSession(authOptions);
      if(!session?.user?.id)return reply({error:'Sign in first'},401);
      return await approveDesktopAuth(pool,body.id,session.user.id)?reply({ok:true}):reply({error:'This sign-in request expired or was already used. Start again in the desktop app.'},409);
    }
    return reply({error:'Invalid desktop request'},400);
  } catch { return reply({error:'Desktop sign-in could not be completed. Try again.'},400); }
}
