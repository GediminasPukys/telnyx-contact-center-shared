import { randomBytes, createHash } from 'node:crypto';
import { consumeBrowserAuth } from './desktop-browser-auth.mjs';
export const proofHash = value => createHash('sha256').update(value).digest('base64url');
const validId = id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id);
const validProof = proof => typeof proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof);
let initialized;
async function ready(pool) {
  if (!initialized) initialized = pool.query(`CREATE TABLE IF NOT EXISTS cc_desktop_auth_requests (
    id text PRIMARY KEY, challenge text NOT NULL, display_code text NOT NULL,
    expires_at timestamptz NOT NULL, approved_user_id text, consumed_at timestamptz
  )`).catch(error => { initialized = null; throw error; });
  await initialized;
}
export async function createDesktopAuth(pool, challenge) {
  if (!validProof(challenge)) throw Error('Invalid desktop request');
  await ready(pool);
  await pool.query('DELETE FROM cc_desktop_auth_requests WHERE expires_at < now()');
  const id = randomBytes(24).toString('hex'), code = randomBytes(3).toString('hex').toUpperCase();
  await pool.query("INSERT INTO cc_desktop_auth_requests(id,challenge,display_code,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",[id,challenge,code]);
  return { id, code };
}
export async function inspectDesktopAuth(pool, id) {
  if (!validId(id)) return null;
  await ready(pool);
  const row = (await pool.query('SELECT display_code FROM cc_desktop_auth_requests WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL',[id])).rows[0];
  return row ? { code:row.display_code } : null;
}
export async function approveDesktopAuth(pool, id, userId) {
  if (!validId(id)) return false;
  await ready(pool);
  return !!(await pool.query(`UPDATE cc_desktop_auth_requests SET approved_user_id=$2 WHERE id=$1 AND expires_at>now()
    AND consumed_at IS NULL AND approved_user_id IS NULL AND EXISTS(SELECT 1 FROM users WHERE id::text=$2 AND active IS NOT FALSE)`,[id,String(userId)])).rowCount;
}
export async function pollDesktopAuth(pool, id, verifier) {
  if (!validId(id) || !validProof(verifier)) return { expired:true };
  await ready(pool);
  const row = (await pool.query('SELECT approved_user_id FROM cc_desktop_auth_requests WHERE id=$1 AND challenge=$2 AND expires_at>now() AND consumed_at IS NULL',[id,proofHash(verifier)])).rows[0];
  return row ? { approved:!!row.approved_user_id } : { expired:true };
}
export async function consumeDesktopAuth(pool, id, verifier, authorizationCode) {
  if (authorizationCode !== undefined) return consumeBrowserAuth(pool,id,verifier,authorizationCode);
  if (!validId(id) || !validProof(verifier)) return null;
  await ready(pool);
  // Atomic consume: only the native process holding the verifier can redeem;
  // expiry, disabled users and concurrent/replayed exchanges fail closed.
  return (await pool.query(`UPDATE cc_desktop_auth_requests SET consumed_at=now() WHERE id=$1 AND challenge=$2
    AND expires_at>now() AND consumed_at IS NULL AND approved_user_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM users WHERE id::text=approved_user_id AND active IS NOT FALSE)
    RETURNING approved_user_id`,[id,proofHash(verifier)])).rows[0]?.approved_user_id || null;
}
