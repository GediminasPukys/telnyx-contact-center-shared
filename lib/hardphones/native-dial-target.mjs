// Destinations accepted by a phone, not URLs or arbitrary Action URI commands.
export function nativeDialTarget(value) {
  if (typeof value !== 'string' || value.length > 256) throw Error('invalid_native_destination');
  const number=value.trim();
  if (/^\+?\d{3,15}$/.test(number)) return number;
  if (/^sip:[a-zA-Z0-9_.+%-]+@[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(number)) return number;
  throw Error('invalid_native_destination');
}
export function sameNativeDestination(observed, expected) {
  const canonical=value=>String(value||'').replace(/^sips?:/i,'').toLowerCase();
  const a=canonical(observed),b=canonical(expected);
  return a===b || (/^\+?\d{3,15}$/.test(b) && a.split('@')[0]===b);
}
