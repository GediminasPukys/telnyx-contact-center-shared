import { polycomDriver } from "./drivers/polycom.mjs";
import { normalizeMac, phoneLineLabel } from "./config-generators.mjs";
import { enrollProvisioningPhone, getProvisioningEnrollment, polycomBootstrapParameters } from "./provisioning-access.mjs";
import { recordProvisioningEvent } from "./logging.mjs";

function devicePhone(phone, enrollment) {
  return { ...phone, admin_password: phone.admin_password || process.env.TELNYX_PHONE_ADMIN_PASSWORD, certificate_fingerprint: enrollment?.certificate_fingerprint };
}

export async function polycomLineLabelParameters(pool, phone) {
  const assignment = (await pool.query(`SELECT a.number FROM cc_extension_assignments a
    JOIN cc_phone_stations s ON s.id=a.station_id WHERE s.phone_id=$1 AND a.target_type='phone'`, [phone.id])).rows[0];
  const label = phoneLineLabel({...phone,extension:assignment?.number || null});
  return {"reg.1.label":label,"reg.1.displayName":label};
}

// Legacy REST/manual labels have higher precedence than provisioning files.
// Repair only those display fields; never reset unrelated local settings.
export async function synchronizePolycomLineLabel(pool, phone, {driver=polycomDriver, force=false} = {}) {
  const enrollment = await getProvisioningEnrollment(pool,phone.id);
  const inspected = await inspectPolycom(phone,enrollment,driver);
  if (!inspected.ok) return inspected;
  if (inspected.status.call && (!Array.isArray(inspected.status.call) || inspected.status.call.length)) return {ok:false,reason:"phone_has_active_call"};
  const parameters = await polycomLineLabelParameters(pool,phone);
  const current = await driver.getConfig(inspected.target,Object.keys(parameters));
  if (!current.ok) return current;
  const values = current.data?.data || {};
  const overrides = Object.fromEntries(Object.entries(parameters).filter(([name,value]) =>
    (force || ["local","web"].includes(String(values[name]?.Source || "").toLowerCase())) && String(values[name]?.Value ?? "") !== value));
  return Object.keys(overrides).length ? driver.setConfig(inspected.target,overrides) : {ok:true};
}

export async function inspectPolycom(phone, enrollment, driver = polycomDriver) {
  const target = devicePhone(phone, enrollment);
  const info = await driver.deviceInfo(target);
  if (!info.ok) return { ok: false, reason: info.httpStatus === 404 ? "rest_api_disabled" : info.reason };
  const device = info.data?.data;
  if (normalizeMac(device?.MACAddress) !== phone.mac) return { ok: false, reason: "device_mac_mismatch" };
  const status = await driver.status(target);
  if (!status.ok) return { ok: false, reason: status.reason };
  return { ok: true, target, status, device, fingerprint: info.certificate_fingerprint };
}

export async function configurePolycomProvisioning(pool, phone, { driver = polycomDriver } = {}) {
  let enrollment = await getProvisioningEnrollment(pool, phone.id);
  const inspected = await inspectPolycom(phone, enrollment, driver);
  if (!inspected.ok) return inspected;
  if (inspected.status.call?.length || (inspected.status.call && !Array.isArray(inspected.status.call))) return { ok: false, reason: "phone_has_active_call" };
  enrollment = await enrollProvisioningPhone(pool, phone);
  if (inspected.fingerprint) {
    await pool.query("UPDATE hp_device_enrollments SET certificate_fingerprint = COALESCE(certificate_fingerprint, $2) WHERE phone_id = $1", [phone.id, inspected.fingerprint]);
  }
  // Clear evidence before applying: a device may fetch immediately after set.
  await pool.query("UPDATE hp_device_enrollments SET verified_at = NULL, downloaded_at = NULL, verification = '{}'::jsonb WHERE phone_id = $1", [phone.id]);
  await pool.query("UPDATE hp_phones SET provisioning_state = 'pending', updated_at = NOW() WHERE id = $1", [phone.id]);
  const display = await synchronizePolycomLineLabel(pool,phone,{driver});
  if (!display.ok) return display;
  const configured = await driver.setConfig({ ...inspected.target, certificate_fingerprint: inspected.fingerprint }, polycomBootstrapParameters(phone, enrollment));
  if (!configured.ok) return { ok: false, reason: configured.reason, uncertain: configured.uncertain };
  const reload = await driver.reprovision(inspected.target);
  await recordProvisioningEvent(pool, { phoneId: phone.id, mac: phone.mac, eventType: "polycom_provisioning_requested", detail: { reloadAccepted: reload.ok, model: inspected.device.ModelNumber, firmware: inspected.device.FirmwareRelease } });
  return { ok: true, state: "pending", reloadAccepted: reload.ok, reason: reload.ok ? undefined : reload.reason };
}

export async function verifyPolycomProvisioning(pool, phone, { driver = polycomDriver } = {}) {
  const assignment = (await pool.query(`SELECT a.number FROM cc_extension_assignments a
    JOIN cc_phone_stations s ON s.id=a.station_id WHERE s.phone_id=$1 AND a.target_type='phone'`, [phone.id])).rows[0];
  phone = { ...phone, extension:assignment?.number || null };
  const enrollment = await getProvisioningEnrollment(pool, phone.id);
  if (!enrollment) return { ok: false, reason: "phone_not_enrolled" };
  const inspected = await inspectPolycom(phone, enrollment, driver);
  if (!inspected.ok) return inspected;
  const config = await driver.getConfig(inspected.target, ["reg.1.address", "reg.1.auth.userId", "reg.1.label", "reg.1.displayName", "reg.1.server.1.address", "apps.restapi.enabled", "device.prov.serverName"]);
  if (!config.ok) return { ok: false, reason: config.reason };
  const values = config.data?.data || {};
  const value = name => String(values[name]?.Value ?? values[name]?.value ?? "");
  const displayLabelMatches = value("reg.1.label") === phoneLineLabel(phone) && value("reg.1.displayName") === phoneLineLabel(phone);
  const configMatches = displayLabelMatches && value("reg.1.address") === phone.sip_username && value("reg.1.auth.userId") === phone.sip_username
    && value("reg.1.server.1.address") === (phone.settings?.sip_server || "sip.telnyx.com")
    && value("apps.restapi.enabled") === "1" && value("device.prov.serverName") === polycomBootstrapParameters(phone, enrollment)["device.prov.serverName"];
  const lines = Array.isArray(inspected.status.line) ? inspected.status.line : [inspected.status.line];
  const registered = lines.some(line => String(line?.LineNumber) === "1" && String(line?.RegistrationStatus).toLowerCase() === "registered");
  const verified = Boolean(configMatches && registered && enrollment.downloaded_at);
  const verification = { configMatches, displayLabelMatches, displayLabel:phoneLineLabel(phone), registered, configDownloaded: Boolean(enrollment.downloaded_at), model: inspected.device.ModelNumber, firmware: inspected.device.FirmwareRelease, checkedAt: new Date().toISOString() };
  await pool.query("UPDATE hp_device_enrollments SET verified_at = CASE WHEN $2 THEN NOW() ELSE NULL END, verification = $3::jsonb WHERE phone_id = $1", [phone.id, verified, JSON.stringify(verification)]);
  await pool.query(`UPDATE hp_phones SET provisioning_state = CASE WHEN $2 THEN 'provisioned' ELSE 'pending' END,
    sip_registration_status = $3, sip_registration_status_at = NOW(), last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, [phone.id, verified, registered ? "registered" : "not_registered"]);
  await recordProvisioningEvent(pool, { phoneId: phone.id, mac: phone.mac, eventType: "polycom_provisioning_verified", detail: { verified, ...verification } });
  return { ok: true, verified, state: verified ? "provisioned" : "pending", ...verification };
}
