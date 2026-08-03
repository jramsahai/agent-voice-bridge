import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { runTurn } from '../../packages/shared/pipeline/turn-pipeline.js';
import { prepareTranscriptionInput, prepareClientOutput } from '../../packages/shared/audio/convert.js';
import { negotiate } from '../../packages/shared/transport/negotiate.js';
import {
  buildTurnResponseHead,
  buildErrorResponseHead,
  MAX_REQUEST_AUDIO_BYTES,
} from '../../packages/shared/transport/turn-response.js';
import { buildError } from '../../packages/shared/errors/error-response.js';
import { isKnownErrorCode } from '../../packages/shared/errors/error-codes.js';

// Every rejection this handler ever writes goes through buildError() (the one error
// envelope — packages/shared/errors/error-response.js) and then this function, so every
// /v1/* response — success or failure — carries the same Content-Type/Cache-Control/
// X-API-Version headers and no response shape reinvents its own error body.
function sendErrorHead(res, envelope) {
  const head = buildErrorResponseHead(envelope);
  res.writeHead(head.status, head.headers);
  res.end(head.bodyBuffer);
}

function sendFile(res, filePath, contentType) {
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, { 'content-type': contentType });
  stream.pipe(res);
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// Returns a routed, injectable HTTP handler suitable for http.createServer. Everything the
// legacy server.js held at module scope (config-derived constants, the rate-limit bucket
// Map) moves into this factory's closure, so two handler instances in one test process
// cannot exhaust each other's budget. `adapters` reaches runTurn only from this factory's
// own argument — nothing derived from a request may ever be written into it (Phase 2's
// recorded ARISK-01, mirrored here as T-3-03).
export function createRequestHandler({ config, adapters, webDir }) {
  const RATE_LIMIT_WINDOW_MS = config.security?.rateLimitWindowMs ?? 15_000;
  const RATE_LIMIT_MAX_REQUESTS = config.security?.rateLimitMaxRequests ?? 6;
  const allowedOrigins = new Set(config.security?.allowedOrigins ?? []);
  const expectedHost = config.security?.expectedHost ?? null;
  const requireToken = config.security?.token ?? '';
  const rateLimitBuckets = new Map();

  // Ported functionally unchanged from the legacy server.js: timing-safe token compare,
  // per-IP sliding window, expected-host and allowed-origin checks. Only the rejection
  // response shape changed this plan (buildError()/sendErrorHead instead of a bare
  // sendJson({error: string})).
  function isAuthorizedToken(receivedToken) {
    if (!requireToken) return true;
    if (!receivedToken) return false;
    const left = Buffer.from(receivedToken);
    const right = Buffer.from(requireToken);
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }

  function checkRateLimit(req) {
    const key = clientIp(req);
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key) ?? [];
    const fresh = bucket.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
    if (fresh.length >= RATE_LIMIT_MAX_REQUESTS) {
      rateLimitBuckets.set(key, fresh);
      return false;
    }
    fresh.push(now);
    rateLimitBuckets.set(key, fresh);
    return true;
  }

  function validateRequest(req, res) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    // Host and origin rejections deliberately collapse to the same FORBIDDEN code and the
    // same fixed title (T-3-16): telling a caller which of the two checks it failed tells an
    // attacker how to fix its request.
    if (expectedHost && host !== expectedHost) {
      sendErrorHead(res, buildError('FORBIDDEN'));
      return false;
    }
    if (allowedOrigins.size && origin && !allowedOrigins.has(origin)) {
      sendErrorHead(res, buildError('FORBIDDEN'));
      return false;
    }
    if (!isAuthorizedToken(bearerToken)) {
      sendErrorHead(res, buildError('UNAUTHORIZED'));
      return false;
    }
    if (!checkRateLimit(req)) {
      sendErrorHead(res, buildError('RATE_LIMITED'));
      return false;
    }
    return true;
  }

  // Same running-total loop shape as the legacy readJsonBody, minus the toString('utf8')
  // and JSON.parse — the body is opaque bytes, not a JSON envelope (D-01/API-01). The cap is
  // MAX_REQUEST_AUDIO_BYTES (initialised from wav.js's own MAX_PCM_BYTES), not a second
  // magic number, and a request whose declared Content-Length already exceeds it is rejected
  // before a single body byte is read — this closes the inherited Phase 1 gap STATE.md
  // records: no size ceiling ever existed for a raw/container request body (T-3-01).
  async function readRawBody(req) {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_AUDIO_BYTES) {
      const err = new Error('declared Content-Length exceeds the maximum allowed audio payload size');
      err.code = 'AUDIO_TOO_LARGE';
      throw err;
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_REQUEST_AUDIO_BYTES) {
        const err = new Error('audio payload exceeds the maximum allowed size');
        err.code = 'AUDIO_TOO_LARGE';
        throw err;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function handleTurn(req, res) {
    const rawBody = await readRawBody(req);

    const negotiated = negotiate(req.headers);
    if (negotiated.error) {
      return sendErrorHead(res, negotiated.error);
    }
    const { inputFormatId, outputFormatId, wantAudio } = negotiated;

    const prepared = await prepareTranscriptionInput(rawBody, inputFormatId);
    if (prepared.error) {
      return sendErrorHead(res, prepared.error);
    }

    // A transcript that is missing or trims to nothing is rejected before the agent stage
    // ever runs, via a thin per-turn wrapper over the injected transcribe adapter — not a
    // second adapter-selection seam (Phase 2's ARISK-01): this wrapper never chooses which
    // implementation runs, it only inspects the already-selected adapter's own resolved
    // value and forwards every argument to it unchanged. Throwing here (rather than
    // resolving) lets runStage()'s existing error propagation carry the .code straight to
    // this handler's catch block, which maps it to the frozen catalogue (TRANSCRIPT_EMPTY,
    // 422) — replacing the ad hoc 422 string the legacy handler predates.
    const turnAdapters = {
      ...adapters,
      transcribe: async (...args) => {
        const result = await adapters.transcribe(...args);
        if (!result.text || result.text.trim() === '') {
          const err = new Error('transcription returned no text');
          err.code = 'TRANSCRIPT_EMPTY';
          throw err;
        }
        return result;
      },
    };

    // runTurn()'s signature and internals are a locked Phase 2 contract — called here,
    // never modified.
    const result = await runTurn({
      audioBuffer: prepared.wavBuffer,
      adapters: turnAdapters,
      sttConfig: config.stt,
      openclawConfig: config.openclaw,
      ttsConfig: config.tts,
      wantAudio,
      audioFilename: 'input.wav',
    });

    let audioBuffer = Buffer.alloc(0);
    if (result.speech) {
      const output = await prepareClientOutput(result.speech.audioBuffer, outputFormatId);
      if (output.error) {
        return sendErrorHead(res, output.error);
      }
      audioBuffer = output.buffer;
    }

    const head = buildTurnResponseHead({
      transcript: result.transcript,
      reply: result.reply,
      outputFormatId,
      audioPresent: Boolean(result.speech),
    });

    // No body-length header is set and transfer-encoding is never set by hand — Node
    // applies chunked framing automatically in that absence, and setting either one
    // defeats it.
    res.writeHead(head.status, head.headers);
    res.write(head.transcriptBuffer);
    res.write(head.replyBuffer);
    res.write(audioBuffer);
    res.end();
  }

  return async function requestHandler(req, res) {
    try {
      if (req.method === 'GET' && req.url === '/') {
        return sendFile(res, path.join(webDir, 'index.html'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && req.url === '/app.js') {
        return sendFile(res, path.join(webDir, 'app.js'), 'application/javascript; charset=utf-8');
      }
      if (req.method === 'POST' && req.url === '/v1/turn') {
        if (!validateRequest(req, res)) return;
        return await handleTurn(req, res);
      }
      return sendErrorHead(res, buildError('NOT_FOUND'));
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : null;

      if (code === 'TURN_ABORTED') {
        // Nothing is listening on the other end of an aborted turn by definition. The 499
        // status is only writable when nothing has reached the wire yet — if headers are
        // already sent (the text preamble was already flushed before the client vanished),
        // a second writeHead() would throw, so log and destroy the response instead.
        if (!res.headersSent) {
          return sendErrorHead(res, buildError('TURN_ABORTED'));
        }
        console.error('[voice-bridge] turn aborted after headers were already sent', error);
        res.destroy();
        return;
      }

      // TURN_BUSY (from turn-errors.js) and AUDIO_MALFORMED/AUDIO_TOO_LARGE/
      // AUDIO_CONVERSION_FAILED (thrown per wav.js/convert.js's documented throw-vs-resolve
      // contract) all carry a registered catalogue code already — map straight through.
      if (code && isKnownErrorCode(code)) {
        return sendErrorHead(res, buildError(code));
      }

      // Anything else collapses to INTERNAL_ERROR. The caught error's message, stack, and
      // any path it carries are logged server-side only (existing console.error
      // convention) and must never reach the client — buildError('INTERNAL_ERROR') with no
      // message argument always falls back to the catalogue's fixed title.
      console.error('[voice-bridge] request failed', error);
      return sendErrorHead(res, buildError('INTERNAL_ERROR'));
    }
  };
}
