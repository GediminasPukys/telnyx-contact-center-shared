import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { extensionDirectory, extensionChoices, saveExtensionPool, deleteExtensionPool, assignExtension, syncStationInventory, ensureWebStation } from "@/lib/telephony/extensions.mjs";

const options = { route: "/api/admin/extensions" };
const json = value => NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
export const GET = withPermission("extensions:read", async request => {
  const db = getPostgresPool();
  const q = new URL(request.url).searchParams;
  if (q.has("targetId")) return json(await extensionChoices(db,q.get("type"),q.get("targetId"),q.get("search")||""));
  return json(await extensionDirectory(db,{type:q.get("type")||null,search:q.get("search")||""}));
},options);
export const POST = withPermission(["extensions:create","extensions:update","extensions:assign"], async (request,_ctx,authz) => {
  const db = getPostgresPool(), body = await request.json();
  if (body.action === "sync") {
    if (!authz.can("extensions:create")) return NextResponse.json({ error:"Forbidden" },{status:403});
    await syncStationInventory(db);
    const users=(await db.query("SELECT id,username,first_name FROM users WHERE active=true")).rows;
    for (const user of users) await ensureWebStation(db,user);
    return json({ok:true});
  }
  if (body.action === "assign") {
    if (!authz.can("extensions:assign")) return NextResponse.json({error:"Forbidden"},{status:403});
    return json(await assignExtension(db,String(authz.user.id),body));
  }
  if (!authz.can(body.id ? "extensions:update" : "extensions:create")) return NextResponse.json({error:"Forbidden"},{status:403});
  return json(await saveExtensionPool(db,String(authz.user.id),body));
},options);
export const DELETE = withPermission("extensions:delete", async (request,_ctx,{user}) =>
  json(await deleteExtensionPool(getPostgresPool(),String(user.id),new URL(request.url).searchParams.get("id"))),options);
