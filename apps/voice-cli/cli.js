// Reference command-line client for the Voice Bridge /v1/turn API. This file is the proof
// that a device with no browser, no JavaScript, and no audio codecs can complete a full voice
// turn against the published API alone — everything downstream in this phase (transport
// hardening, playback, the browser rewrite) assumes the wire contract proven here holds.
//
// One path only: argv -> WAV file read -> PCM extraction -> HTTP request -> incremental
// text-then-audio-streamed response consumption -> printed output. Transport is node:http
// exclusively — never the global fetch API: per CLI-02's posture, undici's fetch
// implementation auto-follows redirects and auto-decompresses gzip, silently defeating the
// "microcontroller-like client" this reference implementation exists to prove (05-RESEARCH.md
// Pitfall 3). Do not import fetch here or in any later plan.
//
// The CLI never imports the shared configuration loader and never reads the operator's local
// config file — it proves it needs only the published API and its own single provisioned
// secret, exactly what a firmware image would carry (05-RESEARCH.md Anti-Patterns, A4).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { wavToPcm, readWavFormat, pcmToWav, MAX_PCM_BYTES } from '../../packages/shared/audio/wav.js';
import { withTempDir } from '../../packages/shared/lifecycle/tempfiles.js';
import { MIN_CLIENT_READ_TIMEOUT_MS } from '../../packages/shared/transport/read-timeout.js';

const execFileAsync = promisify(execFile);

// Sizing basis (D-01): the default is the published minimum client read timeout, derived from
// the transcribe and agent stage ceilings — the response's first byte cannot arrive until both
// stages resolve, so a shorter inactivity timeout would spuriously abort a turn the server is
// still honestly working on. The measured typical time-to-first-byte (5.4s-10.3s, 03-UAT.md) is
// the typical case, not the floor. --timeout-ms remains available to tighten this per invocation.
export const DEFAULT_READ_TIMEOUT_MS = MIN_CLIENT_READ_TIMEOUT_MS;
export const TOKEN_ENV_VAR = 'VOICE_BRIDGE_CLI_TOKEN';
export const EXIT_CODES = Object.freeze({
  OK: 0,
  USAGE: 2,
  INPUT_INVALID: 3,
  TIMEOUT: 4,
  BUSY: 5,
  HTTP_ERROR: 6,
  CONTRACT_VIOLATION: 7,
  OUTPUT_WRITE_FAILED: 8,
});

// The shape every --input WAV file must declare, matching the pcm16 registry row's fixed
// values (packages/shared/audio/format-registry.js). Restated here as local constants rather
// than imported — this file's declared scope is wav.js only; the server never resamples a
// body declared pcm16 (05-RESEARCH.md Pitfall 1), so a non-conforming file must be refused
// client-side before a single byte is sent, not silently mistranscribed.
const EXPECTED_SAMPLE_RATE = 16000;
const EXPECTED_CHANNELS = 1;
const EXPECTED_BIT_DEPTH = 16;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4318;
const DEFAULT_OUT_FILENAME = 'reply.pcm';
const DEFAULT_PLAYER_BIN = '/usr/bin/afplay';

// Sizing basis (mirrors DEFAULT_READ_TIMEOUT_MS's own comment above): MAX_PCM_BYTES
// (packages/shared/audio/wav.js) caps a reply at 5 minutes of 16kHz mono s16le, so playback of
// even the largest possible reply never legitimately exceeds that duration by much — 300000ms
// gives it exactly that ceiling with no extra margin needed, since a hung player process is the
// only thing this timeout exists to catch, mirroring the array-form execFile + timeout shape
// packages/shared/adapters/tts-macos-say.js already uses.
const PLAYBACK_TIMEOUT_MS = 300000;

// Sizing basis (CR-02, 05-REVIEW.md): MAX_PCM_BYTES (packages/shared/audio/wav.js) is the
// project's own hard cap on a reply's PCM payload — 5 minutes of 16 kHz mono s16le, enforced
// server-side by pcmToWav — so no legitimate turn response can exceed it plus its two short
// text segments; one mebibyte of text headroom is three orders of magnitude above any real
// transcript-plus-reply pair. Deliberately derived from the shared cap rather than written as
// a standalone numeric literal, so the client ceiling moves if that cap ever moves.
export const MAX_RESPONSE_BYTES = MAX_PCM_BYTES + 1024 * 1024;

// Placeholder a token is replaced with if it ever reaches a printed line — the redaction is
// structural (every diagnostic line is built from a fixed set of named fields, never by
// serialising a request/options object), this is a second line of defense (T-05-02).
const TOKEN_REDACTION_PLACEHOLDER = '[redacted]';

function redactToken(text, token) {
  if (typeof text !== 'string' || !token) {
    return text;
  }
  return text.split(token).join(TOKEN_REDACTION_PLACEHOLDER);
}

// `print` is `console.log` for --help (stdout, exit OK) and `console.error` for a usage
// rejection (stderr) — same function, different sink, so the two paths can never drift apart.
function printUsage(print) {
  print(
    [
      'usage: node apps/voice-cli/cli.js --input <wav-file> [options]',
      '',
      'Reference CLI client for the Voice Bridge /v1/turn API. Sends and receives raw PCM',
      'only — no codec is ever invoked in either direction.',
      '',
      `  --input <path>   WAV file to send (required; must declare ${EXPECTED_SAMPLE_RATE} Hz /`,
      `                   ${EXPECTED_CHANNELS} channel / ${EXPECTED_BIT_DEPTH}-bit — the server never resamples pcm16 input)`,
      `  --host <name>    Voice bridge host (default: ${DEFAULT_HOST})`,
      `  --port <n>       Voice bridge port (default: ${DEFAULT_PORT})`,
      '  --token <value>  Bearer token. NOT RECOMMENDED: a token passed as a command-line flag',
      '                   is visible to any local user reading the process table — prefer',
      '                   VOICE_BRIDGE_CLI_TOKEN below instead.',
      `  --out <path>     Where to write the reply PCM (default: ./${DEFAULT_OUT_FILENAME})`,
      `  --timeout-ms <n> Inactivity read timeout in milliseconds (default: ${DEFAULT_READ_TIMEOUT_MS}).`,
      '                   Resets on every received byte — a slow but steadily-arriving',
      '                   response is never killed by this.',
      '  --no-play        Write the reply PCM to --out but never invoke a player binary',
      '  --capabilities   Print the service capability pairs (GET /v1/capabilities) and exit;',
      '                   --input is not required in this mode',
      '  --help           Print this message and exit',
      '',
      `The recommended way to supply the bearer token is the ${TOKEN_ENV_VAR} environment`,
      'variable, read automatically if no --token flag is given. It is never read from any',
      "server configuration file — this client's only credential is its own token.",
      '',
    ].join('\n'),
  );
}

// A --token flag value, read straight off argv with no other parsing — used only to feed
// redactToken() on a usage-rejection path in main(), so that path's own guarantee ("no token
// value ever reaches a printed line") holds even for an argv shape parseCliArgs itself
// rejects before assembling a full values object.
function extractFlagToken(argv) {
  const index = argv.indexOf('--token');
  return index === -1 ? null : (argv[index + 1] ?? null);
}

// Resolve-never-throw shape (mirrors error-response.js's posture elsewhere in this codebase):
// bad or absent input resolves to { ok: false, exitCode, message }, never a thrown exception,
// so a caller (main(), or a test driving this function directly) always gets a value back.
export function parseCliArgs(argv) {
  const values = {
    inputPath: null,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: null,
    outPath: null,
    timeoutMs: DEFAULT_READ_TIMEOUT_MS,
    noPlay: false,
    capabilities: false,
    help: false,
  };
  let flagToken = null;

  // WR-05 (06-REVIEW.md): without this guard, `argv[++i] ?? default` happily consumes the
  // next recognized flag as this flag's value (e.g. `--input --host 127.0.0.1` silently sets
  // inputPath to the literal string '--host', leaving --host unset) — producing confusing
  // downstream errors instead of a clear usage message naming the flag left without a value.
  let usageErrorFromMissingValue = null;
  const takeFlagValue = (flagName) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      usageErrorFromMissingValue = `${flagName} requires a value`;
      return null;
    }
    i += 1;
    return next;
  };

  let i;
  for (i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--input':
        values.inputPath = takeFlagValue('--input');
        break;
      case '--host':
        values.host = takeFlagValue('--host') ?? values.host;
        break;
      case '--port':
        values.port = Number(takeFlagValue('--port'));
        break;
      case '--token':
        flagToken = takeFlagValue('--token');
        break;
      case '--out':
        values.outPath = takeFlagValue('--out');
        break;
      case '--timeout-ms':
        values.timeoutMs = Number(takeFlagValue('--timeout-ms'));
        break;
      case '--no-play':
        values.noPlay = true;
        break;
      case '--capabilities':
        values.capabilities = true;
        break;
      case '--help':
        values.help = true;
        break;
      default:
        return { ok: false, exitCode: EXIT_CODES.USAGE, message: `unrecognized argument '${arg}'` };
    }
    if (usageErrorFromMissingValue) {
      return { ok: false, exitCode: EXIT_CODES.USAGE, message: usageErrorFromMissingValue };
    }
  }

  if (values.help) {
    return { ok: true, values };
  }

  // An inactivity window, not a total-duration cap (D-03) — but it must still be a real,
  // positive number of milliseconds; a non-numeric or non-positive value can never mean
  // anything sane to http.request()'s own timeout option.
  if (!Number.isFinite(values.timeoutMs) || values.timeoutMs <= 0) {
    return {
      ok: false,
      exitCode: EXIT_CODES.USAGE,
      message: `--timeout-ms must be a positive number of milliseconds`,
    };
  }

  // WR-01 (05-REVIEW.md): --port had no equivalent validation, so a non-numeric value
  // silently became NaN and only failed later inside http.request() with a confusing
  // message and the wrong exit-code family.
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) {
    return {
      ok: false,
      exitCode: EXIT_CODES.USAGE,
      message: '--port must be an integer between 1 and 65535',
    };
  }

  // The flag wins when both are present; the environment variable is used when no flag is
  // given. Read from process.env[TOKEN_ENV_VAR] or the --token flag and nowhere else — this
  // client never touches the shared configuration loader or the operator's local config file.
  values.token = flagToken || process.env[TOKEN_ENV_VAR] || null;

  // --capabilities runs a discovery probe instead of a turn — it needs no input audio file.
  if (!values.inputPath && !values.capabilities) {
    return { ok: false, exitCode: EXIT_CODES.USAGE, message: 'missing required --input <wav-file>' };
  }
  if (!values.token) {
    return {
      ok: false,
      exitCode: EXIT_CODES.USAGE,
      message: `missing bearer token: set ${TOKEN_ENV_VAR} or pass --token`,
    };
  }

  return { ok: true, values };
}

// Throws a tagged INPUT_INVALID error unless the file declares exactly the pcm16 registry
// row's shape. The message names the shape actually read, per this plan's must_haves truth.
export function assertConformingWav(wavBuffer) {
  const format = readWavFormat(wavBuffer);
  if (
    format.sampleRate !== EXPECTED_SAMPLE_RATE ||
    format.channels !== EXPECTED_CHANNELS ||
    format.bitDepth !== EXPECTED_BIT_DEPTH
  ) {
    const err = new Error(
      `input WAV must be ${EXPECTED_SAMPLE_RATE} Hz / ${EXPECTED_CHANNELS} channel / ${EXPECTED_BIT_DEPTH}-bit ` +
        `— got ${format.sampleRate} Hz / ${format.channels} channel(s) / ${format.bitDepth}-bit`,
    );
    err.code = 'INPUT_INVALID';
    throw err;
  }
  return format;
}

// IN-01 (05-REVIEW.md): shared refusal guard postTurn and readCapabilities both invoke from
// their own response callback — the 3xx redirect refusal and the content-encoding refusal
// were near-verbatim duplicated across both before this extraction. Task 1 (06-07-PLAN.md)
// split this further out of the old readTurnResponseBody so both readBufferedResponseBody
// and the new incremental streamTurnResponseBody share one copy. Throws synchronously (never
// returns a rejected promise itself) — safe to call as the first statement inside a Promise
// executor, since a synchronous throw there is caught by the Promise constructor and turns
// into a rejection automatically.
function assertUntransformedResponse(req, res) {
  // Redirect refusal: node:http never follows a Location header on its own — this makes
  // that refusal explicit rather than incidental. The Location header itself is never
  // read; there is nothing to act on, only a violation to report.
  if (res.statusCode >= 300 && res.statusCode <= 399) {
    res.resume();
    const err = new Error(
      `received a ${res.statusCode} redirect response — the service is specified never ` +
        `to redirect (API-08); no second request was issued`,
    );
    err.code = 'CONTRACT_VIOLATION';
    req.destroy();
    throw err;
  }

  // Compression refusal: accept-encoding: identity was already sent above; a response
  // that carries content-encoding anyway means something on the hop compressed it
  // regardless — never decompressed here, only reported.
  const contentEncoding = res.headers['content-encoding'];
  if (contentEncoding) {
    res.resume();
    const err = new Error(
      `response carried a content-encoding header ('${contentEncoding}') — this client ` +
        `only ever sends accept-encoding: identity and never decompresses a response`,
    );
    err.code = 'CONTRACT_VIOLATION';
    req.destroy();
    throw err;
  }
}

// Renamed from readTurnResponseBody (Task 1, 06-07-PLAN.md) — this reader still accumulates
// the whole body via Buffer.concat, which is now correct only for the two callers left using
// it: readCapabilities (a small, fully-known line-based body) and postTurn's non-200 branch
// (a small, fully-known error envelope). The 200-status turn-response path moved to
// streamTurnResponseBody below, which never buffers audio. Resolves the raw concatenated body
// Buffer once the response stream's own 'end' event fires; rejects with a tagged
// CONTRACT_VIOLATION error on any of assertUntransformedResponse's two refusals, or on
// breaching the response ceiling below.
function readBufferedResponseBody(req, res) {
  return new Promise((resolve, reject) => {
    assertUntransformedResponse(req, res);

    // CR-02 (05-REVIEW.md): a misbehaving backend or reverse proxy sending an oversized
    // or endlessly-streaming body has no ceiling without this — the client would grow its
    // own process memory unbounded. `ceilingBreached` guards against a chunk arriving
    // after the breach being counted, retained, or re-rejecting an already-settled
    // promise; the stream's own 'end' handler is likewise a no-op once it fires.
    const chunks = [];
    let receivedBytes = 0;
    let ceilingBreached = false;
    res.on('data', (chunk) => {
      if (ceilingBreached) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        ceilingBreached = true;
        const err = new Error(
          `response exceeded the ${MAX_RESPONSE_BYTES}-byte response ceiling — refusing to buffer further`,
        );
        err.code = 'CONTRACT_VIOLATION';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      if (ceilingBreached) return;
      resolve(Buffer.concat(chunks));
    });
    res.on('error', reject);
  });
}

// Exported so test/voice-cli.test.js can drive its edge-case surface directly (Task 2,
// 06-07-PLAN.md). Parses and validates the three X-Voice-* framing headers into
// { transcriptBytes, replyBytes, audioPresent } before streamTurnResponseBody attaches any
// data listener — a hostile or malformed declaration is refused before a single body byte is
// retained. Deliberately duplicates, rather than calls, splitTurnBody's own count validation:
// splitTurnBody keeps its own message text and its own five existing unit tests unchanged, and
// it runs later — after the body is known — to catch a declared-vs-received mismatch this
// function cannot see yet (it only ever sees headers).
export function readTurnFraming(headers) {
  const rawTranscriptBytes = headers['x-voice-transcript-bytes'];
  const rawReplyBytes = headers['x-voice-reply-bytes'];
  const audioPresent = headers['x-voice-audio-present'] === '1';

  const transcriptBytes = Number(rawTranscriptBytes);
  if (!isValidFramingCount(transcriptBytes)) {
    throwFramingViolation('x-voice-transcript-bytes', rawTranscriptBytes);
  }
  const replyBytes = Number(rawReplyBytes);
  if (!isValidFramingCount(replyBytes)) {
    throwFramingViolation('x-voice-reply-bytes', rawReplyBytes);
  }

  const textBoundary = transcriptBytes + replyBytes;
  if (textBoundary > MAX_RESPONSE_BYTES) {
    const err = new Error(
      `declared text span of ${textBoundary} bytes (x-voice-transcript-bytes + ` +
        `x-voice-reply-bytes) exceeds the ${MAX_RESPONSE_BYTES}-byte response ceiling — ` +
        `refusing to retain any body byte`,
    );
    err.code = 'CONTRACT_VIOLATION';
    throw err;
  }

  return { transcriptBytes, replyBytes, audioPresent };
}

function isValidFramingCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function throwFramingViolation(headerName, rawValue) {
  const err = new Error(
    `response header '${headerName}' is not a valid non-negative safe-integer byte count ` +
      `(read: ${JSON.stringify(rawValue)})`,
  );
  err.code = 'CONTRACT_VIOLATION';
  throw err;
}

// The incremental reader (Task 1, 06-07-PLAN.md) — the one piece of the CLI that proves
// docs/API.md's MUST-level no-full-buffering claim (SPEC-03). Accumulates only the declared
// text span (transcript bytes + reply bytes), decodes it exactly once via the unchanged
// splitTurnBody, and hands every subsequent byte straight to onAudioChunk as it arrives.
// Audio bytes are never pushed into an array, a Map, or a Buffer.concat call — the only
// Buffer.concat calls in this function operate on the text accumulator.
//
// Decoding the text span only once the full span has arrived (never per-chunk) is what makes
// a multi-byte character split across two socket chunks decode correctly — decoding a partial
// span would risk cutting a multi-byte UTF-8 sequence in half.
function streamTurnResponseBody(req, res, { onAudioChunk } = {}) {
  return new Promise((resolve, reject) => {
    assertUntransformedResponse(req, res);

    let framing;
    try {
      framing = readTurnFraming(res.headers);
    } catch (err) {
      // Refused before any data listener is attached — nothing has been read yet, so
      // destroying the request here is the only cleanup needed.
      req.destroy();
      throw err;
    }
    const { transcriptBytes, replyBytes, audioPresent } = framing;
    const textBoundary = transcriptBytes + replyBytes;

    const textChunks = [];
    let textReceived = 0;
    let decoded = null; // set to { transcript, reply } once the full text span is decoded
    let receivedBytes = 0;
    let settled = false;

    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    res.on('data', (chunk) => {
      if (settled) return;

      // CR-02 (05-REVIEW.md), preserved verbatim: the ceiling is checked against every
      // received byte before any of it is retained, text or audio alike.
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        const err = new Error(
          `response exceeded the ${MAX_RESPONSE_BYTES}-byte response ceiling — refusing to buffer further`,
        );
        err.code = 'CONTRACT_VIOLATION';
        req.destroy();
        settleReject(err);
        return;
      }

      let audioChunk = null;
      if (decoded === null) {
        const remaining = textBoundary - textReceived;
        if (chunk.length <= remaining) {
          textChunks.push(chunk);
          textReceived += chunk.length;
        } else {
          textChunks.push(chunk.subarray(0, remaining));
          textReceived += remaining;
          audioChunk = chunk.subarray(remaining);
        }
        if (textReceived === textBoundary) {
          try {
            const { transcript, reply } = splitTurnBody(res.headers, Buffer.concat(textChunks));
            decoded = { transcript, reply };
          } catch (err) {
            settleReject(err);
            return;
          }
        }
      } else {
        audioChunk = chunk;
      }

      if (audioChunk && audioChunk.length > 0 && audioPresent) {
        // Handed straight to the caller-supplied sink, never retained here — this is what
        // keeps the largest single sink call strictly below the total audio length for a
        // multi-chunk reply.
        const writeResult = onAudioChunk(audioChunk);
        // Sink backpressure (T-06-14): pausing the response stream when the sink's own
        // write signals it is full, and resuming only once the sink itself says it has
        // drained, is what stops audio piling up inside the sink's internal writable
        // buffer instead of the array this whole function exists to avoid. The drain
        // signal is reached through the sink-supplied onAudioChunk function's own
        // .onDrain registration, never by this reader reaching into a stream directly.
        if (writeResult === false) {
          res.pause();
          onAudioChunk.onDrain(() => res.resume());
        }
      }
    });

    res.on('end', () => {
      if (settled) return;
      if (decoded === null) {
        // The stream ended before the declared text span was satisfied — let the
        // unchanged splitTurnBody raise its existing over-declared CONTRACT_VIOLATION
        // against however much text actually arrived, producing the identical message
        // shape and tag the previous buffering implementation produced.
        try {
          splitTurnBody(res.headers, Buffer.concat(textChunks));
        } catch (err) {
          settleReject(err);
          return;
        }
        // splitTurnBody's own validation (transcriptBytes + replyBytes > body.length)
        // always throws in this branch, since textReceived < textBoundary got us here —
        // this line is unreachable but left rather than assumed.
        return;
      }
      settleResolve({
        transcript: decoded.transcript,
        reply: decoded.reply,
        audioBytes: Math.max(0, receivedBytes - textBoundary),
      });
    });

    res.on('error', (err) => settleReject(err));
  });
}

// Issues POST /v1/turn via node:http (never fetch — see file header). On a 200 response,
// resolves { statusCode, headers, rawHeaders, transcript, reply, audioBytes } via the
// incremental streamTurnResponseBody — the text span is consumed only to the stream's own
// 'end' event, but the audio segment (Task 1, 06-07-PLAN.md) is consumed as it arrives, handed
// straight to the caller-supplied onAudioChunk sink rather than accumulated to 'end'. On any
// other status, resolves { statusCode, headers, rawHeaders, body } via readBufferedResponseBody
// — an error body is small and fully known, so buffering it costs nothing. The 'timeout'
// option only emits an event on socket inactivity; it does not abort anything on its own, so
// both readers above must call req.destroy() themselves (05-RESEARCH.md Pitfall 2). A 3xx
// status or a content-encoding response header is a hard CONTRACT_VIOLATION failure rather
// than a followed redirect or a silent decompression — both are behaviors the service is
// specified never to exhibit (API-08), and a client that tolerated either would mask exactly
// the proxy misconfiguration this posture exists to catch.
export function postTurn({ host, port, token, pcmBuffer, timeoutMs = DEFAULT_READ_TIMEOUT_MS, onAudioChunk }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method: 'POST',
        path: '/v1/turn',
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'x-voice-input-format': 'pcm16',
          // No X-Voice-Output-Format header is sent: pcm16 is the registry's single
          // headerless row and therefore the default reply format.
          'accept-encoding': 'identity',
          'content-length': pcmBuffer.length,
        },
      },
      (res) => {
        if (res.statusCode === 200) {
          streamTurnResponseBody(req, res, { onAudioChunk })
            .then(({ transcript, reply, audioBytes }) =>
              resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                rawHeaders: res.rawHeaders,
                transcript,
                reply,
                audioBytes,
              }),
            )
            .catch(reject);
        } else {
          readBufferedResponseBody(req, res)
            .then((body) =>
              resolve({ statusCode: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body }),
            )
            .catch(reject);
        }
      },
    );
    req.on('timeout', () => {
      const err = new Error(`read timeout exceeded after ${timeoutMs}ms`);
      err.code = 'TIMEOUT';
      req.destroy(err);
    });
    req.on('error', (err) => reject(err));
    req.write(pcmBuffer);
    req.end();
  });
}

// Splits a turn response body using only the three X-Voice-* framing headers — never a
// body-length response header, which the success response deliberately never sets (the body
// is chunked). audioPcm is null unless x-voice-audio-present is exactly the string '1'.
//
// CR-01 (05-REVIEW.md): Buffer.prototype.subarray clamps an out-of-range end index instead of
// throwing, so a declared byte count larger than what was actually received must be refused
// before any subarray call — never silently clamped into a mis-split. The comparison is
// strictly greater-than: a declared total exactly equal to body.length is a legitimate
// no-audio response and must still be accepted.
export function splitTurnBody(headers, body) {
  const transcriptBytes = Number(headers['x-voice-transcript-bytes']);
  const replyBytes = Number(headers['x-voice-reply-bytes']);
  const audioPresent = headers['x-voice-audio-present'] === '1';

  if (
    !Number.isInteger(transcriptBytes) || transcriptBytes < 0 ||
    !Number.isInteger(replyBytes) || replyBytes < 0 ||
    transcriptBytes + replyBytes > body.length
  ) {
    const err = new Error(
      `response framing headers declare ${transcriptBytes + replyBytes} text bytes, ` +
        `but only ${body.length} bytes were received — refusing to guess a split`,
    );
    err.code = 'CONTRACT_VIOLATION';
    throw err;
  }

  const transcript = body.subarray(0, transcriptBytes).toString('utf8');
  const reply = body.subarray(transcriptBytes, transcriptBytes + replyBytes).toString('utf8');
  // WR-02 (05-REVIEW.md): a truthy x-voice-audio-present with zero bytes actually remaining
  // must still be treated as "no audio" — Buffer#subarray at an index equal to body.length
  // returns a zero-length but still-truthy Buffer, which app.js's splitTurnResponse already
  // guards against.
  const audioStart = transcriptBytes + replyBytes;
  const audioPcm = audioPresent && audioStart < body.length ? body.subarray(audioStart) : null;

  return { transcript, reply, audioPcm };
}

// Turns the raw-PCM reply into sound using a header this client wrote itself — never a
// container delivered by the service (FMT-02/CLI-03). `pcmToWav` is the only place a WAV
// header is ever constructed here, matching the pcm16 registry row's fixed shape. Written
// inside withTempDir so the temporary playback file is guaranteed removed on every outcome,
// and invoked with execFile in array form (never a shell string), mirroring
// packages/shared/adapters/tts-macos-say.js's own call shape. `playerBin` is injectable
// precisely so tests can exercise both branches (success, missing/failing binary) without
// producing sound. Degrades rather than fails: a missing or non-zero-exit player never
// changes the return value's success shape into a thrown exception — 05-RESEARCH.md flags
// /usr/bin/afplay as unverified on this host, and CLI-01/CLI-03 are about the wire contract,
// not the speaker. The caller (runCliTurn) decides what, if anything, to print about a
// degraded outcome — this function reports the failure back as data, never to stdout/stderr
// itself.
export async function playReplyPcm(audioPcm, { playerBin = DEFAULT_PLAYER_BIN, enabled = true } = {}) {
  if (!enabled) {
    return { played: false, skipped: true };
  }
  return withTempDir('voice-cli-playback-', async (tmpDir) => {
    const wavBuffer = pcmToWav(audioPcm, {
      sampleRate: EXPECTED_SAMPLE_RATE,
      channels: EXPECTED_CHANNELS,
      bitDepth: EXPECTED_BIT_DEPTH,
    });
    const wavPath = path.join(tmpDir, 'reply.wav');
    fs.writeFileSync(wavPath, wavBuffer);
    try {
      await execFileAsync(playerBin, [wavPath], { timeout: PLAYBACK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
      return { played: true };
    } catch (error) {
      return { played: false, error };
    }
  });
}

// Splits response text into a Map, on newline and then each line on its FIRST ': ' only —
// exactly matching request-handler.js's own sendLinesBody() emission shape, so a value that
// itself contains ': ' still parses correctly (only the first separator is meaningful). No
// JSON parsing anywhere: this is the shape a client with no JSON parser is meant to read.
function parseLinesBody(text) {
  const pairs = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const idx = line.indexOf(': ');
    if (idx === -1) continue;
    pairs.set(line.slice(0, idx), line.slice(idx + 2));
  }
  return pairs;
}

// Issues GET /v1/capabilities over the same node:http request path postTurn uses for the
// turn route — same bearer header, same accept-encoding: identity, same inactivity timeout
// with an explicit req.destroy(), same hard refusal of a 3xx redirect or a content-encoding
// response header (05-RESEARCH.md Pitfall 2/3; CLI-02's posture applies to every route this
// client calls, not just the turn route). Resolves a Map built by parseLinesBody() on a 200
// response; rejects with a tagged error (HTTP_ERROR/TIMEOUT/CONTRACT_VIOLATION) otherwise —
// an HTTP_ERROR rejection carries statusCode and errorCode read from the line-based error
// body (request-handler.js's sendLineErrorHead), never a JSON envelope.
export function readCapabilities({ host, port, token, timeoutMs = DEFAULT_READ_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method: 'GET',
        path: '/v1/capabilities',
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          'accept-encoding': 'identity',
        },
      },
      (res) => {
        // Same redirect refusal, content-encoding refusal, and CR-02 response-ceiling
        // tracking as postTurn's non-200 branch — both call sites share
        // readBufferedResponseBody (IN-01, 05-REVIEW.md; renamed from readTurnResponseBody
        // by Task 1, 06-07-PLAN.md). Only the status/line-body interpretation below is
        // specific to the capabilities route.
        readBufferedResponseBody(req, res)
          .then((body) => {
            const bodyText = body.toString('utf8');
            if (res.statusCode !== 200) {
              const pairs = parseLinesBody(bodyText);
              const err = new Error(
                pairs.get('error-message') ?? `capabilities request failed with status ${res.statusCode}`,
              );
              err.code = 'HTTP_ERROR';
              err.statusCode = res.statusCode;
              err.errorCode = pairs.get('error-code') ?? res.headers['x-error-code'] ?? 'UNKNOWN';
              reject(err);
              return;
            }
            resolve(parseLinesBody(bodyText));
          })
          .catch(reject);
      },
    );
    req.on('timeout', () => {
      const err = new Error(`read timeout exceeded after ${timeoutMs}ms`);
      err.code = 'TIMEOUT';
      req.destroy(err);
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

// The incremental reader's byte sink (Task 1, 06-07-PLAN.md). Opens the output file lazily on
// the first audio chunk — so a no-audio turn creates no file at all, matching the pre-existing
// behavior — tracks bytes written, and exposes finish()/discard() so runCliTurn never touches
// fs.WriteStream directly. write() returns whatever the underlying stream's own write()
// returned (Node's own backpressure signal), and .onDrain is attached directly on the write
// function itself so streamTurnResponseBody can register a one-shot resume callback without
// reaching into the stream from inside the reader (see streamTurnResponseBody's own comment).
function createAudioSink(outputPath) {
  let stream = null;
  let bytesWritten = 0;
  let drainWaiters = [];
  // Set from the stream's 'error' listener below. fs.WriteStream emits 'error' asynchronously
  // (never synchronously from createWriteStream()/write()) for conditions like a missing --out
  // directory, a permission failure, or a full disk. Without a listener attached, an unhandled
  // 'error' event throws and crashes the whole process; recording it here lets runCliTurn map
  // the failure to a clean exit code instead.
  let writeError = null;
  let closed = false;

  const write = (chunk) => {
    // Once the stream has errored, stop feeding it further data — it may already be
    // destroyed/closing, and there's nothing useful to write to a broken sink.
    if (writeError) {
      return true;
    }
    if (!stream) {
      stream = fs.createWriteStream(outputPath);
      stream.on('error', (err) => {
        writeError = err;
      });
      stream.on('close', () => {
        closed = true;
      });
      stream.on('drain', () => {
        const waiters = drainWaiters;
        drainWaiters = [];
        for (const waiter of waiters) waiter();
      });
    }
    bytesWritten += chunk.length;
    return stream.write(chunk);
  };
  write.onDrain = (cb) => {
    drainWaiters.push(cb);
  };

  return {
    write,
    get bytesWritten() {
      return bytesWritten;
    },
    get writeError() {
      return writeError;
    },
    // Ends the stream and waits for the underlying file descriptor to actually close before
    // resolving — a no-audio turn (stream never opened) resolves immediately. If the stream
    // already errored, skip calling .end() on it (it may already be auto-destroyed) — the
    // caller is expected to check .writeError and call discard() instead.
    finish() {
      return new Promise((resolve, reject) => {
        if (!stream || writeError) {
          resolve();
          return;
        }
        stream.end((err) => (err ? reject(err) : resolve()));
      });
    },
    // T-06-12: removes a partially-written output file on any failure exit, and never lets a
    // truncated stream be mistaken for a complete reply — called before any error line is
    // printed and before the output path is ever logged, so a discarded sink's path can never
    // reach stdout. Guards against the stream having already auto-destroyed itself (emitting
    // 'close') before discard() is called — e.g. after a write error — in which case waiting
    // on a fresh 'close' listener would never resolve.
    discard() {
      return new Promise((resolve) => {
        if (!stream) {
          resolve();
          return;
        }
        const cleanup = () => {
          fs.rm(outputPath, { force: true }, () => resolve());
        };
        if (closed) {
          cleanup();
          return;
        }
        stream.once('close', cleanup);
        stream.destroy();
      });
    },
  };
}

// Composes the above into the CLI's one path: read the file, assert conformance, strip to raw
// PCM (reusing wav.js — never re-walking RIFF chunks here), post with an incremental audio
// sink wired in, print, and let the sink finish or discard. Every diagnostic line is built
// from a fixed set of named fields (never by serialising a request/options object) and passed
// through redactToken() so a token value can never reach stdout/stderr, even indirectly
// (T-05-02).
export async function runCliTurn({
  host,
  port,
  token,
  inputPath,
  outPath,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
  noPlay = false,
  playerBin = DEFAULT_PLAYER_BIN,
}) {
  const reportError = (message) => console.error(redactToken(message, token));

  let wavBuffer;
  try {
    wavBuffer = fs.readFileSync(inputPath);
  } catch (error) {
    reportError(`error: could not read input file '${inputPath}': ${error.message}`);
    return EXIT_CODES.INPUT_INVALID;
  }

  let pcmBuffer;
  try {
    assertConformingWav(wavBuffer);
    pcmBuffer = wavToPcm(wavBuffer);
  } catch (error) {
    reportError(`error: ${error.message}`);
    return EXIT_CODES.INPUT_INVALID;
  }

  // Resolved before the request is issued, not after (the buffering implementation resolved
  // this only once a full body was already in hand) — the sink needs a target path the moment
  // the first audio byte might arrive.
  const outputPath = outPath ?? path.join(process.cwd(), DEFAULT_OUT_FILENAME);
  const sink = createAudioSink(outputPath);

  let response;
  try {
    response = await postTurn({ host, port, token, pcmBuffer, timeoutMs, onAudioChunk: sink.write });
  } catch (error) {
    await sink.discard();
    if (error.code === 'TIMEOUT') {
      reportError(`error: ${error.message}`);
      return EXIT_CODES.TIMEOUT;
    }
    if (error.code === 'CONTRACT_VIOLATION') {
      reportError(`error: ${error.message}`);
      return EXIT_CODES.CONTRACT_VIOLATION;
    }
    reportError(`error: request failed: ${error.message}`);
    return EXIT_CODES.HTTP_ERROR;
  }

  if (response.statusCode !== 200) {
    await sink.discard();
    const errorCode = response.headers['x-error-code'] ?? 'UNKNOWN';
    // Distinguished from a generic failure (05-02-PLAN.md must_haves): the lock is held by
    // another client and this turn was refused immediately, not queued behind it.
    if (errorCode === 'TURN_BUSY') {
      reportError('busy: another client holds the turn lock; refused immediately, not queued — try again shortly');
      return EXIT_CODES.BUSY;
    }
    reportError(`error ${response.statusCode} ${errorCode}`);
    return EXIT_CODES.HTTP_ERROR;
  }

  // The former try { splitTurnBody(...) } catch block that used to live here is gone — the
  // framing error it used to catch now surfaces through postTurn's own rejection above, via
  // streamTurnResponseBody's identical CONTRACT_VIOLATION tag and message shape.
  const { transcript, reply } = response;
  console.log(`transcript: ${transcript}`);
  console.log(`reply: ${reply}`);

  await sink.finish();

  if (sink.writeError) {
    await sink.discard();
    reportError(`error: failed to write reply audio to ${outputPath}: ${sink.writeError.message}`);
    return EXIT_CODES.OUTPUT_WRITE_FAILED;
  }

  if (sink.bytesWritten > 0) {
    console.log(outputPath);

    // Playback re-reads the saved output file rather than reusing an in-memory buffer — a
    // post-transport local operation, outside the response-body consumption docs/API.md's
    // MUST-level claim governs. --no-play (playReplyPcm's enabled: false) skips this entirely.
    const audioPcm = fs.readFileSync(outputPath);
    const playback = await playReplyPcm(audioPcm, { playerBin, enabled: !noPlay });
    if (!playback.played && !playback.skipped) {
      reportError(`warning: playback failed (${playback.error?.message ?? 'unknown error'}); reply audio saved to ${outputPath}`);
    }
  }

  return EXIT_CODES.OK;
}

// Runs the --capabilities discovery probe instead of a turn: same token/host/port, same exit
// code vocabulary as a turn (TIMEOUT/CONTRACT_VIOLATION/HTTP_ERROR), and prints each pair back
// as `key: value`, one per line — mirroring the wire body's own shape rather than reformatting
// it. An HTTP_ERROR rejection prints the status and error code read from the line-based error
// body, the same shape runCliTurn already uses for a rejected turn.
async function runCliCapabilities({ host, port, token, timeoutMs = DEFAULT_READ_TIMEOUT_MS }) {
  const reportError = (message) => console.error(redactToken(message, token));

  try {
    const capabilities = await readCapabilities({ host, port, token, timeoutMs });
    for (const [key, value] of capabilities) {
      console.log(`${key}: ${value}`);
    }
    return EXIT_CODES.OK;
  } catch (error) {
    if (error.code === 'TIMEOUT') {
      reportError(`error: ${error.message}`);
      return EXIT_CODES.TIMEOUT;
    }
    if (error.code === 'CONTRACT_VIOLATION') {
      reportError(`error: ${error.message}`);
      return EXIT_CODES.CONTRACT_VIOLATION;
    }
    if (error.code === 'HTTP_ERROR') {
      reportError(`error ${error.statusCode} ${error.errorCode}`);
      return EXIT_CODES.HTTP_ERROR;
    }
    reportError(`error: request failed: ${error.message}`);
    return EXIT_CODES.HTTP_ERROR;
  }
}

export async function main(argv) {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    // redactToken is applied here too (not just in runCliTurn's reportError) so the
    // usage/error printer's own guarantee holds structurally regardless of which exit path
    // produced the message — a --token flag value present in argv, even one that never made
    // it into parsed.values (e.g. a later parse failure), must never reach this line.
    console.error(redactToken(`error: ${parsed.message}`, extractFlagToken(argv)));
    printUsage(console.error);
    return parsed.exitCode;
  }
  if (parsed.values.help) {
    printUsage(console.log);
    return EXIT_CODES.OK;
  }
  if (parsed.values.capabilities) {
    return runCliCapabilities(parsed.values);
  }
  return runCliTurn(parsed.values);
}

// Only run main() when this module is the process entry point — comparing import.meta.url
// against pathToFileURL(process.argv[1]).href means importing this module in a test never
// starts a turn or calls process.exit(). main() itself returns the exit code rather than
// calling process.exit() directly, so a test can drive it in-process and observe the code.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cliArgv = process.argv.slice(2);
  main(cliArgv).then((code) => {
    process.exit(code);
  }).catch((error) => {
    // Defense-in-depth: every known failure path inside main()/runCliTurn() already resolves
    // to an EXIT_CODES.* value rather than a rejection. This catch exists only so an
    // unanticipated rejection (a future code path that forgets its own try/catch) still exits
    // cleanly with a token-redacted message instead of an unhandled-rejection crash.
    console.error(redactToken(`error: unexpected failure: ${error.message}`, extractFlagToken(cliArgv)));
    process.exit(EXIT_CODES.HTTP_ERROR);
  });
}
