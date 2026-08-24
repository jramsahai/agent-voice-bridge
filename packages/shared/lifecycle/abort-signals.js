// WR-02: dependency-free home for composeAbortSignals. Extracted out of
// packages/shared/adapters/tts-kokoro-onnx.js so that module and
// packages/shared/health/probes.js — which both need signal composition — never have to
// import from each other. Before this move, probes.js imported composeAbortSignals from
// tts-kokoro-onnx.js while tts-kokoro-onnx.js imported probeHttpService from probes.js: a
// genuine module cycle that happened not to break only because composeAbortSignals was a
// hoisted function declaration. This file imports nothing, so it can never be part of a
// cycle itself.

// Composes any number of possibly-undefined AbortSignals into one that aborts when any of
// them does, using the standard library's own composition rather than hand-rolled listener
// bookkeeping. A caller's signal must never simply replace an existing timeout-derived
// signal — dropping the timeout would turn a downed backend from a fast failure into a
// hang, the fixed per-turn penalty OPS-05 exists to remove.
export function composeAbortSignals(...signals) {
  const present = signals.filter(Boolean);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}
