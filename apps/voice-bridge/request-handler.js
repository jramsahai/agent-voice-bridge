import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { runTurn } from '../../packages/shared/pipeline/turn-pipeline.js';
import { prepareTranscriptionInput, prepareClientOutput } from '../../packages/shared/audio/convert.js';
import {
  negotiate,
  listReplyFormats,
  defaultOutputFormatId,
  INPUT_FORMAT_HEADER,
  OUTPUT_FORMAT_HEADER,
  WANT_AUDIO_HEADER,
} from '../../packages/shared/transport/negotiate.js';
import {
  buildTurnResponseHead,
  buildErrorResponseHead,
  MAX_REQUEST_AUDIO_BYTES,
  API_VERSION,
  TRANSCRIPT_BYTES_HEADER,
  REPLY_BYTES_HEADER,
} from '../../packages/shared/transport/turn-response.js';
import { listSupportedFormats } from '../../packages/shared/audio/format-registry.js';
import { buildError } from '../../packages/shared/errors/error-response.js';
import { isKnownErrorCode } from '../../packages/shared/errors/error-codes.js';
import { getBackendStatus, BACKEND_UP } from '../../packages/shared/health/backend-health-cache.js';
import { probeExecutable, probeHttpService } from '../../packages/shared/health/probes.js';

// Every rejection this handler ever writes goes through buildError() (the one error
// envelope — packages/shared/errors/error-response.js) and then this function, so every
// /v1/* response — success or failure — carries the same Content-Type/Cache-Control/
// X-API-Version headers and no response shape reinvents its own error body.
function sendErrorHead(res, envelope) {
  const head = buildErrorResponseHead(envelope);
  res.writeHead(head.status, head.headers);
  res.end(head.bodyBuffer);
}

// Line-based body renderer for GET /v1/capabilities and GET /v1/health (D-02, locked): one
// `key: value` line per pair, UTF-8, no JSON — a client with no JSON parser needs nothing
// beyond splitting on the newline and then on the first ': '. A real Content-Length is set
// because unlike the turn response this body is short, fully known upfront, and never
// streamed.
function sendLinesBody(res, status, headers, pairs) {
  const bodyText = pairs.map(([key, value]) => `${key}: ${value}`).join('\n') + '\n';
  const bodyBuffer = Buffer.from(bodyText, 'utf8');
  res.writeHead(status, {
    ...headers,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-transform',
    'X-API-Version': API_VERSION,
    'Content-Length': String(bodyBuffer.length),
  });
  res.end(bodyBuffer);
}

// The two discovery GET routes' own rejection renderer — the same buildError() envelope
// every other route uses, rendered as `error-code`/`error-message` lines instead of the
// turn route's JSON body, so all three routes report one machine-readable X-Error-Code
// while each route's body shape matches its own declared content type.
function sendLineErrorHead(res, envelope) {
  sendLinesBody(res, envelope.status, envelope.headers, [
    ['error-code', envelope.headers['X-Error-Code']],
    ['error-message', envelope.body.error.message],
  ]);
}

// CR-02: fs.createReadStream() errors (ENOENT, EACCES, etc.) surface asynchronously on the
// stream's 'error' event. An EventEmitter with no 'error' listener throws that error as an
// uncaught exception, which crashes the whole Node process — taking down every other
// in-flight request, not just this static one. writeHead(200) is deferred until the stream
// actually opens, so a missing/unreadable file never commits to a 200 status.
function sendFile(res, filePath, contentType) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', (error) => {
    console.error('[voice-bridge] failed to serve static file', filePath, error);
    if (!res.headersSent) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end();
  });
  stream.once('open', () => res.writeHead(200, { 'content-type': contentType }));
  stream.pipe(res);
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// The discovery routes' own rate-limit ceiling (T-3-06/D-05, locked): a sustained one poll
// per second, ten times the turn endpoint's effective default rate — a wire-visible
// operational decision a monitoring configuration and a firmware polling interval are both
// written against, not a tuning knob to be changed lightly. Exported so an operator (and
// this plan's own tests) reads the actual ceiling rather than a copied literal. Phase 4's
// OPS-04 re-keys the buckets these constants size by named client identity; nothing here
// makes that harder.
export const DISCOVERY_RATE_LIMIT_MAX_REQUESTS = 60;
export const DISCOVERY_RATE_LIMIT_WINDOW_MS = 60_000;

// Generic sliding-window bucket check, parameterised over the Map, ceiling, and window so
// the turn endpoint and the two discovery endpoints can each get their own bucket without
// duplicating the sliding-window logic itself (T-3-06): an unlimited diagnostic surface is
// its own denial-of-service lever, so the discovery routes are rate-limited rather than
// exempted outright, just on a separate, more generous budget that a monitoring poller
// cannot exhaust and that cannot itself exhaust the turn budget.
function checkRateLimitBucket(buckets, maxRequests, windowMs, key) {
  const now = Date.now();
  const bucket = buckets.get(key) ?? [];
  const fresh = bucket.filter((ts) => now - ts < windowMs);
  if (fresh.length >= maxRequests) {
    buckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  buckets.set(key, fresh);
  return true;
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
  // Two independent buckets (T-3-06/D-05): POST /v1/turn draws on turnRateLimitBuckets at
  // the configured turn ceiling; the two GET /v1/* discovery routes draw on
  // discoveryRateLimitBuckets at the fixed DISCOVERY_RATE_LIMIT_* ceiling above. The bucket
  // is selected by the matched route in the router, before any handler runs — never by a
  // request header — so a caller cannot choose which budget its own request draws from.
  const turnRateLimitBuckets = new Map();
  const discoveryRateLimitBuckets = new Map();

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

  function checkTurnRateLimit(req) {
    return checkRateLimitBucket(turnRateLimitBuckets, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS, clientIp(req));
  }

  function checkDiscoveryRateLimit(req) {
    return checkRateLimitBucket(
      discoveryRateLimitBuckets,
      DISCOVERY_RATE_LIMIT_MAX_REQUESTS,
      DISCOVERY_RATE_LIMIT_WINDOW_MS,
      clientIp(req),
    );
  }

  // `sendError` lets a caller swap the rejection renderer without duplicating the gate
  // itself — GET /v1/capabilities and GET /v1/health pass sendLineErrorHead so a rejection
  // from this same gate still matches each route's own line-based content type.
  // `checkLimit` lets a caller swap which rate-limit bucket this gate draws from — the two
  // discovery routes pass checkDiscoveryRateLimit so a burst against them can never draw
  // down the turn endpoint's own budget, and vice versa.
  function validateRequest(req, res, { sendError = sendErrorHead, checkLimit = checkTurnRateLimit } = {}) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    // Host and origin rejections deliberately collapse to the same FORBIDDEN code and the
    // same fixed title (T-3-16): telling a caller which of the two checks it failed tells an
    // attacker how to fix its request.
    if (expectedHost && host !== expectedHost) {
      sendError(res, buildError('FORBIDDEN'));
      return false;
    }
    if (allowedOrigins.size && origin && !allowedOrigins.has(origin)) {
      sendError(res, buildError('FORBIDDEN'));
      return false;
    }
    if (!isAuthorizedToken(bearerToken)) {
      sendError(res, buildError('UNAUTHORIZED'));
      return false;
    }
    if (!checkLimit(req)) {
      sendError(res, buildError('RATE_LIMITED'));
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

    // Disconnect detection: a per-turn AbortController fed by the *response's* own 'close'
    // event, not the deprecated `.aborted` boolean IncomingMessage exposes (deprecated since
    // Node v17 — 03-RESEARCH.md's Don't Hand-Roll table). Verified empirically against this runtime
    // (Node v26.5.0) rather than assumed from research: `req`'s (IncomingMessage) 'close'
    // fires as soon as the *request* body has been fully received — which happens on every
    // ordinary turn, seconds before the response is anywhere near done — so listening there
    // would abort every turn spuriously. `res`'s (ServerResponse) 'close' event is the one
    // that fires early, with `res.writableEnded` still false, precisely when the underlying
    // connection is torn down before the response completes, and fires only after
    // `res.writableEnded` is already true on an ordinary successful completion. runTurn()'s
    // own between-stage checks and runStage()'s abort normalization do the rest — this is
    // wiring onto an existing Phase 2 contract, not new pipeline logic.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    // Composes over the injected adapters inside this handler's own closure only — not a
    // second adapter-selection seam (Phase 2's ARISK-01 stays intact: nothing here chooses
    // which implementation runs, each wrapper only inspects the already-selected adapter's
    // own resolved value, or observes when it is invoked, and forwards every argument
    // unchanged). The transcribe wrapper rejects a missing/whitespace-only transcript before
    // the agent stage ever runs (TRANSCRIPT_EMPTY, 422 — replacing the legacy ad hoc 422
    // string). The agent/speak wrappers exist so this handler can write the text preamble to
    // the wire the moment the agent stage resolves — before awaiting the speak stage's own
    // resolution — since speak is only ever invoked, by the pipeline's own fixed stage
    // order, once transcript and reply are already committed.
    let capturedTranscript;
    let capturedReply;
    let resolveTextReady;
    const textReady = new Promise((resolve) => {
      resolveTextReady = resolve;
    });

    const turnAdapters = {
      ...adapters,
      transcribe: async (...args) => {
        const result = await adapters.transcribe(...args);
        if (!result.text || result.text.trim() === '') {
          const err = new Error('transcription returned no text');
          err.code = 'TRANSCRIPT_EMPTY';
          throw err;
        }
        capturedTranscript = result.text;
        return result;
      },
      agent: async (...args) => {
        const result = await adapters.agent(...args);
        capturedReply = result.rawText ?? result.text;
        return result;
      },
      speak: (...args) => {
        resolveTextReady();
        return adapters.speak(...args);
      },
    };

    // runTurn()'s signature and internals are a locked Phase 2 contract — called here,
    // never modified.
    const runTurnPromise = runTurn({
      audioBuffer: prepared.wavBuffer,
      adapters: turnAdapters,
      sttConfig: config.stt,
      openclawConfig: config.openclaw,
      ttsConfig: config.tts,
      wantAudio,
      audioFilename: 'input.wav',
      signal: controller.signal,
    });

    if (wantAudio) {
      // A turn that never reaches the speak stage (an error thrown by transcribe/agent, or
      // an abort caught between stages) never resolves textReady on its own — race it
      // against the turn's own settlement so that case falls through to the ordinary
      // re-await below instead of waiting forever for a speak call that will never happen.
      await Promise.race([textReady, runTurnPromise.then(() => {}, () => {})]);

      if (capturedTranscript !== undefined && capturedReply !== undefined) {
        // Compute both length headers and call writeHead before the first write of any
        // kind (03-RESEARCH.md Pitfall 2) — both are known now, since the pipeline resolves
        // transcript and reply together, before speech starts. Writing them here, before
        // awaiting runTurnPromise to completion, is what lets the client read the full text
        // preamble while synthesis is still in flight.
        const head = buildTurnResponseHead({
          transcript: capturedTranscript,
          reply: capturedReply,
          outputFormatId,
          audioPresent: true,
        });
        res.writeHead(head.status, head.headers);
        res.write(head.transcriptBuffer);
        res.write(head.replyBuffer);

        const result = await runTurnPromise;
        let audioBuffer = Buffer.alloc(0);
        if (result.speech) {
          const output = await prepareClientOutput(result.speech.audioBuffer, outputFormatId);
          if (output.error) {
            // Headers are already on the wire — there is no fresh status line left to
            // report a conversion failure through. Log server-side and end the response
            // rather than attempt a second writeHead.
            console.error('[voice-bridge] output conversion failed after headers were sent', output.error);
            return res.end();
          }
          audioBuffer = output.buffer;
        }
        res.write(audioBuffer);
        return res.end();
      }
    }

    // Text-only turn (wantAudio false — prepareClientOutput is never called on this path,
    // since a conversion on a null speech buffer is the obvious way this branch breaks), or
    // a wantAudio-true turn that errored/aborted before ever reaching the speak stage.
    // Either way nothing has been written to the wire yet, so the single-await shape below
    // still applies, and in the error case runTurnPromise's rejection propagates unchanged
    // to the outer catch.
    const result = await runTurnPromise;

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
    res.end();
  }

  // Mirrors tts-kokoro-onnx.js's own private getKokoroServiceUrl() precedence
  // (ttsConfig.serviceUrl -> KOKORO_TTS_URL env -> the fixed local default) so this route
  // probes the same URL speakWithKokoroFast would actually call. Kept as a local copy
  // rather than an import because that helper is not exported and this plan's file scope
  // does not extend to tts-kokoro-onnx.js.
  function resolveKokoroServiceUrl(ttsConfig = {}) {
    return ttsConfig.serviceUrl || process.env.KOKORO_TTS_URL || 'http://127.0.0.1:4319';
  }

  // GET /v1/health — the reachability of all three backends, each read through the same
  // TTL-windowed getBackendStatus cache the speech adapter reads (same 'speech' backend
  // name), so this route and a live turn share one probe window rather than keeping two.
  // Caching all three (not just speech) is a deliberate generalisation beyond OPS-05's
  // literal wording: a monitoring tool polling health every few seconds would otherwise
  // reintroduce the identical fixed-penalty-per-call problem for transcribe/agent
  // (03-RESEARCH.md Pitfall 5). Resolved with Promise.all so a slow probe never serialises
  // the other two, and the three lines are always emitted in this fixed declaration order
  // regardless of which probe settles first, so the body is stable between calls. A probe
  // that fails to invoke at all (missing binary, unresolvable path) is already collapsed to
  // BACKEND_DOWN by getBackendStatus's own contract — no try/catch of its own is needed
  // here. Served without acquiring the shared turn lock: this route never calls runTurn().
  async function handleHealth(req, res) {
    const [transcribe, agent, speech] = await Promise.all([
      getBackendStatus('transcribe', () => probeExecutable(config.stt?.command ?? '')),
      getBackendStatus('agent', () => probeExecutable(config.openclaw?.command ?? '')),
      getBackendStatus('speech', () => probeHttpService(resolveKokoroServiceUrl(config.tts))),
    ]);

    // Named backends only — no service URL, configured command, resolved path, or probe
    // error text may ever appear in this body (T-3-05): an unauthenticated-adjacent
    // diagnostic surface is not the place to publish the deployment's own layout.
    const allUp = transcribe === BACKEND_UP && agent === BACKEND_UP && speech === BACKEND_UP;
    sendLinesBody(res, allUp ? 200 : 503, {}, [
      ['transcribe', transcribe],
      ['agent', agent],
      ['speech', speech],
    ]);
  }

  // GET /v1/capabilities — the whole turn vocabulary, discoverable as text before a
  // client's first turn. Every value is read from an existing exported constant or derived
  // from the registry (listSupportedFormats()/listReplyFormats()/defaultOutputFormatId()),
  // never re-spelled as a literal — the body cannot drift from what the service actually
  // supports because it is derived from the same source the transport itself reads.
  // Served without acquiring the shared turn lock: this route never calls runTurn().
  function handleCapabilities(req, res) {
    const voices = config.tts?.voices ?? [config.tts?.voice];
    sendLinesBody(res, 200, {}, [
      ['api-version', API_VERSION],
      ['input-formats', listSupportedFormats().join(',')],
      ['reply-formats', listReplyFormats().join(',')],
      ['default-reply-format', defaultOutputFormatId()],
      ['voices', voices.join(',')],
      ['max-audio-bytes', String(MAX_REQUEST_AUDIO_BYTES)],
      ['input-format-header', INPUT_FORMAT_HEADER],
      ['output-format-header', OUTPUT_FORMAT_HEADER],
      ['want-audio-header', WANT_AUDIO_HEADER],
      ['transcript-bytes-header', TRANSCRIPT_BYTES_HEADER],
      ['reply-bytes-header', REPLY_BYTES_HEADER],
    ]);
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
      if (req.method === 'GET' && req.url === '/v1/capabilities') {
        if (!validateRequest(req, res, { sendError: sendLineErrorHead, checkLimit: checkDiscoveryRateLimit })) return;
        return handleCapabilities(req, res);
      }
      if (req.method === 'GET' && req.url === '/v1/health') {
        if (!validateRequest(req, res, { sendError: sendLineErrorHead, checkLimit: checkDiscoveryRateLimit })) return;
        return await handleHealth(req, res);
      }
      return sendErrorHead(res, buildError('NOT_FOUND'));
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : null;

      // CR-01: the text preamble may already be on the wire (writeHead already called in
      // handleTurn's early-flush branch) by the time ANY error reaches here — not just
      // TURN_ABORTED. There is no fresh status line left to report through once that
      // happens, and a second writeHead() throws ERR_HTTP_HEADERS_SENT, which — uncaught
      // here — becomes an unhandled rejection that crashes the whole process under Node
      // 20's default unhandled-rejections behavior, taking every other in-flight turn down
      // with it. Guard every code, not just the abort path, and tear the connection down
      // instead of attempting a second writeHead.
      if (res.headersSent) {
        console.error(
          code === 'TURN_ABORTED'
            ? '[voice-bridge] turn aborted after headers were already sent'
            : '[voice-bridge] request failed after headers were already sent',
          error,
        );
        if (!res.writableEnded) res.destroy();
        return;
      }

      if (code === 'TURN_ABORTED') {
        return sendErrorHead(res, buildError('TURN_ABORTED'));
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
