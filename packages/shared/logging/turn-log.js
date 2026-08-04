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
  // WR-05: the default parameter above only applies when the argument is `undefined` — a
  // call passing `durationsMs: null` explicitly still crashes below without this guard.
  // Every current call site in request-handler.js already defends this exact case with
  // `?? {}` before calling logTurn, which is a strong signal null is a live possibility on
  // this path; this module is meant to be the single crash-proof source of truth for this
  // log line, so it must not depend on every caller remembering that same guard.
  const durations = durationsMs ?? {};
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
      transcribe: finiteOrNull(durations.transcribe),
      agent: finiteOrNull(durations.agent),
      speak: finiteOrNull(durations.speak),
    },
  };
  // Machine-readable JSON, not prose — deliberately not using the '[voice-bridge]'
  // console.error prefix convention this codebase uses elsewhere for human-facing log lines.
  console.log(JSON.stringify(record));
}
