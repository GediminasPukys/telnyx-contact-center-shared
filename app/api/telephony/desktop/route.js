import { NextResponse } from 'next/server';
import { withPermission } from '@/lib/authz/guard';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { enrollDesktop, prepareDesktopPhone, finishDesktopPhone } from '@/lib/telephony/desktop-enrollment.mjs';

export const POST=withPermission('agent:self',async(request,_context,authz)=>{
  if(authz.user.experimental_features!==true)return NextResponse.json({error:'Desktop phones are not enabled for this account'},{status:403});
  const pool=getPostgresPool();
  const disabled=await pool.query("SELECT 1 FROM cc_agent_channel_policies WHERE agent_id=$1 AND channel='voice' AND enabled=false",[String(authz.user.id)]);
  if(disabled.rowCount)return NextResponse.json({error:'Voice is disabled for this account'},{status:403});
  try {
    const body=await request.json();
    const result=body.action==='enroll'?await enrollDesktop(pool,authz.user,body)
      :body.action==='prepare'?await prepareDesktopPhone(pool,authz.user,body,{admin:authz.can('phones:update')})
      :body.action==='finish'?await finishDesktopPhone(pool,authz.user,body):null;
    return NextResponse.json(result || {error:'Invalid desktop action'},{status:result?200:400,headers:{'Cache-Control':'no-store'}});
  }catch(error){return NextResponse.json({error:error.status?error.message:'Desktop setup failed. Check server configuration and try again.'},{status:error.status || 500,headers:{'Cache-Control':'no-store'}});}
},{route:'/api/telephony/desktop'});
