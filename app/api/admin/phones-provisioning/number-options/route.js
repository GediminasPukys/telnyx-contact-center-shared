import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { ownedVoiceNumbers } from "@/lib/telephony/dialing.mjs";
export const GET = withPermission(["phones:create", "phones:update"], async (request, _context, authz) => {
  if (authz.user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const params = new URL(request.url).searchParams;
    return NextResponse.json(await ownedVoiceNumbers({ query: params.get("q") || "", page: params.get("page") }));
  } catch (error) { return NextResponse.json({ error: error.message }, { status: error.status || 502 }); }
}, { route: "/api/admin/phones-provisioning/number-options" });
