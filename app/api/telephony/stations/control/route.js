import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { authenticateVoiceEndpoint } from "@/lib/acd/voice-endpoints.mjs";
import { controlStation } from "@/lib/telephony/station-control.mjs";
export const POST=withPermission("agent:self",async(request,_c,{user})=>{
  try{
    const body=await request.json(),pool=getPostgresPool();
    const endpoint=await authenticateVoiceEndpoint(pool,user,request.headers.get("x-cc-endpoint-token"));
    return NextResponse.json(await controlStation(pool,user,endpoint,body.action,body));
  }catch(error){return NextResponse.json({error:error.status?error.message:"Phone control failed"},{status:error.status||500});}
},{route:"/api/telephony/stations/control",voiceControl:true});
