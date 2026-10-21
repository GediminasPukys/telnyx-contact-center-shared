import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// Separate from the SIP and device administrator passwords. A database dump
// alone cannot reconstruct a device's provisioning or notification credential.
function deviceSecret(phone, enrollment, purpose, encoding = "base64url") {
  const key = process.env.HARDPHONE_PROVISIONING_SECRET || process.env.NEXTAUTH_SECRET;
  if (!key || key.length < 32) throw new Error("Provisioning requires a server secret of at least 32 characters");
  return createHmac("sha256", key).update(`hardphone:${purpose}:${phone.id}:${enrollment.generation}`).digest(encoding);
}

export function provisioningCredentials(phone, enrollment) {
  // 128 bits of derived entropy using a conservative ASCII-only alphabet.
  return { username: phone.mac, password: deviceSecret(phone, enrollment, "config", "hex").slice(0, 32) };
}

export function provisioningEventToken(phone, enrollment) {
  return deviceSecret(phone, enrollment, "event");
}

function equalSecret(value, expected) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeProvisioning(header, phone, enrollment) {
  if (!enrollment || !/^Basic /i.test(header || "")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const { username, password } = provisioningCredentials(phone, enrollment);
  return decoded.slice(0, separator) === username && equalSecret(decoded.slice(separator + 1), password);
}

export function authorizeProvisioningEvent(header, phone, enrollment) {
  if (!enrollment || !/^Basic /i.test(header || "")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return decoded.slice(0, separator) === phone.mac && equalSecret(decoded.slice(separator + 1), provisioningEventToken(phone, enrollment));
}

const initialized = new WeakMap();
export function ensureProvisioningAccessSchema(pool) {
  if (!initialized.has(pool)) {
    const promise = pool.query(`CREATE TABLE IF NOT EXISTS hp_device_enrollments (
      phone_id UUID PRIMARY KEY REFERENCES hp_phones(id) ON DELETE CASCADE,
      generation UUID NOT NULL,
      base_url TEXT NOT NULL,
      certificate_fingerprint TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      downloaded_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ,
      verification JSONB NOT NULL DEFAULT '{}'::jsonb
    )`).catch((error) => { initialized.delete(pool); throw error; });
    initialized.set(pool, promise);
  }
  return initialized.get(pool);
}

export async function getProvisioningEnrollment(pool, phoneId) {
  await ensureProvisioningAccessSchema(pool);
  return (await pool.query("SELECT * FROM hp_device_enrollments WHERE phone_id = $1", [phoneId])).rows[0] || null;
}

export function resolveProvisioningOrigin() {
  const value = process.env.HARDPHONE_PROVISIONING_BASE_URL || process.env.APP_BASE_URL || process.env.NEXTAUTH_URL;
  const url = new URL(value || "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Configure HARDPHONE_PROVISIONING_BASE_URL as a public HTTPS origin");
  }
  return url.origin;
}

export async function enrollProvisioningPhone(pool, phone, baseUrl = resolveProvisioningOrigin()) {
  const candidate = { generation: randomUUID() };
  provisioningCredentials(phone, candidate); // Fail before any database change if the secret is missing.
  await ensureProvisioningAccessSchema(pool);
  return (await pool.query(`INSERT INTO hp_device_enrollments (phone_id, generation, base_url)
    VALUES ($1, $2, $3) ON CONFLICT (phone_id) DO UPDATE SET base_url = EXCLUDED.base_url
    RETURNING *`, [phone.id, candidate.generation, baseUrl])).rows[0];
}

export function polycomBootstrapParameters(phone, enrollment) {
  const credential = provisioningCredentials(phone, enrollment);
  return {
    "device.set": "1",
    "device.prov.serverType.set": "1", "device.prov.serverType": "HTTPS",
    "device.prov.serverName.set": "1", "device.prov.serverName": `${enrollment.base_url}/api/provisioning/`,
    "device.prov.user.set": "1", "device.prov.user": credential.username,
    "device.prov.password.set": "1", "device.prov.password": credential.password,
    "device.dhcp.bootSrvUseOpt.set": "1", "device.dhcp.bootSrvUseOpt": "Static",
    "apps.restapi.enabled": "1",
  };
}

export function polycomBootstrapConfig(phone, enrollment) {
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<polycomConfig><bootstrap ${Object.entries(polycomBootstrapParameters(phone, enrollment)).map(([key, value]) => `${key}="${escape(value)}"`).join(" ")}/></polycomConfig>\n`;
}

export function audiocodesBootstrapConfig(phone, enrollment) {
  const credential = provisioningCredentials(phone, enrollment);
  return [
    `system/type=${String(phone.model || "").replace(/[\r\n]/g, " ")}`,
    "provisioning/method=STATIC",
    `provisioning/configuration/url=${enrollment.base_url}/api/provisioning/${phone.mac}.cfg`,
    `provisioning/configuration/http_auth/user_name=${credential.username}`,
    `provisioning/configuration/http_auth/password=${credential.password}`,
    "provisioning/period/type=HOURLY",
    "provisioning/period/hourly/hours_interval=1", "",
  ].join("\n");
}

export function yealinkBootstrapConfig(phone, enrollment) {
  const credential = provisioningCredentials(phone, enrollment);
  const prefix = /^(?:SIP-)?T(?:20|22|26|28)P?$/i.test(phone.model || "") ? "" : "static.";
  return [
    "#!version:1.0.0.1",
    `${prefix}auto_provision.server.url = ${enrollment.base_url}/api/provisioning/`,
    `${prefix}auto_provision.server.username = ${credential.username}`,
    `${prefix}auto_provision.server.password = ${credential.password}`,
    `${prefix}auto_provision.power_on = 1`,
    `${prefix}auto_provision.repeat.enable = 1`,
    `${prefix}auto_provision.repeat.minutes = 60`, "",
  ].join("\n");
}
