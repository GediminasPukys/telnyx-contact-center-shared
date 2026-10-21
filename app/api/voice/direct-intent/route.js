import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { authorizePersistedInteractionControl } from "@/lib/voice/interaction-control-policy.mjs";
import { cancelUnstartedDirectIntent, reserveDirectVoice, reserveCoreTarget } from "@/lib/acd/direct-capacity.mjs";
import { withPermission } from "@/lib/authz/guard";
import { resolveDialTarget, resolveOutboundIdentity } from "@/lib/telephony/dialing.mjs";
import { authenticateVoiceEndpoint } from "@/lib/acd/voice-endpoints.mjs";
import { driveSaga } from "@/lib/acd/saga-engine.mjs";
import { createTelnyxProvider } from "@/lib/acd/provider.mjs";
import { controlStation, stationPhone } from "@/lib/telephony/station-control.mjs";
import { nativeDialTarget } from "@/lib/hardphones/native-dial-target.mjs";
import { nativePhoneState } from "@/lib/telephony/native-phone-state.mjs";
import { createDiagnosticLogger } from "@/lib/diagnostic-logger.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const logger = createDiagnosticLogger("contact-center.direct-intent");

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const body = await request.json();
    let dialContext = null;
    if (!body.sourceInteractionId) {
      const target = await resolveDialTarget(pool, body.target, {callerId:String(user.id)});
      const identity = await resolveOutboundIdentity(pool,String(user.id),body.outboundIdentity || "personal",{internal:target.internal});
      dialContext = {target,identity};
      if (request.headers.get("x-cc-endpoint-token")) {
        const endpoint = await authenticateVoiceEndpoint(pool,user,request.headers.get("x-cc-endpoint-token"));
        if (["deskphone","sip"].includes(endpoint.kind)) {
          if (!endpoint.sip_username) throw Object.assign(Error("This phone has no SIP identity."),{status:409});
          // Detect a manually dialled handset call before committing any provider effect.
          if (endpoint.kind === "deskphone") {
            const status = await controlStation(pool,user,endpoint,"status");
            if (nativePhoneState(status).status!=='idle')
              throw Object.assign(Error("This phone is not confirmed idle."),{status:409});
            const phone=await stationPhone(pool,endpoint.station_id);
            if(!(phone?.settings?.cti_mode==='desktop_bridge'||(phone?.vendor==='polycom'&&phone.settings?.cti_mode==='direct')||(phone?.vendor==='audiocodes'&&phone.settings?.cti_mode==='sip_controller')))
              throw Object.assign(Error("Direct dialing requires an available native CTI controller."),{status:409});
            dialContext.nativeOrigination={endpointId:endpoint.id,number:nativeDialTarget(target.extension || target.destination)};
          }
          dialContext.stationTarget = `sip:${endpoint.sip_username}@sip.telnyx.com`;
          dialContext.stationId = endpoint.station_id;
        }
      }
    }
    const intent = body.sourceInteractionId
      ? await reserveCoreTarget(pool, { username: user.username, sourceInteractionId: body.sourceInteractionId, target: body.target, targetUserId: body.targetUserId, requestId: body.requestId })
      : await reserveDirectVoice(pool, { agentId: String(user.id), requestId: body.requestId, target: dialContext.target.destination, dialContext });
    if (!intent) return NextResponse.json({ ok: true, customHeaders: [] });
    if (dialContext?.stationTarget) {
      const saga = (await pool.query("SELECT id FROM acd_sagas WHERE work_item_id=$1 AND type='manual_outbound'",[intent.work_item_id])).rows[0];
      await driveSaga(pool,saga.id,{provider:createTelnyxProvider(),node:"native-outbound:http"});
      const work = (await pool.query("SELECT state FROM acd_work_items WHERE id=$1",[intent.work_item_id])).rows[0];
      if (work?.state === "failed") {
        const command=(await pool.query(`SELECT response->>'error' AS reason FROM acd_commands
          WHERE saga_id=$1 AND operation='manual_outbound_phone_dial' ORDER BY created_at DESC LIMIT 1`,[saga.id])).rows[0];
        if (command?.reason==='phone_sip_501')
          throw Object.assign(Error("This phone firmware does not support direct CTI dialing. Use the handset keypad."),{status:409});
        if (command?.reason==='remote_control_approval_required')
          throw Object.assign(Error("Confirm remote control on the phone before dialing."),{status:409});
        throw Object.assign(Error("The selected phone could not start the call. Check its registration and CTI connection."),{status:502});
      }
    }
    return NextResponse.json({
      ok: true,
      intentId: intent.id,
      workItemId: intent.work_item_id || null,
      destination: dialContext?.target.destination,
      callerNumber: dialContext?.identity.number,
      outboundIdentity: dialContext?.identity,
      native: Boolean(dialContext?.stationTarget),
      handsetOriginated: Boolean(dialContext?.nativeOrigination),
      customHeaders: [{ name: "X-CC-Direct-Intent-Id", value: intent.id }],
    });
  } catch (error) {
    if (!error.status) logger.error("direct_intent_preparation_failed", {error:error.message,code:error.code});
    return NextResponse.json({ error: error.status ? error.message : "Call preparation failed" }, { status: error.status || 500 });
  }
}

async function DELETE_handler(request, _context, authz) {
  const user = authz.user;
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!UUID_PATTERN.test(String(id || ""))) {
      return NextResponse.json({ error: "Invalid direct call intent" }, { status: 400 });
    }
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    const intent = (await pool.query(
      `SELECT id, agent_id, work_item_id, purpose FROM acd_direct_intents WHERE id = $1`,
      [id],
    )).rows[0];
    if (!intent) return NextResponse.json({ ok: true, released: false });

    let cancellationScope;
    if (["blind_transfer_target", "consult_target"].includes(intent.purpose)) {
      const access = await authorizePersistedInteractionControl(
        pool,
        { id: intent.work_item_id, work_item_id: intent.work_item_id },
        user,
      );
      if (!access.ok) return NextResponse.json(access, { status: access.status });
      cancellationScope = { workItemId: intent.work_item_id };
    } else {
      if (String(intent.agent_id) !== String(user.id)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      cancellationScope = { agentId: String(user.id) };
    }

    const released = await cancelUnstartedDirectIntent(pool, {
      id,
      ...cancellationScope,
    });
    return NextResponse.json({ ok: true, released });
  } catch (error) {
    return NextResponse.json(
      { error: error.status ? error.message : "Call cancellation failed" },
      { status: error.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { voiceControl: true, route: "/api/voice/direct-intent" });
export const DELETE = withPermission("agent:self", DELETE_handler, { voiceControl: true, route: "/api/voice/direct-intent" });
