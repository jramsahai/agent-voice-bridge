import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { runTurn } from '../../packages/shared/pipeline/turn-pipeline.js';
import { prepareTranscriptionInput, prepareClientOutput } from '../../packages/shared/audio/convert.js';
import { negotiate } from '../../packages/shared/transport/negotiate.js';
import { buildTurnResponseHead } from '../../packages/shared/transport/turn-response.js';

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendErrorEnvelope(res, envelope) {
  res.writeHead(envelope.status, envelope.headers);
  res.end(JSON.stringify(envelope.body));
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
  const MAX_JSON_BYTES = config.security?.maxJsonBytes ?? 2_000_000;
  const RATE_LIMIT_WINDOW_MS = config.security?.rateLimitWindowMs ?? 15_000;
  const RATE_LIMIT_MAX_REQUESTS = config.security?.rateLimitMaxRequests ?? 6;
  const allowedOrigins = new Set(config.security?.allowedOrigins ?? []);
  const expectedHost = config.security?.expectedHost ?? null;
  const requireToken = config.security?.token ?? '';
  const rateLimitBuckets = new Map();

  // Ported functionally unchanged from the legacy server.js (timing-safe token compare,
  // per-IP sliding window, expected-host and allowed-origin checks). Rejection bodies keep
  // the legacy sendJson shape for now — 03-04 converts these to the error catalogue.
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

    if (expectedHost && host !== expectedHost) {
      sendJson(res, 403, { error: 'host not allowed' });
      return false;
    }
    if (allowedOrigins.size && origin && !allowedOrigins.has(origin)) {
      sendJson(res, 403, { error: 'origin not allowed' });
      return false;
    }
    if (!isAuthorizedToken(bearerToken)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return false;
    }
    if (!checkRateLimit(req)) {
      sendJson(res, 429, { error: 'too many requests' });
      return false;
    }
    return true;
  }

  // Same running-total loop shape as the legacy readJsonBody, minus the toString('utf8')
  // and JSON.parse — the body is opaque bytes, not a JSON envelope (D-01/API-01).
  async function readRawBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_JSON_BYTES) {
        throw new Error('payload too large');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function handleTurn(req, res) {
    const rawBody = await readRawBody(req);

    const negotiated = negotiate(req.headers);
    if (negotiated.error) {
      return sendErrorEnvelope(res, negotiated.error);
    }
    const { inputFormatId, outputFormatId, wantAudio } = negotiated;

    const prepared = await prepareTranscriptionInput(rawBody, inputFormatId);
    if (prepared.error) {
      return sendErrorEnvelope(res, prepared.error);
    }

    // runTurn()'s signature and internals are a locked Phase 2 contract — called here,
    // never modified.
    const result = await runTurn({
      audioBuffer: prepared.wavBuffer,
      adapters,
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
        return sendErrorEnvelope(res, output.error);
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
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (error.message === 'payload too large') {
        return sendJson(res, 413, { error: 'payload too large' });
      }
      console.error('[voice-bridge] request failed', error);
      sendJson(res, 500, { error: 'internal server error' });
    }
  };
}
