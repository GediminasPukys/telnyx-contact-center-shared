// Desktop workers have no server log store, PostgreSQL or cloud archive.
// Keep diagnostic event names, but never log phone credentials or payloads.
export function createDiagnosticLogger(scope) {
  return Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level,
    message => console[level](JSON.stringify({scope, level, event: String(message)})),
  ]));
}
