import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { normalizeHeadsetSettings, parseHeadsetSettings } from "@/lib/headsets/policy.mjs";
export const dynamic = "force-dynamic";
export const GET = withPermission("system_settings:read", async () => {
  const result = await getPostgresPool().query("SELECT cc_settings FROM app_settings WHERE id='default'");
  return NextResponse.json(normalizeHeadsetSettings(result.rows[0]?.cc_settings?.headsets), { headers: { "Cache-Control": "no-store" } });
}, { route: "/api/admin/headsets" });
export const PUT = withPermission("system_settings:update", async (request, _context, { user }) => {
  let settings;
  try { settings = parseHeadsetSettings(await request.json()); }
  catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
  await getPostgresPool().query(`INSERT INTO app_settings(id,cc_settings,updated_by,updated_at)
    VALUES('default',jsonb_build_object('headsets',$1::jsonb),$2,now())
    ON CONFLICT(id) DO UPDATE SET cc_settings=COALESCE(app_settings.cc_settings,'{}'::jsonb)||jsonb_build_object('headsets',$1::jsonb),updated_by=$2,updated_at=now()`,
  [JSON.stringify(settings), user.username || String(user.id)]);
  return NextResponse.json(settings);
}, { route: "/api/admin/headsets" });
