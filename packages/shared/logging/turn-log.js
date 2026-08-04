// One structured stdout line per completed turn (OPS-01). The record is built as a fixed
// object literal with a fixed key set — it never spreads the caller's argument object into
// the record — which is what structurally guarantees no credential material and no
// transcript/reply text can ever reach this line. That guarantee is stronger than any
// runtime field-name check would be: there is no field to accidentally forward, because
// nothing is ever forwarded.

export const TURN_LOG_EVENT = 'turn';
export const TURN_OUTCOMES = Object.freeze({ OK: 'ok', ERROR: 'error', ABORTED: 'aborted' });

const VALID_OUTCOMES = new Set(Object.values(TURN_OUTCOMES));

// D-07: a stage that never ran logs null; a stage that ran and took under a millisecond logs
// the number 0. Those are different facts, so this coerces anything that is not itself a
// finite number (undefined, NaN, a string, an object) to null rather than letting a
// non-numeric value leak onto the wire.
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function logTurnCompletion({ client, outcome, durationsMs = {}, errorCode = null }) {
  const record = {
    event: TURN_LOG_EVENT,
    ts: new Date().toISOString(),
    client,
    // An outcome this module does not recognise is written as the error outcome rather than
    // echoed onto the wire verbatim — the vocabulary a log consumer can rely on is exactly
    // TURN_OUTCOMES, never an arbitrary caller-supplied string.
    outcome: VALID_OUTCOMES.has(outcome) ? outcome : TURN_OUTCOMES.ERROR,
    errorCode,
    durationsMs: {
      transcribe: finiteOrNull(durationsMs.transcribe),
      agent: finiteOrNull(durationsMs.agent),
      speak: finiteOrNull(durationsMs.speak),
    },
  };
  // Machine-readable JSON, not prose — deliberately not using the '[voice-bridge]'
  // console.error prefix convention this codebase uses elsewhere for human-facing log lines.
  console.log(JSON.stringify(record));
}
