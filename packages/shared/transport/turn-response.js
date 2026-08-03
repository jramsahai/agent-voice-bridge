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
// MAX_PCM_BYTES. Not enforced by this tracer — plan 03-04 wires request-size rejection.
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
