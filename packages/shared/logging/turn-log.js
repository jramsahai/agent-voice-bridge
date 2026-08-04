// One structured stdout line per completed turn (OPS-01). The record is built as a fixed
// object literal with a fixed key set — it never spreads the caller's argument object into
// the record — which is what structurally guarantees no credential material and no
// transcript/reply text can ever reach this line. That guarantee is stronger than any
// runtime field-name check would be: there is no field to accidentally forward, because
// nothing is ever forwarded.

export const TURN_LOG_EVENT = 'turn';
export const TURN_OUTCOMES = Object.freeze({ OK: 'ok', ERROR: 'error', ABORTED: 'aborted' });

export function logTurnCompletion({ client, outcome, durationsMs = {}, errorCode = null }) {
  const record = {
    event: TURN_LOG_EVENT,
    ts: new Date().toISOString(),
    client,
    outcome,
    errorCode,
    durationsMs: {
      transcribe: durationsMs.transcribe ?? null,
      agent: durationsMs.agent ?? null,
      speak: durationsMs.speak ?? null,
    },
  };
  // Machine-readable JSON, not prose — deliberately not using the '[voice-bridge]'
  // console.error prefix convention this codebase uses elsewhere for human-facing log lines.
  console.log(JSON.stringify(record));
}
