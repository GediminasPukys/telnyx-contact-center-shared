// Hard Phones CTI — Poly/Polycom REST API driver (Phase 2)
//
// Native CTI for compatible UCS REST endpoints. The physical test fixture is
// VVX 300 / UCS 5.9.8.5760; newer PVOS authentication needs separate certification.
// HTTP Basic over HTTPS; enrollment pins the self-signed device certificate.
//
// Status convention: {"Status":"2000"} = success. Notable codes:
//   4001 device busy · 4002 line not registered · 4007 call doesn't exist ·
//   4010 default admin password still set (call control blocked)
import { createDiagnosticLogger } from "../../diagnostic-logger.mjs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createDeviceTlsAgent } from "../device-web.mjs";

const ctiLogger = createDiagnosticLogger("contact-center.hardphone-cti");

const POLY_USER = "Polycom";

const POLY_ERRORS = {
  4000: "Invalid parameters",
  4001: "Device busy",
  4002: "Line not registered",
  4003: "Operation not allowed",
  4004: "Operation not supported",
  4005: "Line does not exist",
  4007: "Call does not exist",
  4009: "Input size exceeded",
  4010: "Default admin password must be changed",
  5000: "Internal phone failure",
};

async function requestOnce(url, method, headers, body, fingerprint, timeoutMs = 6000) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  if (target.protocol === "https:" && !fingerprint && (Object.keys(headers).length || body || method !== "GET")) {
    // Capture the certificate without sending credentials, then pin the
    // authenticated request. A certificate swap between connections fails closed.
    const probe = await requestOnce(url, "GET", {}, null, null, timeoutMs);
    if (!probe.fingerprint) throw new Error("certificate_required");
    fingerprint = probe.fingerprint;
  }
  return new Promise((resolve, reject) => {
    const agent = target.protocol === "https:" ? createDeviceTlsAgent({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443), fingerprint }) : undefined;
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: payload ? { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : headers,
      timeout: timeoutMs,
      agent,
    }, (res) => {
      let raw = "";
      const peerFingerprint = res.socket?.getPeerCertificate?.()?.fingerprint256 || null;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 1024 * 1024) req.destroy(new Error("response_too_large"));
      });
      res.on("error", reject);
      res.on("end", () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        resolve({
          response: { status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300 },
          data,
          fingerprint: peerFingerprint,
        });
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("request_timeout")), timeoutMs);
    req.once("close", () => { clearTimeout(deadline); agent?.destroy(); });
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function normalizePolyResponse(response, data) {
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "auth_failed", httpStatus: response.status, definitive:true };
  }
  const status = String(data?.Status || "");
  if (response.ok && status === "2000") return { ok: true, data };
  const reason = POLY_ERRORS[Number(status)] || `HTTP ${response.status}`;
  return { ok: false, reason, polyStatus: status || null, httpStatus: response.status, data, definitive:Number(status)>=4000&&Number(status)<5000 };
}

function shouldRetryPolyOverHttp(response, data) {
  if (!response) return true;
  if (response.status === 401 || response.status === 403) return false;
  const status = String(data?.Status || "");
  if (status) return false;
  // Some VVX firmware exposes the web UI on HTTPS but the UCS REST API only on
  // HTTP. In that case HTTPS answers with an HTML 404 instead of failing the
  // connection, so a catch-only fallback incorrectly reports the phone as down.
  return response.status === 404 || response.status === 405 || response.status === 501;
}

const deviceRequests = new Map();
export async function polyRequest(phone, method, path, body = null) {
  // UCS only processes one REST request at a time. Serialize across callers
  // in this process, including status polling while a command is in flight.
  const key = phone.last_ip || phone.ip_address;
  const previous = deviceRequests.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => requestPolyDevice(phone, method, path, body));
  deviceRequests.set(key, pending);
  try { return await pending; }
  finally { if (deviceRequests.get(key) === pending) deviceRequests.delete(key); }
}

async function requestPolyDevice(phone, method, path, body = null) {
  const host = phone.last_ip || phone.ip_address;
  if (!host) return { ok: false, reason: "no_phone_ip" };
  // Provisioning callbacks cannot supply a URL, port, credentials or path.
  if (!isIP(host)) return { ok: false, reason: "invalid_phone_ip" };
  const headers = {
    Authorization: "Basic " + Buffer.from(`${POLY_USER}:${phone.admin_password || ""}`).toString("base64"),
    "Content-Type": "application/json",
  };

  let first;
  try {
    first = await requestOnce(`https://${isIP(host) === 6 ? `[${host}]` : host}${path}`, method, headers, body, phone.certificate_fingerprint, path.startsWith("/api/v1/mgmt/config/") ? 20000 : 6000);
    if (!shouldRetryPolyOverHttp(first.response, first.data) || phone.settings?.allow_http_cti !== true) {
      return { ...normalizePolyResponse(first.response, first.data), certificate_fingerprint: first.fingerprint };
    }
  } catch (err) {
    first = { error: err };
  }

  // Never retry a timed-out mutation: it may already have dialed or rebooted.
  // HTTP is an explicit legacy setting, never an automatic credential downgrade.
  if (phone.settings?.allow_http_cti !== true || (method !== "GET" && first.error) || first.error?.message === "certificate_changed") {
    return { ok: false, reason: first.error?.message === "certificate_changed" ? "certificate_changed" : "phone_unreachable", error: first.error?.code || first.error?.message, uncertain: method !== "GET" && Boolean(first.error) };
  }

  try {
    const fallback = await requestOnce(`http://${host}${path}`, method, headers, body);
    return normalizePolyResponse(fallback.response, fallback.data);
  } catch (innerErr) {
    const error = innerErr?.message || first?.error?.message || String(innerErr || first?.error || "request_failed");
    ctiLogger.warn("poly_request_failed", { path, error });
    return { ok: false, reason: "phone_unreachable", error };
  }
}

// Fetch active call references — needed for answer/end/hold which operate
// on a call Ref handle.
async function readCallStatus(phone, request) {
  // v2 reports every call and microphone mute state; v1 only reports the
  // foreground call on some UCS builds. Fall back only for unsupported APIs.
  const result = await request(phone, "GET", "/api/v2/webCallControl/callStatus");
  if (result.httpStatus === 404 || result.polyStatus === "4004") return request(phone, "GET", "/api/v1/webCallControl/callStatus");
  return result;
}

async function activeCallRef(phone, options = {}, request = polyRequest) {
  const result = await readCallStatus(phone, request);
  if (result.polyStatus === "4007") return { error: { ok: false, reason: "no_active_call" } };
  if (!result.ok) return { error: result };
  const payload = result.data?.data;
  const calls = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const active = calls.filter((c) => (c?.Ref || c?.CallHandle) && !/idle|disconnect|ended/i.test(c.CallState || ""));
  if (!options.callRef && active.length > 1) return { error: { ok: false, reason: "ambiguous_call", calls: active } };
  const call = options.callRef ? active.find(c => String(c.Ref || c.CallHandle) === String(options.callRef)) : active[0];
  return call ? { ref: call.Ref || call.CallHandle, state: call.CallState || null, type: call.Type || null } : { error: { ok: false, reason: "no_active_call" } };
}

function isHeldCall(call) {
  return /hold|held/i.test(String(call?.state || ""));
}

export function createPolycomDriver(request = polyRequest) {
return {
  vendor: "polycom",

  async dial(phone, number) {
    if (typeof number !== "string" || !number.trim() || number.length > 256 || /[\s<>"\\\r\n]/.test(number)) return { ok: false, reason: "invalid_destination" };
    // VVX treats Type: "SIP" as a SIP-URI dial and prefixes the destination
    // with `sip:` (for example `sip:+486...`), which can disconnect before the
    // INVITE reaches Telnyx Call Control. For PSTN-style dialing, send the raw
    // destination and let the configured line/server route it as a telephone
    // number. This yields Proceeding/RingBack/Connected states on VVX300.
    const sipUri = /^sip:/i.test(number);
    return request(phone, "POST", "/api/v1/callctrl/dial", { data: { Dest: sipUri ? number.slice(4) : number, Line: "1", ...(sipUri ? { Type: "SIP" } : {}) } });
  },

  async answer(phone, options) {
    const call = await activeCallRef(phone, options, request);
    if (call.error) return call.error;
    return request(phone, "POST", "/api/v1/callctrl/answerCall", { data: { Ref: call.ref } });
  },

  async hangup(phone, options) {
    const call = await activeCallRef(phone, options, request);
    if (call.error) return call.error;
    const result = await request(phone, "POST", "/api/v1/callctrl/endCall", { data: { Ref: call.ref } });
    if (!result.ok && !result.uncertain && result.polyStatus === "4003" && isHeldCall(call)) {
      await request(phone, "POST", "/api/v1/callctrl/resumeCall", { data: { Ref: call.ref } });
      return request(phone, "POST", "/api/v1/callctrl/endCall", { data: { Ref: call.ref } });
    }
    return result;
  },

  async hold(phone, options) {
    const call = await activeCallRef(phone, options, request);
    if (call.error) return call.error;
    return request(phone, "POST", "/api/v1/callctrl/holdCall", { data: { Ref: call.ref } });
  },

  async resume(phone, options) {
    const call = await activeCallRef(phone, options, request);
    if (call.error) return call.error;
    return request(phone, "POST", "/api/v1/callctrl/resumeCall", { data: { Ref: call.ref } });
  },

  async mute(phone, state = true, options) {
    const call = await activeCallRef(phone, options, request);
    if (call.error) return call.error;
    if (isHeldCall(call)) return { ok: false, reason: "mute_not_allowed_while_held", polyStatus: "4003" };
    return request(phone, "POST", "/api/v1/callctrl/mute", { data: { state: state ? "1" : "0" } });
  },

  async sendDtmf(phone, digits, options) {
    if (typeof digits !== "string" || !/^[0-9A-D*#]{1,32}$/.test(digits)) return { ok: false, reason: "invalid_dtmf" };
    const call = await activeCallRef(phone, options, request);
    if (call.error) return call.error;
    if (isHeldCall(call)) return { ok: false, reason: "dtmf_not_allowed_while_held" };
    return request(phone, "POST", "/api/v1/callctrl/sendDTMF", { data: { Digits: String(digits) } });
  },

  async status(phone) {
    const callStatus = await readCallStatus(phone, request);
    const lineInfo = await request(phone, "GET", "/api/v1/mgmt/lineInfo");
    // UCS 5.9 returns 4007 (with HTTP 200) for an idle phone.
    const callsKnown = callStatus.ok || callStatus.polyStatus === "4007";
    return {
      ok: callsKnown && lineInfo.ok,
      reachable: callStatus.ok || lineInfo.ok,
      call: callStatus.ok ? (callStatus.data?.data ?? null) : null,
      line: lineInfo.ok ? (lineInfo.data?.data ?? null) : null,
      reason: callsKnown && lineInfo.ok ? undefined : (callsKnown ? lineInfo.reason : callStatus.reason),
      error: callsKnown && lineInfo.ok ? undefined : (callsKnown ? lineInfo.error : callStatus.error),
      certificate_fingerprint: lineInfo.certificate_fingerprint || callStatus.certificate_fingerprint,
    };
  },

  async deviceInfo(phone) { return request(phone, "GET", "/api/v1/mgmt/device/info"); },
  async getConfig(phone, names) { return request(phone, "POST", "/api/v1/mgmt/config/get", { data: names }); },
  async setConfig(phone, parameters) { return request(phone, "POST", "/api/v1/mgmt/config/set", { data: parameters }); },

  // Force config re-download (UCS 5.9+) — used by "Re-provision now".
  async reprovision(phone) {
    return request(phone, "POST", "/api/v1/mgmt/updateConfiguration", {});
  },

  // Remote reboot through the Poly UCS/PVOS REST management API.
  async reboot(phone) {
    return request(phone, "POST", "/api/v1/mgmt/safeReboot", {});
  },
};

}

export const polycomDriver = createPolycomDriver();
