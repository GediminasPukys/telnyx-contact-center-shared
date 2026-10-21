import { createHash, createPublicKey, publicEncrypt, randomBytes, createCipheriv, constants } from "node:crypto";
import { deviceWebRequest, decodeDeviceHtml, readDeviceForm } from "./device-web.mjs";
import { normalizeMac, phoneLineLabel } from "./config-generators.mjs";
import { enrollProvisioningPhone, getProvisioningEnrollment, provisioningCredentials } from "./provisioning-access.mjs";
import { recordProvisioningEvent } from "./logging.mjs";

// V73 T22P servlet protocol. No device-supplied JavaScript is executed.
export function encryptYealinkFields(n, e, plaintext) {
  if (!/^[a-f0-9]{256,1024}$/i.test(n) || !/^[a-f0-9]{1,8}$/i.test(e)) throw new Error("unsupported_device_response");
  const publicKey = createPublicKey({ key: { kty: "RSA",
    n: Buffer.from(n, "hex").toString("base64url"),
    e: Buffer.from(e.length % 2 ? `0${e}` : e, "hex").toString("base64url"),
  }, format: "jwk" });
  const key = randomBytes(16), iv = randomBytes(16);
  const rsa = value => publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value.toString("hex"))).toString("hex");
  // Firmware-mandated checksum inside the encrypted servlet envelope. This is
  // not a stored password verifier: the complete form and checksum are encrypted
  // with a new AES key/IV, wrapped with the handset's RSA public key per request.
  const bytes = Buffer.from(`MD5=${createHash("md5").update(plaintext).digest("hex")};${plaintext}`);
  const padded = Buffer.alloc(Math.ceil(bytes.length / 16) * 16); bytes.copy(padded);
  const cipher = createCipheriv("aes-128-cbc", key, iv); cipher.setAutoPadding(false);
  return { key: rsa(key), iv: rsa(iv), data: Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64") };
}

export async function yealinkLegacySession(phone, { request = deviceWebRequest, currentAdminPassword } = {}) {
  const challenge = await request(phone, "/servlet?p=login&q=getsessionid");
  const [n, e, id] = challenge.raw.trim().split(",");
  if (challenge.status !== 200 || !/^\w{8,128}$/.test(id || "")) throw new Error("unsupported_device_response");
  const target = { ...phone, certificate_fingerprint: phone.certificate_fingerprint || challenge.certificateFingerprint };
  let sessionId = id;
  let cookie = `JSESSIONID=${sessionId}`;
  const updateCookie = headers => {
    const values = headers["set-cookie"] || [];
    for (const value of Array.isArray(values) ? values : [values]) {
      const match = value.match(/^JSESSIONID=(\w{8,128})(?:;|$)/);
      if (match) { sessionId = match[1]; cookie = `JSESSIONID=${sessionId}`; }
    }
  };
  const password = currentAdminPassword ?? phone.admin_password ?? process.env.TELNYX_PHONE_ADMIN_PASSWORD ?? "";
  if (/[;\r\n]/.test(password)) throw new Error("unsupported_device_password");
  const fields = encryptYealinkFields(n, e, `rand=${Math.random()};sessionid=${id};username=admin;pwd=${password};`);
  const response = await request(target, "/servlet?p=login&q=login", { method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, jumpto: "status", acc: "" }).toString() });
  if (response.status !== 302 || response.headers.location?.trim() !== "/servlet?p=status&q=load") throw new Error("auth_failed");
  updateCookie(response.headers);
  const send = async (path, options = {}) => {
    const { expectedRedirect, ...requestOptions } = options;
    const result = await request(target, path, { ...requestOptions, headers: { Cookie: cookie, ...options.headers } });
    if ([401, 403].includes(result.status) || result.headers.location?.includes("p=login")) throw new Error("auth_failed");
    // V73 appends a space to the Location header after saving some forms.
    // Accept only a caller-declared local destination; never follow redirects
    // with the session cookie or mistake an authentication redirect for success.
    const saved = result.status === 302 && expectedRedirect?.startsWith("/servlet?")
      && result.headers.location?.trim() === expectedRedirect;
    if (result.status !== 200 && !saved) throw new Error("unsupported_device_response");
    updateCookie(result.headers);
    return result;
  };
  return { send, get id() { return sessionId; }, fingerprint: challenge.certificateFingerprint };
}

export function yealinkProvisioningForm(html) {
  const form = readDeviceForm(html, "formInput");
  // V73 injects this CSRF input during page load instead of rendering it in the
  // form markup. Parse only the literal token; never execute the page script.
  const token = html.match(/\bUpdateToken\("([a-z0-9_-]{1,128})"\)/i)?.[1];
  if (!token) throw new Error("unsupported_device_form");
  form.set("token", token);
  return form;
}

export function parseYealinkStatus(html) {
  const td = id => decodeDeviceHtml(html.match(new RegExp(`<td\\b[^>]*id=["']${id}["'][^>]*>([^<]*)</td>`, "i"))?.[1] || "").trim();
  const mac = normalizeMac(td("tdMACAddress")), firmware = td("tdFirmware");
  const accounts = html.match(/<tbody\b[^>]*id="StatusAccountStatus"[^>]*>([\s\S]*?)<\/tbody>/)?.[1] || "";
  const statuses = [...accounts.matchAll(/T\("(Disabled|Registered|Registering|Register Failed|Unregistered)"\)/g)].map(m => m[1]);
  return { mac, firmware, registered: statuses[0] === "Registered",
    allAccountsDisabled: statuses.length === 3 && statuses.every(s => s === "Disabled") };
}

export async function inspectYealink(phone, enrollment, options = {}) {
  if (phone.model !== "T22P") throw new Error("unsupported_device_model");
  const session = await yealinkLegacySession({ ...phone, certificate_fingerprint: enrollment?.certificate_fingerprint }, options);
  const status = parseYealinkStatus((await session.send("/servlet?p=status&q=load")).raw);
  if (status.mac !== phone.mac) throw new Error("device_mac_mismatch");
  if (!/^7\.73\./.test(status.firmware)) throw new Error("unsupported_device_model");
  return { session, model: "T22P", ...status };
}

export async function configureYealinkProvisioning(pool, phone, options = {}) {
  const inspected = await inspectYealink(phone, await getProvisioningEnrollment(pool, phone.id), options);
  // This firmware does not expose a reliable ringing/held-call status in its
  // web panel. Only an unused phone can be reloaded automatically. Enrolled
  // phones poll for updates themselves; never interrupt an unknown call state.
  if (!inspected.allAccountsDisabled) return { ok: false, reason: "device_idle_state_unavailable" };
  const enrollment = await enrollProvisioningPhone(pool, phone);
  const credential = provisioningCredentials(phone, enrollment);
  const page = await inspected.session.send("/servlet?p=settings-autop&q=load");
  const form = yealinkProvisioningForm(page.raw);
  for (const key of ["AutoProvisionServerURL", "AutoProvisionUser", "AutoProvisionPassword"]) if (!form.has(key)) throw new Error("unsupported_device_form");
  const n = page.raw.match(/var g_rsa_n = "([a-f0-9]+)"/i)?.[1] || "";
  const e = page.raw.match(/var g_rsa_e = "([a-f0-9]+)"/i)?.[1] || "";
  form.set("AutoProvisionServerURL", `${enrollment.base_url}/api/provisioning/`);
  form.set("AutoProvisionUser", credential.username);
  form.set("AutoProvisionPassword", credential.password);
  form.set("AutoProvisionEnablePNP", "0");
  form.set("AutoProvisionEnableDHCPOption", "0");
  form.set("AutoProvisionPowerOn", "1");
  form.set("AutoProvisionRepeat", "1"); form.set("AutoProvisionRepeatMinutes", "60");
  let secrets = "";
  for (const key of ["AutoProvisionPassword", "AutoProvisionAESKey16", "AutoProvisionAESKey16MAC"]) {
    if (!form.has(key)) throw new Error("unsupported_device_form");
    secrets += `${key}=${form.get(key)};`; form.set(key, "");
  }
  const encrypted = encryptYealinkFields(n, e, `rand=${Math.random()};${secrets}sessionid=${inspected.session.id};`);
  for (const [key, value] of Object.entries(encrypted)) form.set(key, value);
  await pool.query(`UPDATE hp_device_enrollments SET certificate_fingerprint=COALESCE(certificate_fingerprint,$2),
    downloaded_at=NULL,verified_at=NULL,verification='{}'::jsonb WHERE phone_id=$1`, [phone.id, inspected.session.fingerprint]);
  await pool.query("UPDATE hp_phones SET provisioning_state='pending',updated_at=NOW() WHERE id=$1", [phone.id]);
  await inspected.session.send("/servlet?p=settings-autop&q=write&now=true", { method: "POST",
    expectedRedirect: "/servlet?p=settings-autop&q=load",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
  await recordProvisioningEvent(pool, { phoneId: phone.id, mac: phone.mac, eventType: "yealink_provisioning_requested",
    detail: { model: inspected.model, firmware: inspected.firmware, managementProtocol: phone.settings?.management_protocol || "https" } });
  return { ok: true, state: "pending", reloadAccepted: true };
}

export async function verifyYealinkProvisioning(pool, phone, options = {}) {
  const enrollment = await getProvisioningEnrollment(pool, phone.id);
  if (!enrollment) return { ok: false, reason: "phone_not_enrolled" };
  const inspected = await inspectYealink(phone, enrollment, options);
  const account = readDeviceForm((await inspected.session.send("/servlet?p=account-register&q=load&acc=0")).raw, "formInput");
  const provision = readDeviceForm((await inspected.session.send("/servlet?p=settings-autop&q=load")).raw, "formInput");
  const assignment = (await pool.query(`SELECT a.number FROM cc_extension_assignments a
    JOIN cc_phone_stations s ON s.id=a.station_id WHERE s.phone_id=$1 AND a.target_type='phone'`, [phone.id])).rows[0];
  const displayLabel = phoneLineLabel({ ...phone, extension: assignment?.number });
  const displayLabelMatches = account.get("AccountLabel") === displayLabel;
  const configMatches = displayLabelMatches && account.get("AccountEnable") === "1"
    && account.get("AccountUserName") === phone.sip_username && account.get("AccountRegisterName") === phone.sip_username
    && account.get("server1") === (phone.settings?.sip_server || "sip.telnyx.com")
    && provision.get("AutoProvisionServerURL") === `${enrollment.base_url}/api/provisioning/`
    && provision.get("AutoProvisionUser") === phone.mac;
  const verification = { configMatches, displayLabelMatches, displayLabel, registered: inspected.registered,
    configDownloaded: Boolean(enrollment.downloaded_at), model: inspected.model, firmware: inspected.firmware,
    managementProtocol: phone.settings?.management_protocol || "https", checkedAt: new Date().toISOString() };
  const verified = Boolean(configMatches && inspected.registered && enrollment.downloaded_at);
  await pool.query(`UPDATE hp_device_enrollments SET verified_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
    verification=$3::jsonb WHERE phone_id=$1`, [phone.id, verified, JSON.stringify(verification)]);
  await pool.query(`UPDATE hp_phones SET provisioning_state=CASE WHEN $2 THEN 'provisioned' ELSE 'pending' END,
    sip_registration_status=$3,sip_registration_status_at=NOW(),last_seen_at=NOW(),updated_at=NOW() WHERE id=$1`,
  [phone.id, verified, inspected.registered ? "registered" : "not_registered"]);
  await recordProvisioningEvent(pool, { phoneId: phone.id, mac: phone.mac, eventType: "yealink_provisioning_verified", detail: { verified, ...verification } });
  return { ok: true, verified, state: verified ? "provisioned" : "pending", ...verification };
}
