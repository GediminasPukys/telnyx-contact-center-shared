import { deviceWebRequest, deviceCookie, decodeDeviceHtml, readDeviceForm, deviceTableText } from "./device-web.mjs";
import { normalizeMac, phoneLineLabel } from "./config-generators.mjs";
import { enrollProvisioningPhone, getProvisioningEnrollment, provisioningCredentials, audiocodesBootstrapConfig } from "./provisioning-access.mjs";
import { recordProvisioningEvent } from "./logging.mjs";

const tableValue = deviceTableText;

export function parseAudioCodesConfiguration(html) {
  const text = decodeDeviceHtml(html.match(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/i)?.[1] || "");
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
    const m = line.match(/^([a-z][\w/]*)=(.*)$/);
    return m ? [[m[1], m[2].trim()]] : [];
  }));
}

export function parseAudioCodesStatus(xml) {
  if (!/<Status[>\s]/.test(xml)) throw new Error("auth_failed");
  const lines = [...xml.matchAll(/<Line\s+id="(\d+)">([\s\S]*?)<\/Line>/g)].map(m => {
    const get = key => decodeDeviceHtml(m[2].match(new RegExp(`<${key}>(.*?)</${key}>`))?.[1] || "");
    return { id: m[1], state: get("PhoneState"), registration: get("SipStatus").toLowerCase(), server: get("SipRegSrv") };
  });
  return { lines, idle: lines.length > 0 && lines.every(l => ["On Hook", "Disabled"].includes(l.state)),
    registered: lines.some(l => l.id === "0" && l.registration === "registered") };
}

export async function audioCodesSession(phone, { request = deviceWebRequest } = {}) {
  const user = phone.admin_user || "admin";
  const password = phone.admin_password || process.env.TELNYX_PHONE_ADMIN_PASSWORD || "";
  let headers = {};
  const probe = await request(phone, "/mainform.cgi/info.htm");
  const target = { ...phone, certificate_fingerprint: phone.certificate_fingerprint || probe.certificateFingerprint };
  if (/^Basic\b/i.test(probe.headers["www-authenticate"] || "")) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  } else {
    const login = await request(target, "/login.cgi", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ user, psw: Buffer.from(password).toString("base64") }).toString() });
    headers.Cookie = deviceCookie(login.headers);
    if (!headers.Cookie) throw new Error("auth_failed");
  }
  const send = async (path, options = {}) => {
    const result = await request(target, path, { ...options, headers: { ...headers, ...options.headers } });
    if ([401, 403].includes(result.status)) throw new Error("auth_failed");
    if (result.status !== 200) throw new Error("unsupported_device_response");
    return result;
  };
  return { send, fingerprint: probe.certificateFingerprint };
}

export async function inspectAudioCodes(phone, enrollment, options = {}) {
  const session = await audioCodesSession({ ...phone, certificate_fingerprint: enrollment?.certificate_fingerprint }, options);
  const info = await session.send("/mainform.cgi/info.htm");
  const model = tableValue(info.raw, "Model Name"), firmware = tableValue(info.raw, "Firmware Version");
  const mac = normalizeMac(tableValue(info.raw, "MAC Address"));
  // The web server can answer before its identity/status tables are populated
  // during boot. This is not evidence that a different device took the address.
  // Callers must wait and revalidate identity before any configuration write.
  if (!mac || !model) throw new Error("device_not_ready");
  if (mac !== phone.mac) throw new Error("device_mac_mismatch");
  if (!["420HD", "440HD"].includes(model) || model !== phone.model) throw new Error("unsupported_device_model");
  const status = parseAudioCodesStatus((await session.send("/voip_status.cgi")).raw);
  return { session, model, firmware, mac, ...status };
}

export async function configureAudioCodesProvisioning(pool, phone, options = {}) {
  const inspected = await inspectAudioCodes(phone, await getProvisioningEnrollment(pool, phone.id), options);
  if (!inspected.idle) return { ok: false, reason: "phone_has_active_call" };
  const enrollment = await enrollProvisioningPhone(pool, phone);
  const credential = provisioningCredentials(phone, enrollment);
  const page = await inspected.session.send("/mainform.cgi/auto_provision.htm");
  const form = readDeviceForm(page.raw, "tftpform");
  for (const key of ["ASU_METHOD", "CFG_URL", "NOW_CFG"]) if (!form.has(key)) throw new Error("unsupported_device_form");
  form.set("ASU_METHOD", "2");
  form.set("CFG_URL", `${enrollment.base_url}/api/provisioning/${phone.mac}.cfg`);
  form.set("Us_Nm", credential.username); form.set("Pswd", credential.password);
  form.set("NOW_CFG", "1"); form.set("NOW_FW", "0"); form.set("FW_DYN", "0"); form.set("CFG_DYN", "0");
  await pool.query(`UPDATE hp_device_enrollments SET certificate_fingerprint=COALESCE(certificate_fingerprint,$2),
    downloaded_at=NULL,verified_at=NULL,verification='{}'::jsonb WHERE phone_id=$1`, [phone.id, inspected.session.fingerprint]);
  await pool.query("UPDATE hp_phones SET provisioning_state='pending',updated_at=NOW() WHERE id=$1", [phone.id]);
  if (readDeviceForm(page.raw, "tftpform").has("Us_Nm")) {
    const action = page.raw.match(/document\.tftpform\.action\s*=\s*["']\.\.\/mainform\.cgi\/(auto_provision\.htm)["']/i)?.[1];
    if (!action) throw new Error("unsupported_device_form");
    const checked = await inspected.session.send(`/mainform.cgi/${action}`, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    // "Check now" only downloads the file on 420HD 2.2.16.643. Its web UI
    // then submits NOW_CFG=2 to accept the downloaded configuration.
    if (/\btftpform\.NOW_CFG\.value\s*=\s*["']?2\b/.test(checked.raw)) {
      form.set("NOW_CFG", "2");
      await inspected.session.send(`/mainform.cgi/${action}`, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
    }
  } else {
    // Older 440HD firmware omits HTTP authentication from its provisioning form.
    // Its supported configuration import installs only the bootstrap parameters.
    const upload = new FormData();
    upload.set("TYPE", "6");
    upload.set("upname", new Blob([audiocodesBootstrapConfig(phone, enrollment)], { type: "text/plain" }), `${phone.mac}-bootstrap.cfg`);
    const encoded = new Request("http://localhost", { method: "POST", body: upload });
    const result = await inspected.session.send("/mainform.cgi/Auto_Config.htm", { method: "POST",
      headers: { "Content-Type": encoded.headers.get("content-type") }, body: Buffer.from(await encoded.arrayBuffer()) });
    const confirm = readDeviceForm(result.raw, "confirmform");
    if (!confirm.has("upmode")) throw new Error("unsupported_device_form");
    confirm.set("upmode", "1");
    await inspected.session.send("/mainform.cgi/Manu_Config.htm", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: confirm.toString() });
  }
  await recordProvisioningEvent(pool, { phoneId: phone.id, mac: phone.mac, eventType: "audiocodes_provisioning_requested",
    detail: { model: inspected.model, firmware: inspected.firmware } });
  return { ok: true, state: "pending", reloadAccepted: true };
}

export async function verifyAudioCodesProvisioning(pool, phone, options = {}) {
  const enrollment = await getProvisioningEnrollment(pool, phone.id);
  if (!enrollment) return { ok: false, reason: "phone_not_enrolled" };
  const inspected = await inspectAudioCodes(phone, enrollment, options);
  const assignment = (await pool.query(`SELECT a.number FROM cc_extension_assignments a
    JOIN cc_phone_stations s ON s.id=a.station_id WHERE s.phone_id=$1 AND a.target_type='phone'`, [phone.id])).rows[0];
  const displayLabel = phoneLineLabel({ ...phone, extension: assignment?.number });
  const config = parseAudioCodesConfiguration((await inspected.session.send("/mainform.cgi/manu_config.htm")).raw);
  const displayLabelMatches = config["voip/line/0/description"] === displayLabel
    && (inspected.model !== "440HD" || config["voip/line/0/extension_display"] === displayLabel);
  const configMatches = displayLabelMatches && config["voip/line/0/id"] === phone.sip_username
    && config["voip/signalling/sip/proxy_address"] === (phone.settings?.sip_server || "sip.telnyx.com")
    && config["provisioning/configuration/url"] === `${enrollment.base_url}/api/provisioning/${phone.mac}.cfg`
    && config["provisioning/configuration/http_auth/user_name"] === phone.mac;
  const verification = { configMatches, displayLabelMatches, displayLabel, registered: inspected.registered,
    configDownloaded: Boolean(enrollment.downloaded_at), model: inspected.model, firmware: inspected.firmware,
    serverCertificateVerified: config["security/provisioning/verify_server_certificate"] === "1", checkedAt: new Date().toISOString() };
  const verified = Boolean(configMatches && inspected.registered && enrollment.downloaded_at);
  await pool.query(`UPDATE hp_device_enrollments SET verified_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
    verification=$3::jsonb WHERE phone_id=$1`, [phone.id, verified, JSON.stringify(verification)]);
  await pool.query(`UPDATE hp_phones SET provisioning_state=CASE WHEN $2 THEN 'provisioned' ELSE 'pending' END,
    sip_registration_status=$3,sip_registration_status_at=NOW(),last_seen_at=NOW(),updated_at=NOW() WHERE id=$1`,
  [phone.id, verified, inspected.registered ? "registered" : "not_registered"]);
  await recordProvisioningEvent(pool, { phoneId: phone.id, mac: phone.mac, eventType: "audiocodes_provisioning_verified",
    detail: { verified, ...verification } });
  return { ok: true, verified, state: verified ? "provisioned" : "pending", ...verification };
}
