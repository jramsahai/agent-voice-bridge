// The published minimum client read (inactivity) timeout for POST /v1/turn — not a
// total-duration budget. It is the worst-case gap a spec-compliant server may legally leave
// between the request being fully sent and the first response byte arriving, because the
// response head is written only after both the transcribe and agent stages resolve (the
// speech/TTS stage runs after that first byte is already on the wire). The measured typical
// case is 5.4-10.3 seconds per docs/API.md — that is the
// typical experience, not the floor (D-01).
//
// Computed as the sum of the two stage ceilings, never a typed literal: raising either ceiling
// in stage-timeouts.js raises this floor automatically, with no second edit to remember.

import { TRANSCRIBE_TIMEOUT_MS, AGENT_TIMEOUT_MS } from '../adapters/stage-timeouts.js';

export const MIN_CLIENT_READ_TIMEOUT_MS = TRANSCRIBE_TIMEOUT_MS + AGENT_TIMEOUT_MS;
