import { randomBytes, createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('base64url');
const proof = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validId = id => typeof id === 'string' && /^[a-f0-9]{48}$/.test(id);
const initialized = new WeakMap();
async function ready(pool) {
  if (!initialized.has(pool)) initialized.set(pool, pool.query(`CREATE TABLE IF NOT EXISTS cc_desktop_browser_auth (
    id text PRIMARY KEY, challenge text NOT NULL, redirect_uri text NOT NULL,
    browser_hash text, grant_hash text, user_id text,
    started_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  )`).catch(error => { initialized.delete(pool); throw error; }));
  await initialized.get(pool);
}

export function validDesktopRedirect(value) {
  // An IP literal, random path and ephemeral port only. Never DNS, LAN, file,
  // custom protocols or a URL supplied at completion time.
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.href === value && url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      Number(url.port) >= 1024 && Number(url.port) <= 65535 && !url.username && !url.password &&
      !url.search && !url.hash && /^\/callback\/[A-Za-z0-9_-]{43}$/.test(url.pathname);
  } catch { return false; }
}

export async function createBrowserAuth(pool, challenge, redirectUri) {
  if (!proof(challenge) || !validDesktopRedirect(redirectUri)) throw Error('Invalid desktop request');
  await ready(pool);
  await pool.query('DELETE FROM cc_desktop_browser_auth WHERE expires_at < now()');
  const id = randomBytes(24).toString('hex');
  await pool.query(`INSERT INTO cc_desktop_browser_auth(id,challenge,redirect_uri,expires_at)
    VALUES($1,$2,$3,now()+interval '5 minutes')`, [id,challenge,redirectUri]);
  return { id };
}

export async function inspectBrowserAuth(pool, id) {
  if (!validId(id)) return false;
  await ready(pool);
  return !!(await pool.query(`SELECT 1 FROM cc_desktop_browser_auth
    WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL AND grant_hash IS NULL`, [id])).rowCount;
}

export async function bindBrowserAuth(pool, id) {
  if (!validId(id)) return null;
  await ready(pool);
  const binding = randomBytes(32).toString('base64url');
  const result = await pool.query(`UPDATE cc_desktop_browser_auth SET browser_hash=$2
    WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL AND browser_hash IS NULL`, [id,hash(binding)]);
  return result.rowCount ? binding : null;
}

export async function completeBrowserAuth(pool, { id, binding, userId, provider, authenticatedAt, error = false }) {
  if (!validId(id) || !proof(binding)) return null;
  if (!error && (provider !== 'google' || !Number.isFinite(authenticatedAt))) return null;
  await ready(pool);
  const code = randomBytes(32).toString('base64url');
  const result = error
    ? await pool.query(`UPDATE cc_desktop_browser_auth SET consumed_at=now()
        WHERE id=$1 AND browser_hash=$2 AND expires_at>now() AND consumed_at IS NULL AND grant_hash IS NULL
        RETURNING redirect_uri`, [id,hash(binding)])
    : await pool.query(`UPDATE cc_desktop_browser_auth SET grant_hash=$3,user_id=$4
        WHERE id=$1 AND browser_hash=$2 AND expires_at>now() AND consumed_at IS NULL AND grant_hash IS NULL
        AND started_at <= to_timestamp($5 / 1000.0)
        AND EXISTS(SELECT 1 FROM users WHERE id::text=$4 AND active IS NOT FALSE)
        RETURNING redirect_uri`, [id,hash(binding),hash(code),String(userId),authenticatedAt]);
  if (!result.rowCount) return null;
  const url = new URL(result.rows[0].redirect_uri);
  url.searchParams.set(error ? 'error' : 'code', error ? 'cancelled' : code);
  return url.href;
}

export async function consumeBrowserAuth(pool, id, verifier, code) {
  if (!validId(id) || !proof(verifier) || !proof(code)) return null;
  await ready(pool);
  // Knowing the native verifier alone is insufficient. The one-use grant is
  // delivered ONLY to the browser's loopback, never through a polling API.
  return (await pool.query(`UPDATE cc_desktop_browser_auth SET consumed_at=now()
    WHERE id=$1 AND challenge=$2 AND grant_hash=$3 AND expires_at>now() AND consumed_at IS NULL
    AND EXISTS(SELECT 1 FROM users WHERE id::text=user_id AND active IS NOT FALSE)
    RETURNING user_id`, [id,hash(verifier),hash(code)])).rows[0]?.user_id || null;
}

export async function cancelBrowserAuth(pool, id, verifier) {
  if (!validId(id) || !proof(verifier)) return;
  await ready(pool);
  await pool.query(`UPDATE cc_desktop_browser_auth SET consumed_at=now()
    WHERE id=$1 AND challenge=$2 AND consumed_at IS NULL`, [id,hash(verifier)]);
}
