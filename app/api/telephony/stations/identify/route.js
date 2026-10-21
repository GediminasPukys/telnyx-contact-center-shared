import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { identifyStation } from "@/lib/telephony/station-control.mjs";
export const POST=withPermission("agent:self",async(request,_c,{user})=>{
  try{return NextResponse.json(await identifyStation(getPostgresPool(),user,await request.json()));}
  catch(error){return NextResponse.json({error:error.status?error.message:"Phone identification failed"},{status:error.status||500});}
},{route:"/api/telephony/stations/identify"});
