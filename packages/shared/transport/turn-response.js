// Pure response-head shaping for POST /v1/turn — locked framing (checkpoint decision,
// option-a): the client learns the transcript and reply byte lengths from response headers,
// computed before the first res.write() of any kind, so it never needs in-band framing to
// find the audio start offset. This module must contain no reference to a ServerResponse, a
// socket, or `res` anywhere — mirroring the decision-logic/IO split convert.js and
// server.js already keep. apps/voice-bridge/request-handler.js is the only place that
// actually writes any of this to a real response.

import { MAX_PCM_BYTES } from '../audio/wav.js';

export const API_VERSION = '1';
export const TRANSCRIPT_BYTES_HEADER = 'X-Voice-Transcript-Bytes';
export const REPLY_BYTES_HEADER = 'X-Voice-Reply-Bytes';
export const AUDIO_PRESENT_HEADER = 'X-Voice-Audio-Present';
export const OUTPUT_FORMAT_RESPONSE_HEADER = 'X-Voice-Output-Format';

// One named ceiling rather than a second magic number alongside wav.js's own
// MAX_PCM_BYTES. A container input's header bytes count toward this same ceiling — it is a
// ceiling on the whole raw request body, not just the PCM payload inside it. Enforced by
// apps/voice-bridge/request-handler.js's streaming body-read cap (plan 03-04).
export const MAX_REQUEST_AUDIO_BYTES = MAX_PCM_BYTES;

// transcriptBuffer/replyBuffer are Buffer.from(text, 'utf8') — their .length is a UTF-8
// byte count, not a character count, which is exactly what a multi-byte reply needs the
// client to read off the header rather than assume from string length.
export function buildTurnResponseHead({ transcript, reply, outputFormatId, audioPresent }) {
  const transcriptBuffer = Buffer.from(transcript, 'utf8');
  const replyBuffer = Buffer.from(reply, 'utf8');

  return {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-transform',
      'X-API-Version': API_VERSION,
      [TRANSCRIPT_BYTES_HEADER]: String(transcriptBuffer.length),
      [REPLY_BYTES_HEADER]: String(replyBuffer.length),
      [OUTPUT_FORMAT_RESPONSE_HEADER]: outputFormatId,
      [AUDIO_PRESENT_HEADER]: audioPresent ? '1' : '0',
    },
    transcriptBuffer,
    replyBuffer,
  };
}

// Turns a buildError() envelope (packages/shared/errors/error-response.js) into the same
// plain, socket-free response-head shape buildTurnResponseHead produces above, so
// request-handler.js has exactly one function it calls to get a { status, headers, bodyBuffer }
// triple for *every* /v1/turn response, success or failure. `headers` keeps the envelope's own
// X-Error-Code (the machine-readable channel a client with no JSON parser reads) and adds the
// same Content-Type/Cache-Control/X-API-Version every response carries; `bodyBuffer` is the
// JSON-serialised envelope body — the human-readable detail API-07 requires. The JSON error
// body is deliberate and unchanged from Phase 1, not a new envelope shape.
//
// Reverse-proxy note (SPEC-04): Cache-Control: no-transform is this service's own half of
// API-08's "no compression" guarantee — the service can only ever signal it. A reverse proxy
// that ignores the directive and recompresses or rewrites the response anyway is a deployment
// concern outside this module's (or this phase's code's) reach; Phase 6 owns verifying that
// half against the actual deployed proxy. Nothing in this codebase claims to close it.
export function buildErrorResponseHead(envelope) {
  const bodyBuffer = Buffer.from(JSON.stringify(envelope.body), 'utf8');
  return {
    status: envelope.status,
    headers: {
      ...envelope.headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-transform',
      'X-API-Version': API_VERSION,
    },
    bodyBuffer,
  };
}
