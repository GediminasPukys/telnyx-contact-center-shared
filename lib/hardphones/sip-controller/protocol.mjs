// Bounded SIP/TCP framing. Never log frames: REGISTER contains credentials.
export function decodeSipFrames(buffer) {
  const messages = [];
  while (buffer.length) {
    // RFC 5626 keepalives are separate from SIP messages.
    if (buffer.subarray(0, 2).toString() === '\r\n') { buffer = buffer.subarray(2); continue; }
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) { if (buffer.length > 65536) throw Error('sip_headers_too_large'); break; }
    const lines = buffer.subarray(0, end).toString().split('\r\n');
    const headers = lines.slice(1).map(line => {
      const colon = line.indexOf(':');
      if (colon < 1 || /^[ \t]/.test(line)) throw Error('invalid_sip_header');
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    });
    const lengths = headers.filter(([k]) => /^(content-length|l)$/i.test(k));
    if (lengths.length !== 1 || !/^\d+$/.test(lengths[0][1])) throw Error('invalid_sip_length');
    const length = Number(lengths[0][1]);
    if (end > 65536 || length > 262144) throw Error('sip_message_too_large');
    if (buffer.length < end + 4 + length) break;
    messages.push({ start: lines[0], headers, body: buffer.subarray(end + 4, end + 4 + length).toString() });
    buffer = buffer.subarray(end + 4 + length);
  }
  return { messages, buffer };
}
const aliases = { via: 'v', from: 'f', to: 't', 'call-id': 'i', contact: 'm', 'content-type': 'c', 'content-length': 'l' };
export const header = (m, name) => m.headers.find(([key]) => key.toLowerCase() === name || key.toLowerCase() === aliases[name])?.[1] || '';
export function setHeader(m, name, value) {
  const index = m.headers.findIndex(([key]) => key.toLowerCase() === name.toLowerCase() || key.toLowerCase() === aliases[name.toLowerCase()]);
  if (index < 0) m.headers.push([name, String(value)]); else m.headers[index][1] = String(value);
}
export function encodeSip(m) {
  setHeader(m, 'Content-Length', Buffer.byteLength(m.body || ''));
  return `${m.start}\r\n${m.headers.map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${m.body || ''}`;
}
export const cseq = m => { const [number, method] = header(m, 'cseq').split(/\s+/); return { number: Number(number), method }; };
export const responseCode = m => /^SIP\/2.0 (\d{3})\b/.test(m.start) ? Number(m.start.split(' ')[1]) : 0;
export const tag = value => value.match(/;tag=([^;\s]+)/)?.[1] || '';
export const uri = value => value.match(/<([^>]+)>/)?.[1] || value.split(';')[0];
export const direction = sdp => sdp.match(/^a=(sendrecv|sendonly|recvonly|inactive)\r?$/m)?.[1] || 'sendrecv';
export function withDirection(sdp, value, version) {
  if (!/^m=audio /m.test(sdp)) throw Error('audio_sdp_required');
  return sdp.replace(/^o=(\S+ \S+) \d+/m, `o=$1 ${version}`).replace(/^a=(sendrecv|sendonly|recvonly|inactive)\r?\n/gm, '') + `a=${value}\r\n`;
}
// Retransmissions keep their mapping. ACK/CANCEL must use the INVITE sequence.
export class SequenceSpace {
  high = 0;
  forward = new Map();
  reverse = new Map();
  translate(number, method) {
    const key = `${number} ${['ACK','CANCEL'].includes(method) ? 'INVITE' : method}`;
    if (!this.forward.has(key)) {
      this.high = Math.max(this.high + 1, number);
      this.forward.set(key, this.high); this.reverse.set(`${this.high} ${method}`, number);
      if (this.forward.size > 2048) throw Error('sip_dialog_sequence_limit');
    }
    return this.forward.get(key);
  }
  allocate() { return ++this.high; }
  original(number, method) { return this.reverse.get(`${number} ${method}`); }
}
