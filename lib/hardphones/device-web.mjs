import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { isIP } from "node:net";

// Self-signed handset certificates use an enrolled SHA256 pin instead of a CA.
// Callers may omit the pin ONLY for a credential-free discovery request.
export function createDeviceTlsAgent({ host, port = 443, fingerprint }) {
  if (!isIP(host || '')) throw new Error('invalid_phone_ip');
  if (fingerprint && !/^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(fingerprint)) throw new Error('invalid_certificate_pin');
  const agent = new https.Agent(), sockets = new Set();
  const destroy = agent.destroy.bind(agent);
  agent.destroy = () => { for (const socket of sockets) socket.destroy(); destroy(); };
  agent.createConnection = (_options, callback) => {
    // CA verification cannot authenticate a self-signed handset. The socket is
    // withheld from HTTP until its exact enrolled fingerprint has been checked.
    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('error', callback);
    socket.once('secureConnect', () => {
      const observed = socket.getPeerCertificate()?.fingerprint256;
      if (!observed || (fingerprint && observed.toUpperCase() !== fingerprint.toUpperCase())) {
        socket.destroy(new Error('certificate_changed'));
      } else {
        socket.removeListener('error', callback);
        callback(null, socket);
      }
    });
  };
  return agent;
}

// Device management is confined to an inventory IP. Redirects are never followed;
// an enrolled certificate is checked before releasing credentials to the socket.
export function deviceWebRequest(phone, path, { method = "GET", headers = {}, body = null, timeoutMs = 12000 } = {}) {
  const host = phone.ip_address || phone.last_ip;
  if (!isIP(host || "") || !path.startsWith("/") || path.startsWith("//")) throw new Error("invalid_phone_ip");
  const legacyHttp = phone.settings?.management_protocol === "http";
  const transport = legacyHttp ? http : https;
  const payload = body == null ? null : Buffer.from(body);
  const fingerprint = phone.certificate_fingerprint;
  // Initial TOFU discovery never carries credentials, cookies or a form body.
  if (!legacyHttp && !fingerprint && (!['GET', 'HEAD'].includes(method) || Object.keys(headers).length || body != null)) {
    throw new Error('certificate_required');
  }
  return new Promise((resolve, reject) => {
    const agent = legacyHttp ? new http.Agent() : createDeviceTlsAgent({ host, fingerprint });
    const request = transport.request({
      host, port: legacyHttp ? 80 : 443, path, method, agent,
      headers: { ...headers, ...(payload ? { "Content-Length": payload.length } : {}) },
    }, response => {
      const certificateFingerprint = response.socket?.getPeerCertificate?.()?.fingerprint256 || null;
      const chunks = []; let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(new Error("response_too_large"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers,
        raw: Buffer.concat(chunks).toString("utf8"), certificateFingerprint }));
    });
    const timer = setTimeout(() => {
      const error = new Error("request_timeout");
      // A TLS handshake may stall before Agent has assigned the request socket.
      // Destroy that pending socket too, so the deadline really is bounded.
      request.destroy(error); agent.destroy(); reject(error);
    }, timeoutMs);
    request.once("close", () => { clearTimeout(timer); agent.destroy(); });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export function decodeDeviceHtml(value) {
  return String(value || "").replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

export function deviceAttributes(tag) {
  const values = {};
  for (const m of tag.matchAll(/([-\w]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) values[m[1].toLowerCase()] = decodeDeviceHtml(m[2] ?? m[3] ?? m[4]);
  return values;
}

// Preserve unrelated form settings, without evaluating device-supplied scripts.
export function readDeviceForm(html, name) {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  const form = forms.find(m => deviceAttributes(m[1]).name === name);
  if (!form) throw new Error("unsupported_device_form");
  const fields = new URLSearchParams();
  for (const m of form[2].matchAll(/<input\b[^>]*>/gi)) {
    const a = deviceAttributes(m[0]), type = (a.type || "text").toLowerCase();
    if (!a.name || ["button", "submit", "image", "file", "reset"].includes(type)) continue;
    if (["radio", "checkbox"].includes(type) && !/\bchecked(?:\s|=|>)/i.test(m[0])) continue;
    fields.set(a.name, a.value ?? (type === "checkbox" ? "on" : ""));
  }
  for (const m of form[2].matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = deviceAttributes(m[1]).name;
    const choices = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/option>|$)/gi)];
    const selected = choices.find(c => /\bselected(?:\s|=|$)/i.test(c[1])) || choices[0];
    if (name && selected) fields.set(name, deviceAttributes(selected[1]).value ?? decodeDeviceHtml(selected[2]).trim());
  }
  return fields;
}

export function deviceCookie(headers) {
  const values = headers["set-cookie"] || [];
  return (Array.isArray(values) ? values : [values]).map(v => v.split(";")[0]).join("; ");
}

// Inventory text extraction, not an HTML rendering/sanitization API.
export function deviceTableText(html, label) {
  const cell = String(html).match(new RegExp(`${label}\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i'))?.[1] || '';
  let result = '', inTag = false;
  for (const character of decodeDeviceHtml(cell)) {
    if (character === '<') inTag = true;
    else if (character === '>') inTag = false;
    else if (!inTag) result += character;
  }
  return result.trim();
}
