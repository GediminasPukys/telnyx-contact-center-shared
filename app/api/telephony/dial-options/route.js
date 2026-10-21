import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { lookupExtension, outboundIdentities } from "@/lib/telephony/dialing.mjs";
import { authenticateVoiceEndpoint } from "@/lib/acd/voice-endpoints.mjs";

export const GET = withPermission("agent:self", async (request, _context, { user }) => {
  try {
    const db = getPostgresPool();
    const extension = new URL(request.url).searchParams.get("extension");
    if (extension !== null) {
      const entry = await lookupExtension(db, extension);
      return NextResponse.json({ extension: entry.number, type: entry.target_type, label: entry.name });
    }
    const identities = await outboundIdentities(db, String(user.id));
    const selected = (await db.query(`SELECT e.outbound_identity FROM cc_agent_voice_preferences p
      JOIN cc_voice_endpoints e ON e.id=p.endpoint_id
      WHERE p.agent_id=$1 AND e.auth_session_id=$2 AND e.revoked_at IS NULL`, [String(user.id),user.authSessionId || null])).rows[0]?.outbound_identity;
    return NextResponse.json({ identities, selectedIdentity: identities.some(item=>item.id===selected) ? selected : "personal" });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Could not load call options." }, { status: error.status || 500 });
  }
}, { route: "/api/telephony/dial-options" });

export const POST = withPermission("agent:self", async (request, _context, { user }) => {
  try {
    const db = getPostgresPool();
    const endpoint = await authenticateVoiceEndpoint(db, user, request.headers.get("x-cc-endpoint-token"));
    const { identity } = await request.json();
    const identities = await outboundIdentities(db, String(user.id));
    if (!identities.some(item => item.id === identity)) return NextResponse.json({ error: "Calling identity unavailable" }, { status: 403 });
    await db.query("UPDATE cc_voice_endpoints SET outbound_identity=$2 WHERE id=$1 AND revoked_at IS NULL", [endpoint.id, identity]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error.status ? error.message : "Could not save calling identity." }, { status: error.status || 500 });
  }
}, { voiceControl: true, route: "/api/telephony/dial-options" });
