import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { stationInventory, saveStation, releaseStation } from "@/lib/telephony/stations.mjs";
const options = { route:"/api/admin/stations" };
const json = body => NextResponse.json(body,{headers:{"Cache-Control":"no-store"}});
export const GET = withPermission("extensions:read",async (_r,_c,{user}) => json({stations:await stationInventory(getPostgresPool(),user,{admin:true})}),options);
export const POST = withPermission(["extensions:create","extensions:update","extensions:release"],async (request,_c,authz) => {
  const body = await request.json();
  if (!authz.can(body.action === "release" ? "extensions:release" : body.id ? "extensions:update" : "extensions:create")) return NextResponse.json({error:"Forbidden"},{status:403});
  return json(body.action === "release" ? await releaseStation(getPostgresPool(),authz.user,body,{admin:true}) : await saveStation(getPostgresPool(),authz.user,body));
},options);
