import { stationPhone } from '../telephony/station-control.mjs';
import { executeCtiAction } from '../hardphones/cti.mjs';
import { nativePhoneState } from '../telephony/native-phone-state.mjs';
import { nativeDialTarget } from '../hardphones/native-dial-target.mjs';

// The durable saga invokes this effect once. Physical Dial APIs do not provide
// provider-style command idempotency; an uncertain result needs SIP evidence.
export async function dialNativeIntent(pool, { intentId }, commandId) {
  const row = (await pool.query(`SELECT i.*,w.attributes FROM acd_direct_intents i
    JOIN acd_work_items w ON w.id=i.work_item_id WHERE i.id=$1`, [intentId])).rows[0];
  const origin = row?.attributes?.native_origination;
  const failed = reason => ({ outcome:'failed', httpStatus:409, response:{ error:reason } });
  if (!origin || row.state !== 'pending' || row.provider_call_id)
    return failed('Native dial intent is no longer pending');

  const lease = await pool.query(`SELECT 1 FROM cc_station_leases l
    JOIN cc_voice_endpoints e ON e.id=l.endpoint_id
    JOIN cc_user_sessions a ON a.session_token=l.auth_session_id AND a.logout_at IS NULL
    WHERE l.station_id=$1 AND l.endpoint_id=$2 AND l.agent_id=$3 AND l.purpose='work'
      AND l.expires_at>now() AND e.revoked_at IS NULL`,
  [row.attributes.native_station_id, origin.endpointId, row.agent_id]);
  if (!lease.rowCount) return failed('The phone session has ended');
  const phone = await stationPhone(pool, row.attributes.native_station_id);
  if (!phone || phone.provisioning_state === 'disabled') return failed('Phone unavailable');

  let dispatched = false;
  try {
    const status = await executeCtiAction(phone, 'status', {}, { pool });
    if (!status.ok || nativePhoneState(status).status !== 'idle')
      return failed('The phone is not confirmed idle');
    const number = nativeDialTarget(origin.number);
    dispatched = true;
    const result = await executeCtiAction(phone, 'dial', {
      number, intentId, commandId, expiresAt:Date.now() + (phone.vendor==='audiocodes'?30000:15000),
    }, { pool });
    if (result.ok) return {
      outcome:'accepted', httpStatus:200, response:{ data:{ phoneId:phone.id, intentId } },
    };
    return {
      outcome:result.definitive === true ? 'failed' : 'ambiguous', httpStatus:null,
      response:{ error:result.reason || 'Native origination unconfirmed' },
    };
  } catch (error) {
    return dispatched
      ? { outcome:'ambiguous', httpStatus:null, response:{ error:error.message } }
      : failed('Could not confirm the phone is idle');
  }
}
