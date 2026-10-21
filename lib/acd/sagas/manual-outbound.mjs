import { randomUUID } from "node:crypto";

import { appendEvent } from "../events.mjs";
import {
  applyTransition,
  closeOpenSegment,
  openSegment,
  isTerminalState,
} from "../lifecycle.mjs";
import { releaseReservation } from "../reservations.mjs";
import { defineSaga, startSaga } from "../saga-engine.mjs";
import { loadAgentLifecycleSettings } from "../agent-lifecycle-settings.mjs";

const DIAL_TIMEOUT_SECONDS = 30;
const PROVIDER_EVENT_MARGIN_MS = 5_000;
const LATE_DIAL_EVIDENCE_MS = 60_000;
const MAX_CALL_DURATION_MS = 4 * 60 * 60 * 1_000;

const patchData = (tx, ctx, patch) => tx.query(
  `UPDATE acd_sagas SET data = data || $2::jsonb WHERE id = $1`,
  [ctx.saga.id, JSON.stringify(patch)],
);

async function readLeg(tx, workItemId, role) {
  return (await tx.query(
    `SELECT * FROM acd_legs
      WHERE work_item_id = $1 AND role = $2
      ORDER BY created_at
      LIMIT 1`,
    [workItemId, role],
  )).rows[0] || null;
}

async function readDialCommand(tx, sagaId) {
  return (await tx.query(
    `SELECT * FROM acd_commands
      WHERE saga_id = $1 AND operation = 'manual_outbound_dial'
      ORDER BY created_at DESC
      LIMIT 1`,
    [sagaId],
  )).rows[0] || null;
}

async function readOrRecoverCustomer(tx, ctx) {
  let customer = await readLeg(tx, ctx.workItem.id, "customer");
  const command = await readDialCommand(tx, ctx.saga.id);
  // Some Telnyx 4xx Dial responses include a data.call_control_id-shaped
  // value even though no customer call was created. Only a journaled provider
  // acceptance may recover a customer leg from the command response.
  const acceptedCall = ["accepted", "confirmed"].includes(command?.status)
    ? command?.response?.data
    : null;
  if (!customer && acceptedCall?.call_control_id) {
    await bindManualOutboundCustomer(tx, ctx.saga, acceptedCall);
    customer = await readLeg(tx, ctx.workItem.id, "customer");
  }
  return { customer, command };
}

async function finalizeRejectedDial(tx, ctx) {
  const customer = await readLeg(tx, ctx.workItem.id, "customer");
  if (customer && !customer.ended_at) return "cleanup_customer";
  // The browser/device leg already exists at this point. Issue a provider
  // hangup and wait for end evidence before releasing Core capacity.
  const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
  if (agent && !agent.ended_at) return "hangup_agent";
  return finalizeLifecycle(tx, ctx);
}

function encodedClientState(ctx) {
  return Buffer.from(JSON.stringify({
    acdWorkItemId: ctx.workItem.id,
    acdRole: "customer",
    directIntentId: ctx.data.directIntentId,
  })).toString("base64");
}

function dialRequest(ctx) {
  const request = {
    to: ctx.data.target,
    from: ctx.data.fromNumber,
    connection_id: ctx.data.connectionId,
    link_to: ctx.data.agentProviderCallId,
    ...(ctx.data.handsetOriginated ? {} : { bridge_intent: true }),
    // Telnyx's production validator accepts Dial-level park only together
    // with automatic bridging. This is also the legacy sequence that makes
    // the PSTN customer survive when the agent starts a consultation.
    bridge_on_answer: true,
    // Give the customer leg its survival policy when Telnyx creates it. A
    // later consult moves the WebRTC agent leg away from this bridge; without
    // Dial-level park ownership Telnyx can end the displaced customer even if
    // a previous Bridge command also requested parking.
    park_after_unbridge: "self",
    // Core still advances only after answer and bridge webhooks; provider
    // acceptance of the Dial remains insufficient evidence.
    timeout_secs: Number(ctx.data.timeoutSecs) || DIAL_TIMEOUT_SECONDS,
    client_state: encodedClientState(ctx),
    custom_headers: [
      { name: "X-CC-Work-Item-Id", value: ctx.workItem.id },
      { name: "X-CC-Leg-Role", value: "customer" },
      { name: "X-CC-Saga-Id", value: ctx.saga.id },
      ...(ctx.data.directIntentId ? [{ name: "X-CC-Direct-Intent-Id", value: ctx.data.directIntentId }] : []),
    ],
  };
  if (ctx.data.independentCustomer) {
    // A native handset must survive bridge changes. Link-to ties both Dial
    // legs together; establish their media bridge explicitly after answer.
    for (const key of ["link_to","bridge_intent","bridge_on_answer","park_after_unbridge"]) delete request[key];
  }
  if (ctx.data.fromDisplayName) request.from_display_name = ctx.data.fromDisplayName;
  return request;
}

export async function bindManualOutboundCustomer(tx, saga, payload = {}) {
  const callControlId = payload.call_control_id || null;
  if (!callControlId) return null;
  const leg = (await tx.query(
    `INSERT INTO acd_legs
       (id, work_item_id, role, provider_call_id, provider_session_id,
        owner_saga_id, state)
     VALUES ($1, $2, 'customer', $3, $4, $5, 'dialing')
     ON CONFLICT (provider_call_id) DO UPDATE SET
       provider_session_id = COALESCE(acd_legs.provider_session_id, EXCLUDED.provider_session_id),
       owner_saga_id = COALESCE(acd_legs.owner_saga_id, EXCLUDED.owner_saga_id)
     RETURNING *`,
    [
      randomUUID(),
      saga.work_item_id,
      callControlId,
      payload.call_session_id || null,
      saga.id,
    ],
  )).rows[0] || null;
  await tx.query(
    `UPDATE acd_sagas
        SET data = data || jsonb_build_object('customerProviderCallId', $2::text)
      WHERE id = $1`,
    [saga.id, callControlId],
  );
  await tx.query(
    `UPDATE acd_work_items
        SET provider_session_id = COALESCE(provider_session_id, $2),
            attributes = attributes || jsonb_build_object(
              'customer_call_control_id', $3::text
            )
      WHERE id = $1`,
    [saga.work_item_id, payload.call_session_id || null, callControlId],
  );
  return leg;
}

async function markConnected(tx, ctx) {
  const customer = await readLeg(tx, ctx.workItem.id, "customer");
  const connectedAt = customer?.answered_at || customer?.bridged_at || new Date().toISOString();
  await tx.query(
    `UPDATE acd_segments
        SET answered_at = COALESCE(answered_at, $2::timestamptz)
      WHERE work_item_id = $1 AND kind = 'agent' AND ended_at IS NULL`,
    [ctx.workItem.id, connectedAt],
  );
  await tx.query(
    `UPDATE acd_direct_intents
        SET state = CASE WHEN state IN ('ended', 'revoked') THEN state ELSE 'active' END
      WHERE id = $1`,
    [ctx.data.directIntentId],
  );
  await tx.query(
    `UPDATE acd_work_items
        SET attributes = attributes || jsonb_build_object(
          'manual_outbound_connected_at', COALESCE(
            attributes->>'manual_outbound_connected_at',
            $2::text
          )
        )
      WHERE id = $1`,
    [ctx.workItem.id, connectedAt],
  );
  if (!ctx.data.connectedRecorded) {
    await appendEvent(tx, {
      workItemId: ctx.workItem.id,
      agentId: ctx.data.agentId,
      type: "manual_outbound_connected",
      actor: "saga:manual_outbound",
      payload: {
        saga_id: ctx.saga.id,
        direct_intent_id: ctx.data.directIntentId,
        customer_call_control_id: customer?.provider_call_id || null,
      },
    });
    await patchData(tx, ctx, { connectedRecorded: true });
  }
}

async function recordUnconfirmed(tx, ctx, reason) {
  if (ctx.data.unconfirmedReason === reason) return;
  await appendEvent(tx, {
    workItemId: ctx.workItem.id,
    agentId: ctx.data.agentId,
    type: "manual_intervention_required",
    actor: "saga:manual_outbound",
    payload: {
      saga_id: ctx.saga.id,
      direct_intent_id: ctx.data.directIntentId,
      reason,
    },
  });
  await patchData(tx, ctx, { unconfirmedReason: reason });
}

async function settleDirection(tx, ctx) {
  const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
  const { customer, command } = await readOrRecoverCustomer(tx, ctx);
  if (agent && !agent.ended_at) return "hangup_agent";
  if (customer && !customer.ended_at) return "hangup_customer";
  if (!customer) {
    if (command && command.status !== "failed" && !ctx.data.dialEvidenceExpired) {
      return "await_dial_evidence";
    }
  }
  return "finalize";
}

async function finalizeLifecycle(tx, ctx) {
  const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
  const { customer, command } = await readOrRecoverCustomer(tx, ctx);
  if (agent && !agent.ended_at) return "hangup_agent";
  if (customer && !customer.ended_at) return "hangup_customer";

  if (!customer && command && command.status !== "failed" && !ctx.data.dialEvidenceExpired) {
    return "await_dial_evidence";
  }

  const answered = Boolean(
    customer?.answered_at
      || customer?.bridged_at
      || agent?.bridged_at
      || ctx.data.connectedRecorded,
  );
  const terminalReason = customer?.ended_reason
    || agent?.ended_reason
    || ctx.data.failureReason
    || (command?.status === "failed" ? "origination_failed" : "normal_clearing");
  const work = (await tx.query(
    `SELECT * FROM acd_work_items WHERE id = $1 FOR UPDATE`,
    [ctx.workItem.id],
  )).rows[0];
  if (work && !isTerminalState(work.state)) {
    await closeOpenSegment(tx, work.id, {
      outcome: answered ? "completed" : "no_answer",
      answeredAt: answered
        ? customer?.answered_at || customer?.bridged_at || agent?.bridged_at || null
        : null,
    });
    await applyTransition(tx, {
      workItemId: work.id,
      to: answered ? "completed" : "failed",
      eventType: answered ? "manual_outbound_ended" : "manual_outbound_unanswered",
      actor: "saga:manual_outbound",
      patch: { terminalReason },
      payload: {
        agent_id: ctx.data.agentId,
        direct_intent_id: ctx.data.directIntentId,
      },
    });
  }
  if (ctx.data.reservationId) {
    await releaseReservation(tx, ctx.data.reservationId, "manual_outbound_ended", {
      actor: "saga:manual_outbound",
    });
  }
  if (work?.attributes?.outbound_target_reservation) await releaseReservation(tx,work.attributes.outbound_target_reservation,"manual_outbound_target_ended",{actor:"saga:manual_outbound"});
  await tx.query(
    `UPDATE acd_direct_intents
        SET state = 'ended', ended_at = COALESCE(ended_at, now())
      WHERE id = $1`,
    [ctx.data.directIntentId],
  );
  return "succeeded";
}

export async function startManualOutboundSaga(tx, {
  workItemId,
  directIntentId,
  reservationId,
  agentId,
  agentProviderCallId,
  agentProviderSessionId = null,
  target,
  fromNumber,
  fromDisplayName = null,
  connectionId,
  timeoutSecs = DIAL_TIMEOUT_SECONDS,
  nativeStationTarget = null,
  nativeOrigination = null,
  handsetOriginated = false,
  internalQueue = null,
}) {
  const previous = (await tx.query(
    `SELECT id FROM acd_sagas
      WHERE work_item_id = $1 AND type = 'manual_outbound'
      ORDER BY created_at
      LIMIT 1`,
    [workItemId],
  )).rows[0];
  if (previous) {
    if (nativeStationTarget && agentProviderCallId) await tx.query(
      `UPDATE acd_sagas SET data=data || jsonb_build_object('agentProviderCallId',$2::text,'agentProviderSessionId',$3::text)
       WHERE id=$1 AND (data->>'agentProviderCallId' IS NULL OR data->>'agentProviderCallId'=$2)`,
      [previous.id,agentProviderCallId,agentProviderSessionId]);
    return { sagaId: previous.id, created: false };
  }
  const lifecycle = await loadAgentLifecycleSettings(tx);

  const started = await startSaga(tx, {
    type: "manual_outbound",
    workItemId,
    conflictKey: "manual_outbound_origination",
    data: {
      directIntentId,
      reservationId,
      agentId,
      agentProviderCallId,
      agentProviderSessionId,
      target,
      fromNumber,
      fromDisplayName,
      connectionId,
      timeoutSecs,
      nativeStationTarget,
      nativeOrigination,
      handsetOriginated,
      independentCustomer: Boolean(nativeStationTarget || handsetOriginated),
      internalQueue,
      maxCallDurationMs: lifecycle.max_call_duration_seconds * 1_000,
    },
  });
  await tx.query(
    `UPDATE acd_legs
        SET owner_saga_id = $2
      WHERE work_item_id = $1 AND role = 'agent_device'
        AND provider_call_id = $3`,
    [workItemId, started.sagaId, agentProviderCallId],
  );
  await tx.query(`UPDATE acd_reservations r SET owner_saga_id=$2 FROM acd_work_items w
    WHERE w.id=$1 AND w.attributes->>'outbound_target_reservation'=r.id::text`,[workItemId,started.sagaId]);
  return { ...started, created: true };
}

const customerEvents = {
  "leg.answered:customer": "route_customer_bridge",
  "leg.bridged:customer": "route_customer_bridge",
  "leg.ended:customer": "cleanup_agent",
};

export const manualOutboundSaga = defineSaga("manual_outbound", {
  initialStep: "route_originator",
  steps: {
    route_originator: {
      run: async (_tx, ctx) => ctx.data.nativeOrigination ? "dial_phone" : ctx.data.handsetOriginated ? "answer_handset" : ctx.data.nativeStationTarget ? "dial_station" : "route_destination",
    },
    dial_phone: {
      // Handset APIs cannot deduplicate Dial. Never replay an uncertain send;
      // reconcile the physical SIP leg instead.
      dedupeWindowMs:-1,
      cmd:ctx=>({operation:'manual_outbound_phone_dial',endpoint:'/native-phone/dial',request:{intentId:ctx.data.directIntentId}}),
      on:{accepted:'await_phone','leg.initiated:agent_device':'answer_handset','leg.ended:agent_device':'settle'},
      deadlineMs:45000,onDeadline:'verify_phone',onFailure:'finalize',
    },
    await_phone: {
      run:async(tx,ctx)=>{const leg=await readLeg(tx,ctx.workItem.id,'agent_device');return leg?.ended_at?'settle':leg?'answer_handset':null;},
      on:{'leg.initiated:agent_device':'answer_handset','leg.ended:agent_device':'settle'},
      deadlineMs:45000,onDeadline:'verify_phone',
    },
    verify_phone: {
      run:async(tx,ctx)=>{const leg=await readLeg(tx,ctx.workItem.id,'agent_device');if(leg)return leg.ended_at?'settle':'answer_handset';
        await recordUnconfirmed(tx,ctx,'native_phone_origination_unconfirmed');return 'await_phone';},
    },
    answer_handset: {
      cmd: ctx => ({operation:"handset_answer",endpoint:`/calls/${encodeURIComponent(ctx.data.agentProviderCallId)}/actions/answer`,request:{}}),
      on: {"leg.answered:agent_device":"route_destination","leg.ended:agent_device":"settle"},
      deadlineMs:15000,onFailure:"cleanup_agent",onDeadline:"cleanup_agent",
    },
    dial_station: {
      cmd: ctx => ({
        operation: "manual_outbound_station_dial", endpoint: "/calls",
        request: {
          to: ctx.data.nativeStationTarget, from: ctx.data.fromNumber,
          connection_id: ctx.data.connectionId, timeout_secs: 30,
          time_limit_secs: Math.ceil(ctx.data.maxCallDurationMs / 1000),
          custom_headers: [{name:"X-CC-Direct-Intent-Id",value:ctx.data.directIntentId}],
          client_state: Buffer.from(JSON.stringify({directIntentId:ctx.data.directIntentId,acdWorkItemId:ctx.workItem.id,acdRole:"agent_device"})).toString("base64"),
        },
      }),
      onAccepted: async (tx, {saga,response}) => {
        const data = response?.data;
        if (!data?.call_control_id) return;
        await tx.query(`UPDATE acd_direct_intents SET provider_call_id=COALESCE(provider_call_id,$2),
          provider_session_id=COALESCE(provider_session_id,$3) WHERE id=$1`,
        [saga.data.directIntentId,data.call_control_id,data.call_session_id || null]);
        await tx.query(`INSERT INTO acd_legs(id,work_item_id,role,agent_id,provider_call_id,provider_session_id,owner_saga_id,state)
          VALUES($1,$2,'agent_device',$3,$4,$5,$6,'dialing') ON CONFLICT(provider_call_id) DO NOTHING`,
        [randomUUID(),saga.work_item_id,saga.data.agentId,data.call_control_id,data.call_session_id || null,saga.id]);
        await tx.query(`UPDATE acd_sagas SET data=data || jsonb_build_object('agentProviderCallId',$2::text) WHERE id=$1`,
        [saga.id,data.call_control_id]);
      },
      on: {accepted:"await_station","leg.answered:agent_device":"route_destination","leg.ended:agent_device":"settle"},
      deadlineMs:40000,onDeadline:"verify_station",onFailure:"finalize",
    },
    await_station: {
      run: async (tx,ctx) => {
        const leg = await readLeg(tx,ctx.workItem.id,"agent_device");
        return leg?.ended_at ? "settle" : leg?.answered_at ? "route_destination" : null;
      },
      on: {"leg.answered:agent_device":"route_destination","leg.ended:agent_device":"settle"},
      deadlineMs:40000,onDeadline:"verify_station",
    },
    verify_station: {
      run: async (tx,ctx) => {
        const leg = await readLeg(tx,ctx.workItem.id,"agent_device");
        if (leg?.ended_at) return "settle";
        if (leg?.answered_at) return "route_destination";
        if (leg) return "cleanup_agent";
        // An unanswered HTTP request is not proof that the phone never rang.
        // Preserve the reservation until provider evidence arrives.
        await recordUnconfirmed(tx,ctx,"native_station_origination_unconfirmed");
        return "await_station";
      },
    },
    route_destination: {
      run: async (tx,ctx) => !ctx.data.internalQueue ? "dial_customer"
        : (await readLeg(tx,ctx.workItem.id,"agent_device"))?.answered_at ? "prepare_internal_queue" : "answer_queue_originator",
    },
    answer_queue_originator: {
      cmd:ctx => ({operation:"internal_queue_answer",endpoint:`/calls/${encodeURIComponent(ctx.data.agentProviderCallId)}/actions/answer`,request:{}}),
      on:{"leg.answered:agent_device":"prepare_internal_queue","leg.ended:agent_device":"settle"},
      deadlineMs:15000,onFailure:"cleanup_agent",onDeadline:"cleanup_agent",
    },
    prepare_internal_queue: {
      run:async(tx,ctx) => {
        await closeOpenSegment(tx,ctx.workItem.id,{outcome:"answered"});
        await tx.query("UPDATE acd_legs SET role='customer' WHERE work_item_id=$1 AND provider_call_id=$2",[ctx.workItem.id,ctx.data.agentProviderCallId]);
        await tx.query("UPDATE acd_direct_intents SET purpose='internal_queue_caller' WHERE id=$1",[ctx.data.directIntentId]);
        await tx.query(`UPDATE acd_work_items SET attributes=attributes || jsonb_build_object(
          'internal_caller_id',$2::text,'customer_call_control_id',$3::text,'voice_occupancy_kind','queue') WHERE id=$1`,
        [ctx.workItem.id,ctx.data.agentId,ctx.data.agentProviderCallId]);
        return "enqueue_internal_queue";
      },
    },
    enqueue_internal_queue: {
      cmd:ctx => ({operation:"internal_queue_enqueue",endpoint:`/calls/${encodeURIComponent(ctx.data.agentProviderCallId)}/actions/enqueue`,
        request:{queue_name:ctx.data.internalQueue.name}}),
      on:{"leg.enqueued:customer":"route_internal_queue","leg.ended:customer":"internal_queue_failed"},
      deadlineMs:15000,onFailure:"internal_queue_failed",onDeadline:"internal_queue_failed",
    },
    route_internal_queue: {
      run:async(tx,ctx) => {
        await applyTransition(tx,{workItemId:ctx.workItem.id,to:"queued",eventType:"work_item_queued",actor:"saga:internal_queue",
          patch:{queueId:ctx.data.internalQueue.id,enqueuedAt:new Date().toISOString()},
          payload:{internal_caller_id:ctx.data.agentId,queue_id:ctx.data.internalQueue.id}});
        await openSegment(tx,{workItemId:ctx.workItem.id,kind:"queue_wait",queueId:ctx.data.internalQueue.id});
        return "succeeded";
      },
    },
    internal_queue_failed: {
      run:async(tx,ctx) => {
        await applyTransition(tx,{workItemId:ctx.workItem.id,to:"failed",eventType:"internal_queue_failed",actor:"saga:internal_queue",
          patch:{terminalReason:"queue_enqueue_failed"}});
        // Terminal media cleanup hangs up the caller; capacity remains held
        // until the corresponding signed hangup reaches direct intake.
        return "failed";
      },
    },
    dial_customer: {
      guard: async (tx, ctx) => {
        const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
        if (!agent || agent.ended_at) return "settle";
        if (!ctx.data.connectionId || !ctx.data.fromNumber || !ctx.data.target) {
          await patchData(tx, ctx, { failureReason: "manual_outbound_configuration_missing" });
          return "finalize_rejected_dial";
        }
        return null;
      },
      cmd: (ctx) => ({
        operation: "manual_outbound_dial",
        endpoint: "/calls",
        request: dialRequest(ctx),
      }),
      onAccepted: async (tx, { saga, response }) => {
        await bindManualOutboundCustomer(tx, saga, response?.data || {});
      },
      on: {
        accepted: "await_customer",
        "leg.initiated:customer": "await_customer",
        ...customerEvents,
        "leg.bridged:agent_device": "mark_connected",
        "leg.ended:agent_device": "cleanup_customer",
      },
      deadlineMs: (ctx) => (
        (Number(ctx.data.timeoutSecs) || DIAL_TIMEOUT_SECONDS) * 1_000
        + PROVIDER_EVENT_MARGIN_MS
      ),
      onDeadline: "verify_dial",
      onFailure: "finalize_rejected_dial",
    },
    await_customer: {
      run: async (tx, ctx) => {
        const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
        const customer = await readLeg(tx, ctx.workItem.id, "customer");
        if (customer?.answered_at || customer?.bridged_at) return "route_customer_bridge";
        if (customer?.ended_at) return "cleanup_agent";
        if (agent?.ended_at) return "cleanup_customer";
        return null;
      },
      on: {
        ...customerEvents,
        "leg.bridged:agent_device": "mark_connected",
        "leg.ended:agent_device": "cleanup_customer",
      },
      deadlineMs: (ctx) => (
        (Number(ctx.data.timeoutSecs) || DIAL_TIMEOUT_SECONDS) * 1_000
        + PROVIDER_EVENT_MARGIN_MS
      ),
      onDeadline: "verify_dial",
    },
    verify_dial: {
      run: async (tx, ctx) => {
        const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
        const { customer, command } = await readOrRecoverCustomer(tx, ctx);
        if (customer?.answered_at || customer?.bridged_at) return "route_customer_bridge";
        if (customer?.ended_at) return "cleanup_agent";
        if (agent?.ended_at) return customer ? "cleanup_customer" : "settle";
        if (customer) return "cleanup_customer";
        return command?.status === "failed" ? "finalize_rejected_dial" : "await_dial_evidence";
      },
    },
    await_dial_evidence: {
      on: {
        "leg.initiated:customer": "verify_dial",
        ...customerEvents,
        "leg.bridged:agent_device": "mark_connected",
        "leg.ended:agent_device": "settle",
      },
      deadlineMs: LATE_DIAL_EVIDENCE_MS,
      onDeadline: "expire_dial_evidence",
    },
    route_customer_bridge: {
      run:async(_tx,ctx)=>ctx.data.independentCustomer && !ctx.data.customerBridgeIssued ? "bridge_customer_explicit" : "await_customer_bridge",
    },
    bridge_customer_explicit: {
      cmd:ctx=>({operation:"manual_outbound_bridge",endpoint:`/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/bridge`,
        request:{call_control_id:ctx.data.agentProviderCallId,park_after_unbridge:"self",hold_after_unbridge:true}}),
      onAccepted:(tx,{saga})=>tx.query("UPDATE acd_sagas SET data=data || '{\"customerBridgeIssued\":true}'::jsonb WHERE id=$1",[saga.id]),
      on:{accepted:"await_customer_bridge","leg.bridged:customer":"mark_connected","leg.ended:customer":"cleanup_agent","leg.ended:agent_device":"cleanup_customer"},
      deadlineMs:10000,onFailure:"cleanup_customer",onDeadline:"verify_customer_bridge",
    },
    await_customer_bridge: {
      run: async (tx, ctx) => {
        const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
        const customer = await readLeg(tx, ctx.workItem.id, "customer");
        if (customer?.bridged_at || agent?.bridged_at) return "mark_connected";
        if (customer?.ended_at) return "cleanup_agent";
        if (agent?.ended_at) return "cleanup_customer";
        return null;
      },
      on: {
        "leg.bridged:customer": "mark_connected",
        "leg.bridged:agent_device": "mark_connected",
        "leg.ended:customer": "cleanup_agent",
        "leg.ended:agent_device": "cleanup_customer",
      },
      deadlineMs: 10_000,
      onDeadline: "verify_customer_bridge",
    },
    verify_customer_bridge: {
      run: async (tx, ctx) => {
        const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
        const customer = await readLeg(tx, ctx.workItem.id, "customer");
        if (customer?.bridged_at || agent?.bridged_at) return "mark_connected";
        if (customer?.ended_at) return "cleanup_agent";
        if (agent?.ended_at) return "cleanup_customer";
        await recordUnconfirmed(tx, ctx, "manual_outbound_bridge_outcome_unconfirmed");
        return "cleanup_customer";
      },
    },
    expire_dial_evidence: {
      run: async (tx, ctx) => {
        await recordUnconfirmed(tx, ctx, "manual_outbound_dial_outcome_unconfirmed");
        await patchData(tx, ctx, { dialEvidenceExpired: true });
        return "cleanup_agent";
      },
    },
    finalize_rejected_dial: { run: finalizeRejectedDial },
    mark_connected: {
      run: async (tx, ctx) => {
        await markConnected(tx, ctx);
        const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
        const customer = await readLeg(tx, ctx.workItem.id, "customer");
        if (customer?.ended_at) return "cleanup_agent";
        if (agent?.ended_at) return "cleanup_customer";
        return "handling";
      },
    },
    handling: {
      on: {
        "leg.ended:customer": "cleanup_agent",
        "leg.ended:agent_device": "cleanup_customer",
      },
      deadlineMs: (ctx) => ctx.data?.maxCallDurationMs || MAX_CALL_DURATION_MS,
      onDeadline: "cleanup_customer",
    },
    verify_handling: {
      run: async (tx, ctx) => {
        const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
        const customer = await readLeg(tx, ctx.workItem.id, "customer");
        if (customer?.ended_at) return "cleanup_agent";
        if (agent?.ended_at) return "cleanup_customer";
        await recordUnconfirmed(tx, ctx, "manual_outbound_long_call_requires_end_evidence");
        return "handling";
      },
    },
    cleanup_agent: {
      run: async (tx, ctx) => {
        const agent = await readLeg(tx, ctx.workItem.id, "agent_device");
        return !agent || agent.ended_at ? "settle" : "hangup_agent";
      },
    },
    hangup_agent: {
      cmd: (ctx) => ({
        operation: "manual_outbound_hangup_agent",
        endpoint: `/calls/${encodeURIComponent(ctx.data.agentProviderCallId)}/actions/hangup`,
        request: {},
      }),
      on: {
        accepted: "wait_agent_end",
        "leg.ended:agent_device": "settle",
      },
      deadlineMs: 10_000,
      onDeadline: "wait_agent_end",
      onFailure: "wait_agent_end",
    },
    wait_agent_end: {
      run: async (tx, ctx) => (
        (await readLeg(tx, ctx.workItem.id, "agent_device"))?.ended_at
          ? "settle"
          : null
      ),
      on: { "leg.ended:agent_device": "settle" },
      deadlineMs: LATE_DIAL_EVIDENCE_MS,
      onDeadline: "agent_end_unconfirmed",
    },
    agent_end_unconfirmed: {
      run: async (tx, ctx) => {
        await recordUnconfirmed(tx, ctx, "manual_outbound_agent_end_unconfirmed");
        return "wait_agent_end";
      },
    },
    cleanup_customer: {
      run: async (tx, ctx) => {
        const { customer, command } = await readOrRecoverCustomer(tx, ctx);
        if (customer?.ended_at) return "settle";
        if (customer) {
          if (ctx.data.customerProviderCallId !== customer.provider_call_id) {
            await patchData(tx, ctx, {
              customerProviderCallId: customer.provider_call_id,
            });
          }
          return "hangup_customer";
        }
        if (command && command.status !== "failed" && !ctx.data.dialEvidenceExpired) {
          return "await_dial_evidence";
        }
        return "settle";
      },
    },
    hangup_customer: {
      cmd: (ctx) => ({
        operation: "manual_outbound_hangup_customer",
        endpoint: `/calls/${encodeURIComponent(ctx.data.customerProviderCallId)}/actions/hangup`,
        request: {},
      }),
      on: {
        accepted: "wait_customer_end",
        "leg.ended:customer": "settle",
      },
      deadlineMs: 10_000,
      onDeadline: "wait_customer_end",
      onFailure: "wait_customer_end",
    },
    wait_customer_end: {
      run: async (tx, ctx) => (
        (await readLeg(tx, ctx.workItem.id, "customer"))?.ended_at
          ? "settle"
          : null
      ),
      on: { "leg.ended:customer": "settle" },
      deadlineMs: LATE_DIAL_EVIDENCE_MS,
      onDeadline: "customer_end_unconfirmed",
    },
    customer_end_unconfirmed: {
      run: async (tx, ctx) => {
        await recordUnconfirmed(tx, ctx, "manual_outbound_customer_end_unconfirmed");
        return "wait_customer_end";
      },
    },
    settle: { run: settleDirection },
    finalize: { run: finalizeLifecycle },
  },
  compensationSteps: [
    "finalize_rejected_dial",
    "cleanup_agent",
    "hangup_agent",
    "wait_agent_end",
    "cleanup_customer",
    "hangup_customer",
    "wait_customer_end",
  ],
});
