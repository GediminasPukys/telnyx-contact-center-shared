import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { stationInventory, readLoginChoice, claimStation, releaseStation } from "@/lib/telephony/stations.mjs";
const options = { route:"/api/telephony/stations" };
const json = body => NextResponse.json(body,{headers:{"Cache-Control":"no-store"}});
const voicePermissions=["agent:self","calls:supervise.listen","calls:supervise.whisper","calls:supervise.barge"];
export const GET = withPermission("authenticated",async (_r,_c,authz) => {
  const pool = getPostgresPool();
  const policy=(await pool.query("SELECT enabled FROM cc_agent_channel_policies WHERE agent_id=$1 AND channel='voice'",[String(authz.user.id)])).rows[0];
  const canVoice = authz.can(voicePermissions) && policy?.enabled !== false;
  const stations=canVoice ? await stationInventory(pool,authz.user) : [];
  return json({choice:await readLoginChoice(pool,authz.user),stations:stations.filter(s=>s.kind==="webrtc"||authz.can("agent:self")),canVoice});
},options);
export const POST = withPermission("authenticated",async (request,_c,authz) => {
  const body = await request.json();
  if (body.kind !== "none" && !authz.can(voicePermissions)) return NextResponse.json({error:"Voice is not enabled for this account"},{status:403});
  if(body.kind!=="none" && !authz.can("agent:self")) {
    const station=(await getPostgresPool().query("SELECT kind FROM cc_phone_stations WHERE id=$1",[body.stationId])).rows[0];
    if(station?.kind!=="webrtc")return NextResponse.json({error:"Agent access is required for physical stations"},{status:403});
  }
  return json(await claimStation(getPostgresPool(),authz.user,body));
},options);
export const DELETE = withPermission("authenticated",async (request,_c,{user}) => json(await releaseStation(getPostgresPool(),user,await request.json())),options);
