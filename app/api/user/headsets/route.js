import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { headsetPolicy } from "@/lib/headsets/policy.mjs";
export const dynamic = "force-dynamic";
export const GET = withPermission("authenticated", async (_request, _context, { user }) => {
  const result = await getPostgresPool().query("SELECT cc_settings FROM app_settings WHERE id='default'");
  return NextResponse.json(headsetPolicy(user, result.rows[0]?.cc_settings), { headers: { "Cache-Control": "no-store" } });
}, { route: "/api/user/headsets" });
