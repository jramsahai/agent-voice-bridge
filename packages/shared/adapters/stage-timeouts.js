// Named home for the two subprocess-stage execFile ceilings that must both resolve before
// POST /v1/turn writes its first response byte: transcription (stt-whisper-local.js) and the
// agent call (the agent-*.js adapters). These two numbers are the derivation basis for the published
// minimum client read timeout (packages/shared/transport/read-timeout.js) — a document stating
// that floor stays true only if both adapters actually read their execFile timeout from here
// rather than from an inline literal.
//
// Deliberately no speech-stage constant: the speech (TTS) stage runs after the response head
// and text preamble are already on the wire, so it is outside the floor a client's read
// timeout must clear.

export const TRANSCRIBE_TIMEOUT_MS = 120000;
export const AGENT_TIMEOUT_MS = 180000;
