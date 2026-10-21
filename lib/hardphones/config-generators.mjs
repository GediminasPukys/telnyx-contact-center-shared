// Hard Phones Provisioning — vendor config generators (Phase 1)
//
// Generates boot-provisioning config files for Polycom/Poly (XML),
// Yealink (key=value cfg) and AudioCodes (INI cfg) hard phones. Each phone
// registers to Telnyx SIP using its own dedicated credential connection injected here.
//
// File-name conventions handled by the provisioning endpoint:
//   Polycom:    <mac>.cfg (master config) + <mac>-reg.cfg (registration)
//   Yealink:    y000000000000.cfg (common, generic) + <mac>.cfg
//   AudioCodes: <mac>.cfg

export const SUPPORTED_VENDORS = ["polycom", "yealink", "audiocodes"];

export function normalizeMac(raw) {
  const mac = String(raw || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return mac.length === 12 ? mac : null;
}

export function formatMac(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;
  return normalized.match(/.{2}/g).join(":");
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function defaultSipServer(settings = {}) {
  return {
    address: settings.sip_server || "sip.telnyx.com",
    port: Number(settings.sip_port) > 0 ? Number(settings.sip_port) : 5060,
    transport: ["udp", "tcp", "tls"].includes(String(settings.transport || "").toLowerCase())
      ? String(settings.transport).toLowerCase()
      : "udp",
    expires: Number(settings.register_expires) > 0 ? Number(settings.register_expires) : 600,
  };
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function truthySetting(settings, key, fallback = true) {
  if (settings[key] === undefined || settings[key] === null) return fallback;
  return settings[key] !== false && settings[key] !== "false" && settings[key] !== "0";
}

function nonDefaultUrl(value) {
  const text = String(value || "").trim();
  if (!text || text === "vendor-default") return "";
  return text;
}

function cfgEscape(value) {
  return String(value ?? "").replace(/[\r\n]/g, " ").trim();
}

function xmlAttr(value) {
  return xmlEscape(cfgEscape(value));
}

function lineAddress(phone) {
  // Telnyx Credential Connections authenticate REGISTER requests against the
  // credential username. The assigned phone number belongs in CC metadata / UI
  // and as caller-id policy, not in the SIP Address-of-Record used to register
  // the handset. Using the E.164 number here makes Telnyx reject REGISTER with
  // 403 Forbidden before the device can come online.
  return cfgEscape(phone.sip_username || phone.sip_address || "");
}

export function phoneLineLabel(phone) {
  // Directory assignments are display labels; SIP authentication and AoR stay
  // tied to the stable credential identity, never the internal extension.
  const extension = String(phone.extension || "");
  return cfgEscape(phone.label || (/^[1-9][0-9]{2,4}$/.test(extension) ? extension : phone.phone_name || "Telnyx"));
}

export function validatePhoneLineLabel(value, vendor) {
  const label = String(value || "").trim();
  // UCS reg.x.label accepts up to 256 characters. Reject control characters
  // instead of allowing a label to introduce another Yealink/AudioCodes setting.
  const max = vendor === "yealink" ? 99 : 256;
  if (Array.from(label).length > max || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw Object.assign(new Error(`Line label must contain at most ${max} characters and no control characters`), { status: 400 });
  }
  return label || null;
}

const PHONE_TIMEZONE_OFFSETS = {
  UTC: { seconds: 0, yealink: "+0" },
  "Europe/London": { seconds: 0, yealink: "+0" },
  "Europe/Warsaw": { seconds: 3600, yealink: "+1" },
  "Europe/Berlin": { seconds: 3600, yealink: "+1" },
  "Europe/Paris": { seconds: 3600, yealink: "+1" },
  "America/New_York": { seconds: -18000, yealink: "-5" },
  "America/Chicago": { seconds: -21600, yealink: "-6" },
  "America/Denver": { seconds: -25200, yealink: "-7" },
  "America/Los_Angeles": { seconds: -28800, yealink: "-8" },
  "Asia/Dubai": { seconds: 14400, yealink: "+4" },
  "Asia/Singapore": { seconds: 28800, yealink: "+8" },
  "Asia/Tokyo": { seconds: 32400, yealink: "+9" },
  "Australia/Sydney": { seconds: 36000, yealink: "+10" },
};

function yealinkOffset(seconds) {
  const hours = seconds / 3600;
  return hours >= 0 ? `+${hours}` : String(hours);
}

function currentTimezoneOffsetSeconds(timezone, fallback) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const value = parts.find((part) => part.type === "timeZoneName")?.value || "";
    if (value === "GMT" || value === "UTC") return 0;
    const match = value.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) return fallback;
    const sign = match[1] === "-" ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = Number(match[3] || 0);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
    return sign * ((hours * 3600) + (minutes * 60));
  } catch {
    return fallback;
  }
}

function timezoneSetting(settings = {}) {
  const timezone = String(settings.ntp_timezone || "UTC");
  const base = PHONE_TIMEZONE_OFFSETS[timezone] || PHONE_TIMEZONE_OFFSETS.UTC;
  const seconds = currentTimezoneOffsetSeconds(timezone, base.seconds);
  return {
    timezone,
    ...base,
    seconds,
    yealink: yealinkOffset(seconds),
  };
}

function polyLineKeys(settings) {
  return boundedInt(settings.line_keys, 1, 1, 16);
}

// ---------------------------------------------------------------------------
// Polycom / Poly (VVX, Edge E, CCX OpenSIP) — XML
// ---------------------------------------------------------------------------

// <MAC>-phone.cfg is reserved by UCS for local overrides. Never serve the
// managed configuration at that name: overrides have different precedence.
export function polycomMasterConfig() {
  return `<?xml version="1.0" standalone="yes"?>
<APPLICATION APP_FILE_PATH="" CONFIG_FILES="[PHONE_MAC_ADDRESS]-reg.cfg" MISC_FILES="" LOG_FILE_DIRECTORY="" OVERRIDES_DIRECTORY="" CONTACTS_DIRECTORY="" LICENSE_DIRECTORY=""/>
`;
}

export function polycomRegistrationConfig(phone, { baseUrl = "", eventToken = "" } = {}) {
  const settings = phone.settings || {};
  // Keep a persistent NAT mapping for home-agent desktops. Respect an explicit
  // transport policy; otherwise use TCP for this managed desktop profile.
  const server = defaultSipServer({ ...settings, transport: settings.transport || (settings.cti_mode === "desktop_bridge" ? "tcp" : undefined) });
  const transportMap = { udp: "UDPOnly", tcp: "TCPOnly", tls: "TLS" };
  const label = phoneLineLabel(phone);
  const address = lineAddress(phone);
  const lineKeys = polyLineKeys(settings);
  const timezone = timezoneSetting(settings);
  const lines = [
    `<?xml version="1.0" encoding="utf-8" standalone="yes"?>`,
    `<polycomConfig>`,
    `  <reg`,
    `    reg.1.address="${xmlEscape(address)}"`,
    `    reg.1.label="${xmlEscape(label)}"`,
    `    reg.1.displayName="${xmlEscape(label)}"`,
    `    reg.1.auth.userId="${xmlEscape(phone.sip_username)}"`,
    `    reg.1.auth.password="${xmlEscape(phone.sip_password)}"`,
    `    reg.1.server.1.address="${xmlEscape(server.address)}"`,
    `    reg.1.server.1.port="${server.transport === "tls" ? 5061 : server.port}"`,
    `    reg.1.server.1.transport="${transportMap[server.transport]}"`,
    `    reg.1.server.1.expires="${server.expires}"`,
    `    reg.1.server.1.register="1"`,
    `    reg.1.lineKeys="${lineKeys}"/>`,
    `  <nat nat.keepalive.interval="30"/>`,
    `  <prov prov.polling.enabled="${truthySetting(settings, "dynamic_reload", true) ? 1 : 0}" prov.polling.mode="rel" prov.polling.period="3600"/>`,
    `  <tcpIpApp.sntp tcpIpApp.sntp.address="${xmlAttr(settings.sntp_server || "pool.ntp.org")}" tcpIpApp.sntp.gmtOffset="${timezone.seconds}"/>`,
    `  <device.set device.set="1" device.sntp.serverName.set="1" device.sntp.serverName="${xmlAttr(settings.sntp_server || "pool.ntp.org")}" device.sntp.gmtOffset.set="1" device.sntp.gmtOffset="${timezone.seconds}"/>`,
    `  <httpd httpd.enabled="1" apps.restapi.enabled="1"/>`,
  ];
  if (baseUrl && eventToken) {
    // libcurl sends URL userinfo as HTTP Basic authentication. Keeping the
    // credential out of the query prevents proxy and Next request-log leaks.
    const eventUrl = new URL(`/api/provisioning/events/polycom?mac=${phone.mac}`, baseUrl);
    eventUrl.username = phone.mac;
    eventUrl.password = eventToken;
    lines.push(
      `  <apps apps.telNotification.URL="${xmlEscape(eventUrl.toString())}" apps.telNotification.incomingEvent="1" apps.telNotification.outgoingEvent="1" apps.telNotification.callStateChangeEvent="1" apps.telNotification.offhookEvent="1" apps.telNotification.onhookEvent="1"/>`,
    );
  }
  if (phone.admin_password) {
    lines.push(
      `  <device device.set="1" device.auth.localAdminPassword.set="1" device.auth.localAdminPassword="${xmlEscape(phone.admin_password)}"/>`,
    );
  }
  const firmwareUrl = nonDefaultUrl(settings.firmware_source);
  if (firmwareUrl && truthySetting(settings, "automatic_firmware_updates", true)) {
    lines.push(`  <device.prov.upgradeServer device.set="1" device.prov.upgradeServer.set="1" device.prov.upgradeServer="${xmlAttr(firmwareUrl)}"/>`);
  }
  if (settings.syslog_server) {
    lines.push(`  <log log.render.level="3" log.render.file.size="256" log.server.address="${xmlAttr(settings.syslog_server)}"/>`);
  }
  lines.push(`</polycomConfig>`, ``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Yealink (T3x/T4x/T5x) — key=value cfg with #!version header
// ---------------------------------------------------------------------------

export function yealinkCommonConfig({ baseUrl = "" } = {}) {
  const lines = [
    `#!version:1.0.0.1`,
    ``,
    `static.auto_provision.power_on = 1`,
    `static.auto_provision.repeat.enable = 1`,
    `static.auto_provision.repeat.minutes = 60`,
  ];
  if (baseUrl) {
    lines.push(`static.auto_provision.server.url = ${baseUrl}/api/provisioning/`);
  }
  lines.push(``);
  return lines.join("\n");
}

export function yealinkPhoneConfig(phone, { baseUrl = "", credential = null } = {}) {
  const settings = phone.settings || {};
  const server = defaultSipServer(settings);
  const transportMap = { udp: 0, tcp: 1, tls: 2 };
  const label = phoneLineLabel(phone);
  const address = lineAddress(phone);
  const lineKeys = boundedInt(settings.line_keys, 1, 1, 16);
  const timezone = timezoneSetting(settings);
  const legacy = /^(?:SIP-)?T(?:20|22|26|28)P?$/i.test(phone.model || "");
  const provisionPrefix = legacy ? "" : "static.";
  const lines = [
    `#!version:1.0.0.1`,
    ``,
    `account.1.enable = 1`,
    `account.1.label = ${label}`,
    `account.1.display_name = ${label}`,
    `account.1.auth_name = ${phone.sip_username || ""}`,
    `account.1.user_name = ${address}`,
    `account.1.password = ${phone.sip_password || ""}`,
    `account.1.sip_server.1.address = ${server.address}`,
    `account.1.sip_server.1.port = ${server.transport === "tls" ? 5061 : server.port}`,
    `account.1.sip_server.1.transport_type = ${transportMap[server.transport]}`,
    `account.1.sip_server.1.expires = ${server.expires}`,
    `account.1.nat.udp_update_enable = 1`,
    `account.1.nat.udp_update_time = 30`,
    `account.1.nat.rport = 1`,
    `linekey.1.line = 1`,
    `linekey.1.value = 1`,
    `linekey.1.type = 15`,
    `linekey.1.label = ${label}`,
    `features.config_dsskey_length = ${lineKeys}`,
    ``,
    `features.action_uri.enable = ${settings.cti_allow_ip ? 1 : 0}`,
  ];
  if (settings.cti_allow_ip) {
    lines.push(`features.action_uri_limit_ip = ${settings.cti_allow_ip}`);
  }
  if (phone.admin_password) {
    lines.push(`${provisionPrefix}security.user_password = admin:${cfgEscape(phone.admin_password)}`);
  }
  lines.push(
    `local_time.ntp_server1 = ${cfgEscape(settings.sntp_server || "pool.ntp.org")}`,
    `local_time.dhcp_time = ${truthySetting(settings, "timezone_discovery", true) ? 1 : 0}`,
    `local_time.time_zone = ${timezone.yealink}`,
    `auto_provision.repeat.enable = ${truthySetting(settings, "dynamic_reload", true) ? 1 : 0}`,
  );
  if (baseUrl && credential) {
    lines.push(
      `${provisionPrefix}auto_provision.server.url = ${baseUrl}/api/provisioning/`,
      `${provisionPrefix}auto_provision.server.username = ${cfgEscape(credential.username)}`,
      `${provisionPrefix}auto_provision.server.password = ${cfgEscape(credential.password)}`,
      `${provisionPrefix}auto_provision.power_on = 1`,
      `${provisionPrefix}auto_provision.repeat.minutes = 60`,
    );
  }
  const firmwareUrl = nonDefaultUrl(settings.firmware_source);
  if (firmwareUrl && truthySetting(settings, "automatic_firmware_updates", true)) {
    lines.push(`firmware.url = ${cfgEscape(firmwareUrl)}`);
  }
  if (settings.custom_config_url) {
    lines.push(`custom_config.url = ${cfgEscape(settings.custom_config_url)}`);
  }
  if (settings.syslog_server) {
    lines.push(`syslog.mode = 1`, `syslog.server = ${cfgEscape(settings.syslog_server)}`);
  }
  // Legacy V73 notification authentication has not been certified. Keep these
  // callbacks off for that firmware; registration is read from the phone.
  if (baseUrl && !legacy) {
    const ev = (name) => `${baseUrl}/api/provisioning/events/yealink?mac=$mac&ip=$ip&event=${name}&call_id=$call_id&remote=$remote&local=$local`;
    lines.push(
      ``,
      `action_url.registered = ${ev("registered")}`,
      `action_url.unregistered = ${ev("unregistered")}`,
      `action_url.incoming_call = ${ev("incoming_call")}`,
      `action_url.outgoing_call = ${ev("outgoing_call")}`,
      `action_url.call_established = ${ev("call_established")}`,
      `action_url.call_terminated = ${ev("call_terminated")}`,
      `action_url.autop_finish = ${ev("autop_finish")}`,
    );
  }
  lines.push(``);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AudioCodes (405HD/445HD/450HD — Linux UC firmware) — INI cfg
// ---------------------------------------------------------------------------

export function audiocodesPhoneConfig(phone, { baseUrl = "", credential = null } = {}) {
  const settings = phone.settings || {};
  const desktop = settings.cti_mode === "desktop_bridge";
  const controllerHost = desktop ? String(settings.sip_controller_host || "") : process.env.HARDPHONE_SIP_CONTROLLER_HOST || "";
  const controllerPort = Number(desktop ? settings.sip_controller_port || 5070 : process.env.HARDPHONE_SIP_CONTROLLER_PORT || 5070);
  const validController = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(controllerHost)
    && controllerHost.split(".").every(v => Number(v) <= 255)
    && Number.isInteger(controllerPort) && controllerPort >= 1024 && controllerPort <= 65535;
  if (desktop && (!validController || !["420HD","440HD"].includes(phone.model))) throw Error("invalid_desktop_sip_controller");
  const server = defaultSipServer(settings);
  const transportMap = { udp: "UDP", tcp: "TCP", tls: "TLS" };
  const label = phoneLineLabel(phone);
  const address = lineAddress(phone);
  const timezone = timezoneSetting(settings);
  const offsetMinutes = Math.abs(timezone.seconds / 60);
  const offset = `${timezone.seconds < 0 ? "-" : "+"}${String(Math.floor(offsetMinutes / 60)).padStart(2, "0")}:${String(offsetMinutes % 60).padStart(2, "0")}`;
  const lines = [
    `# AudioCodes provisioning — generated for ${formatMac(phone.mac) || phone.mac}`,
    phone.model ? `system/type=${cfgEscape(phone.model)}` : null,
    ``,
    `voip/line/0/enabled=1`,
    `voip/line/0/id=${address}`,
    `voip/line/0/description=${label}`,
    ...(/^(430|440)HD$/i.test(phone.model || "") ? [`voip/line/0/extension_display=${label}`] : []),
    `voip/line/0/auth_name=${phone.sip_username || ""}`,
    `voip/line/0/auth_password=${phone.sip_password || ""}`,
    ``,
    `voip/signalling/sip/use_proxy=1`,
    `voip/signalling/sip/proxy_address=${server.address}`,
    `voip/signalling/sip/proxy_port=${server.transport === "tls" ? 5061 : server.port}`,
    `voip/signalling/sip/use_proxy_ip_port_for_registrar=1`,
    `voip/signalling/sip/transport_protocol=${transportMap[server.transport]}`,
    `voip/signalling/sip/proxy_timeout=${server.expires}`,
    `voip/signalling/sip/registrar_ka/enabled=1`,
    `voip/signalling/sip/registrar_ka/timeout=60`,
    ...((desktop || settings.cti_mode === "sip_controller") && validController ? [
      `voip/signalling/sip/transport_protocol=TCP`,
      ...(desktop ? [`voip/signalling/sip/registration_failed_timeout=15`] : []),
      `voip/signalling/sip/sip_outbound_proxy/enabled=1`,
      `voip/signalling/sip/sip_outbound_proxy/addr=${controllerHost}`,
      `voip/signalling/sip/sip_outbound_proxy/port=${controllerPort}`,
      `voip/talk_event/enabled=1`,
      `voip/dialing/automatic_disconnect=1`,
    ] : [`voip/signalling/sip/sip_outbound_proxy/enabled=0`]),
    // 420HD 2.2.16's "G722" advertises a 16000 Hz RTP clock in its SDP
    // answer, which Telnyx rejects (Q.850 cause 88). G722_8000 retains HD
    // audio with the interoperable RTP clock, as on the validated 440HD.
    ...(/^420HD$/i.test(phone.model || "") ? [
      ["PCMU", 1], ["PCMA", 1], ["G722_8000", 1], ["G729", 1], ["OPUS", 0],
    ].flatMap(([name, enabled], index) => [
      `voip/codec/codec_info/${index}/name=${name}`,
      `voip/codec/codec_info/${index}/enabled=${enabled}`,
      `voip/codec/codec_info/${index}/ptime=20`,
    ]) : []),
    ``,
    `provisioning/method=STATIC`,
    baseUrl ? `provisioning/configuration/url=${baseUrl}/api/provisioning/${phone.mac}.cfg` : null,
    credential ? `provisioning/configuration/http_auth/user_name=${cfgEscape(credential.username)}` : null,
    credential ? `provisioning/configuration/http_auth/password=${cfgEscape(credential.password)}` : null,
    `provisioning/period/type=${truthySetting(settings, "dynamic_reload", true) ? "HOURLY" : "POWERUP"}`,
    `provisioning/period/hourly/hours_interval=1`,
    `voip/services/notify/check_sync/force_reboot_enabled=0`,
    nonDefaultUrl(settings.firmware_source) && truthySetting(settings, "automatic_firmware_updates", true) ? `provisioning/firmware/url=${cfgEscape(nonDefaultUrl(settings.firmware_source))}` : null,
    ``,
    `system/ntp/enabled=1`,
    `system/ntp/primary_server_address=${cfgEscape(settings.sntp_server || "pool.ntp.org")}`,
    `network/lan/dhcp/ntp/gmt_offset/enabled=${truthySetting(settings, "timezone_discovery", true) ? 1 : 0}`,
    `network/lan/dhcp/ntp/server_list/enabled=0`,
    `system/ntp/gmt_offset=${offset}`,
    `system/daylight_saving/activate=DISABLE`,
    ``,
    `voip/auto_answer/enabled=1`,
    settings.syslog_server ? `system/syslog/server_address=${cfgEscape(settings.syslog_server)}` : null,
    phone.admin_password ? `system/password=${phone.admin_password}` : null,
    ``,
  ].filter((line) => line !== null);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Request resolution — map a requested provisioning filename to vendor +
// file kind. Returns null for unrecognized names.
// ---------------------------------------------------------------------------

export function resolveProvisioningRequest(filename) {
  const name = String(filename || "").toLowerCase();

  // Yealink common config: y000000000000.cfg (and model-family variants y0000000000XX.cfg)
  if (/^y0{10}[0-9a-f]{2}\.cfg$/.test(name)) {
    return { vendor: "yealink", kind: "common", mac: null };
  }
  // Polycom per-MAC registration file: <mac>-reg.cfg
  let match = name.match(/^([0-9a-f]{12})-reg\.cfg$/);
  if (match) return { vendor: "polycom", kind: "registration", mac: match[1] };
  // Polycom per-MAC phone/device file: <mac>-phone.cfg. VVX firmware may
  // request this even when the master file also references -reg.cfg.
  match = name.match(/^([0-9a-f]{12})-phone\.cfg$/);
  if (match) return { vendor: "polycom", kind: "phone", mac: match[1] };
  // Polycom default master config — we intentionally do NOT serve
  // 000000000000.cfg (unknown phones stay unprovisioned).
  if (name === "000000000000.cfg") {
    return { vendor: "polycom", kind: "default-master", mac: null };
  }
  // Per-MAC .cfg — vendor decided by inventory lookup (Polycom master,
  // Yealink MAC cfg and AudioCodes MAC cfg all use <mac>.cfg).
  match = name.match(/^([0-9a-f]{12})\.cfg$/);
  if (match) return { vendor: null, kind: "mac-config", mac: match[1] };

  return null;
}

function withRuntimeAdminPassword(phone) {
  const runtimeAdminPassword = String(process.env.TELNYX_PHONE_ADMIN_PASSWORD || "").trim();
  if (!runtimeAdminPassword) return phone;
  return { ...phone, admin_password: runtimeAdminPassword };
}

// Build the served file body for a phone given the request kind.
export function buildConfigForPhone(phone, kind, { baseUrl = "", eventToken = "", credential = null } = {}) {
  phone = withRuntimeAdminPassword(phone);
  const vendor = String(phone.vendor || "").toLowerCase();
  if (vendor === "polycom") {
    if (kind === "registration") return { contentType: "text/xml", body: polycomRegistrationConfig(phone, { baseUrl, eventToken }) };
    if (kind === "mac-config") return { contentType: "text/xml", body: polycomMasterConfig() };
    return null;
  }
  if (vendor === "yealink") {
    if (kind !== "mac-config") return null;
    return { contentType: "text/plain", body: yealinkPhoneConfig(phone, { baseUrl, credential }) };
  }
  if (vendor === "audiocodes") {
    if (kind !== "mac-config") return null;
    return { contentType: "text/plain", body: audiocodesPhoneConfig(phone, { baseUrl, credential }) };
  }
  return null;
}

// Heuristic vendor detection from the provisioning HTTP User-Agent. Used to
// flag mismatches and enrich the event log; inventory vendor stays canonical.
export function vendorFromUserAgent(userAgent) {
  const ua = String(userAgent || "").toLowerCase();
  if (!ua) return null;
  if (ua.includes("polycom") || ua.includes("polyedge") || ua.includes("poly/")) return "polycom";
  if (ua.includes("yealink")) return "yealink";
  if (ua.includes("audiocodes") || ua.includes("400hd") || ua.includes("445hd") || ua.includes("450hd") || ua.includes("405hd")) return "audiocodes";
  return null;
}
