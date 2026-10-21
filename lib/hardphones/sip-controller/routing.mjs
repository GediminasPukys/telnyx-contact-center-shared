import { cseq, header, responseCode, tag, uri } from './protocol.mjs';

const localUri = (host, port) => `sip:${host}:${port};lr;transport=tcp`;
// AudioCodes can reorder URI parameters when echoing Record-Route. Match the
// transport endpoint, not the serialization of ";lr;transport=tcp".
const isLocal = (value, host, port) => {
  const address = uri(value).replace(/^sips?:/i, '').split(';')[0];
  return address.toLowerCase() === `${host}:${port}`.toLowerCase();
};
// The handset must send its own in-dialog requests through this controller,
// even when the provider has supplied a Record-Route set.
export function anchorPhoneRoute(message, host, port) {
  if (cseq(message).method !== 'INVITE') return message;
  const code = responseCode(message);
  if ((!code && tag(header(message, 'to'))) || (code && (code < 180 || code >= 300))) return message;
  const route = localUri(host, port);
  if (message.headers.some(([k, v]) => k.toLowerCase() === 'record-route' && v.split(/,(?=\s*<)/).some(part=>isLocal(part.trim(),host,port)))) return message;
  // UAS uses request order; UAC reverses the response order.
  if (code) message.headers.push(['Record-Route', `<${route}>`]);
  else message.headers.unshift(['Record-Route', `<${route}>`]);
  return message;
}

export function removeLocalRoute(message, host, port) {
  message.headers = message.headers.flatMap(([name, value]) => {
    if (!['route', 'record-route'].includes(name.toLowerCase())) return [[name, value]];
    const remaining = value.split(/,(?=\s*<)/).filter(part => !isLocal(part.trim(),host,port));
    return remaining.length ? [[name, remaining.join(',')]] : [];
  });
  return message;
}
