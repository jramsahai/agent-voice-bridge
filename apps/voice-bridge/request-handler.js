import fs from 'node:fs';
import path from 'node:path';

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
import { buildClientDigests, resolveClientIdentity, ANONYMOUS_CLIENT_NAME } from '../../packages/shared/security/token-auth.js';
import { getKokoroServiceUrl } from '../../packages/shared/adapters/tts-kokoro-onnx.js';
import {
  checkRateLimitBucket,
  DISCOVERY_RATE_LIMIT_MAX_REQUESTS,
  DISCOVERY_RATE_LIMIT_WINDOW_MS,
  FAILED_AUTH_BUCKET_KEY,
  FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS,
  FAILED_AUTH_RATE_LIMIT_WINDOW_MS,
} from '../../packages/shared/security/rate-limit.js';
import { logTurnCompletion, TURN_OUTCOMES } from '../../packages/shared/logging/turn-log.js';

// Re-exported so test/http-capabilities.test.js and test/http-health.test.js keep importing
// these two constants from this same path — they now live in
// packages/shared/security/rate-limit.js; this is a pure re-export, not a redefinition.
export { DISCOVERY_RATE_LIMIT_MAX_REQUESTS, DISCOVERY_RATE_LIMIT_WINDOW_MS };

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

// IN-02: the Host header's hostname component is case-insensitive per RFC 7230 §5.4, and a
// client may legitimately carry an explicit standard-port suffix (`:80`/`:443`) that a
// configured expectedHost typically does not. Normalizing both sides before the strict compare
// avoids wrongly rejecting a request that only differs in case or an explicit standard port.
function normalizeHostHeader(value) {
  if (typeof value !== 'string') return value;
  return value.toLowerCase().replace(/:(80|443)$/, '');
}

// Returns a routed, injectable HTTP handler suitable for http.createServer. Everything the
// legacy server.js held at module scope (config-derived constants, the rate-limit bucket
// Map) moves into this factory's closure, so two handler instances in one test process
// cannot exhaust each other's budget. `adapters` reaches runTurn only from this factory's
// own argument — nothing derived from a request may ever be written into it (Phase 2's
// recorded ARISK-01, mirrored here as T-3-03).
export function createRequestHandler({
  config,
  adapters,
  webDir,
  logTurn = logTurnCompletion,
  rateLimitBuckets = { turn: new Map(), discovery: new Map(), failedAuth: new Map() },
  inFlightControllers = new Set(),
}) {
  const RATE_LIMIT_WINDOW_MS = config.security?.rateLimitWindowMs ?? 15_000;
  const RATE_LIMIT_MAX_REQUESTS = config.security?.rateLimitMaxRequests ?? 6;
  const allowedOrigins = new Set(config.security?.allowedOrigins ?? []);
  const expectedHost = config.security?.expectedHost ?? null;
  // Built once at factory-init time, alongside allowedOrigins/expectedHost above — never
  // recomputed per request, since config is static for the process lifetime. authEnabled
  // false is the generalized auth-disabled escape hatch (D-04, locked): every request
  // resolves to the single fixed ANONYMOUS_CLIENT_NAME identity, exactly as an empty
  // security.token did before this phase. rateLimitBuckets is a factory parameter (not a
  // module-level Map) so two handler instances in one test process cannot exhaust each
  // other's budget, and so a test can hand in Maps it can inspect directly.
  const clientDigests = buildClientDigests(config.security?.clients);
  const authEnabled = clientDigests.length > 0;

  function checkTurnRateLimit(clientName) {
    return checkRateLimitBucket(rateLimitBuckets.turn, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS, clientName);
  }

  function checkDiscoveryRateLimit(clientName) {
    return checkRateLimitBucket(
      rateLimitBuckets.discovery,
      DISCOVERY_RATE_LIMIT_MAX_REQUESTS,
      DISCOVERY_RATE_LIMIT_WINDOW_MS,
      clientName,
    );
  }

  // WR-04: the failed-auth rate-limit-and-respond block was duplicated verbatim at all three
  // rejection sites below (Host mismatch, Origin mismatch, unresolved bearer token) — extracted
  // once here so a future change to the throttle (a new log line, a different bucket key, an
  // additional check) only needs to be applied in one place.
  function rejectWithFailedAuthThrottle(res, sendError, deniedError) {
    if (
      !checkRateLimitBucket(
        rateLimitBuckets.failedAuth,
        FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS,
        FAILED_AUTH_RATE_LIMIT_WINDOW_MS,
        FAILED_AUTH_BUCKET_KEY,
      )
    ) {
      sendError(res, buildError('RATE_LIMITED'));
    } else {
      sendError(res, buildError(deniedError));
    }
  }

  // `sendError` lets a caller swap the rejection renderer without duplicating the gate
  // itself — GET /v1/capabilities and GET /v1/health pass sendLineErrorHead so a rejection
  // from this same gate still matches each route's own line-based content type.
  // `checkLimit` lets a caller swap which rate-limit bucket this gate draws from — the two
  // discovery routes pass checkDiscoveryRateLimit so a burst against them can never draw
  // down the turn endpoint's own budget, and vice versa. Both buckets are now keyed by the
  // resolved client identity, never by source address (D-02/AUTH-05). Returns { ok: false }
  // on every rejection and { ok: true, clientName } on success, so a caller learns the
  // resolved identity without a second lookup — this whole gate stays ahead of any body read
  // (AUTH-04), unchanged in ordering from before this phase.
  function validateRequest(req, res, { sendError = sendErrorHead, checkLimit = checkTurnRateLimit } = {}) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    // Host and origin rejections deliberately collapse to the same FORBIDDEN code and the
    // same fixed title (T-3-16): telling a caller which of the two checks it failed tells an
    // attacker how to fix its request.
    //
    // WR-03: both Host and Origin are attacker-controlled, unauthenticated inputs — the same
    // class of caller the failedAuth bucket already exists to throttle (D-05). Drawing on
    // that same fixed-key bucket here closes the gap where a mismatched Host/Origin could be
    // sent an unbounded number of times without ever being rate-limited, mirroring the bad-
    // bearer-token path below.
    if (expectedHost && normalizeHostHeader(host) !== normalizeHostHeader(expectedHost)) {
      rejectWithFailedAuthThrottle(res, sendError, 'FORBIDDEN');
      return { ok: false };
    }
    if (allowedOrigins.size && origin && !allowedOrigins.has(origin)) {
      rejectWithFailedAuthThrottle(res, sendError, 'FORBIDDEN');
      return { ok: false };
    }

    const clientName = authEnabled ? resolveClientIdentity(clientDigests, bearerToken) : ANONYMOUS_CLIENT_NAME;
    if (clientName === null) {
      // Closes WR-01 (03-REVIEW.md): failed-auth attempts draw on their own fixed-key
      // bucket, checked before the 401 is sent, so credential guessing is throttled the same
      // as any other caller class — never keyed by address (D-05).
      rejectWithFailedAuthThrottle(res, sendError, 'UNAUTHORIZED');
      return { ok: false };
    }

    if (!checkLimit(clientName)) {
      sendError(res, buildError('RATE_LIMITED'));
      return { ok: false };
    }
    return { ok: true, clientName };
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

  async function handleTurn(req, res, { clientName, turnLogState }) {
    // WR-03: negotiate() only inspects headers and needs no body at all — run it before
    // readRawBody() so a trivially wrong X-Voice-Input-Format header is rejected without
    // first buffering the entire (size-capped) request body. Mirrors the same fail-fast
    // discipline AUTH-04 already applies to the bearer token.
    const negotiated = negotiate(req.headers);
    if (negotiated.error) {
      // WR-01: this resolves rather than throws, so it never reaches the router's outer
      // catch (which is the only other place that calls logTurn) — log it here explicitly
      // so a bad format-negotiation header still produces a turn-log line.
      logTurn({
        client: clientName,
        outcome: TURN_OUTCOMES.ERROR,
        durationsMs: {},
        errorCode: negotiated.error.headers['X-Error-Code'],
      });
      return sendErrorHead(res, negotiated.error);
    }
    const { inputFormatId, outputFormatId, wantAudio } = negotiated;

    const rawBody = await readRawBody(req);

    const prepared = await prepareTranscriptionInput(rawBody, inputFormatId);
    if (prepared.error) {
      // WR-01: same rationale as the negotiate() branch above — prepared.error resolves
      // rather than throws, so it never reaches the router's outer catch either.
      logTurn({
        client: clientName,
        outcome: TURN_OUTCOMES.ERROR,
        durationsMs: {},
        errorCode: prepared.error.headers['X-Error-Code'],
      });
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
    inFlightControllers.add(controller);
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    // Every path through the rest of this function — success, a thrown error, or an abort —
    // must remove this controller from the shared set once the turn settles, so a later
    // shutdown sequence (04-04-PLAN.md) never aborts a controller whose turn already ended.
    // This finally neither catches nor rethrows, so it changes no control flow reaching the
    // router's own outer catch; deliberately narrower than wrapping handleTurn itself, which
    // 04-RESEARCH.md Pitfall 3 warns against (that shape is how CR-01/CR-02 came back).
    try {
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

      // OPS-01's timing source (04-RESEARCH.md Pattern 2): populated incrementally inside
      // these same wrapper closures rather than read from runTurn()'s returned
      // meta.durationsMs, which does not exist on a rejected promise. A turn that fails during
      // agent still has stageDurationsMs.transcribe populated when a later exit point logs it.
      const stageDurationsMs = {};
      // The out-parameter the router's own catch block reads from (04-RESEARCH.md Pitfall 3):
      // stageDurationsMs is mutated in place by the wrapper closures below, so this reference,
      // written once here, stays valid through every later mutation without a second handoff.
      turnLogState.stageDurationsMs = stageDurationsMs;

      const turnAdapters = {
        ...adapters,
        transcribe: async (...args) => {
          const start = Date.now();
          try {
            const result = await adapters.transcribe(...args);
            if (!result.text || result.text.trim() === '') {
              const err = new Error('transcription returned no text');
              err.code = 'TRANSCRIPT_EMPTY';
              throw err;
            }
            capturedTranscript = result.text;
            return result;
          } finally {
            stageDurationsMs.transcribe = Date.now() - start;
          }
        },
        agent: async (...args) => {
          const start = Date.now();
          try {
            const result = await adapters.agent(...args);
            capturedReply = result.rawText ?? result.text;
            return result;
          } finally {
            stageDurationsMs.agent = Date.now() - start;
          }
        },
        speak: (...args) => {
          resolveTextReady();
          const start = Date.now();
          return adapters.speak(...args).finally(() => {
            stageDurationsMs.speak = Date.now() - start;
          });
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
          // WR-02: audioPresent was already written into the response head above as `true`
          // the moment speak() was invoked, before result.speech was known. Every current
          // adapter either resolves speak() with a truthy object or rejects — never resolves
          // falsy — so that header is expected to always match reality by the time we get
          // here. There is no fresh status line left to correct the header through once
          // headers are on the wire, so a violated assumption can only be surfaced loudly
          // server-side, not fixed client-side.
          if (result.speech) {
            const output = await prepareClientOutput(result.speech.audioBuffer, outputFormatId);
            if (output.error) {
              // Headers are already on the wire — there is no fresh status line left to
              // report a conversion failure through. Log server-side and end the response
              // rather than attempt a second writeHead.
              console.error('[voice-bridge] output conversion failed after headers were sent', output.error);
              logTurn({
                client: clientName,
                outcome: TURN_OUTCOMES.ERROR,
                durationsMs: stageDurationsMs,
                errorCode: output.error.headers['X-Error-Code'],
              });
              return res.end();
            }
            audioBuffer = output.buffer;
          } else {
            console.error(
              '[voice-bridge] wantAudio turn declared audio-present=1 but produced no speech',
            );
          }
          res.write(audioBuffer);
          // The one exit point this task owns (04-01-PLAN.md, locked). Plan 04-02 owns every
          // remaining exit point and the error/abort outcomes. clientName reaches only this
          // call and the rate-limit bucket key above — nowhere else (T-4-05).
          logTurn({ client: clientName, outcome: TURN_OUTCOMES.OK, durationsMs: stageDurationsMs });
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
      logTurn({ client: clientName, outcome: TURN_OUTCOMES.OK, durationsMs: stageDurationsMs });
      res.end();
    } finally {
      inFlightControllers.delete(controller);
    }
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
      getBackendStatus('speech', () => probeHttpService(getKokoroServiceUrl(config.tts))),
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
    // CR-01: a write attempted against a response whose socket is already gone (client
    // disconnected before any header was ever flushed) surfaces as an 'error' event on this
    // stream, not a thrown exception the surrounding try/catch can see. With zero listeners
    // that event throws and crashes the whole process, taking every other in-flight turn
    // down with it — the same crash class 03-REVIEW.md's CR-01/CR-02 already closed for two
    // other trigger points. Log-and-swallow, mirroring the guard sendFile() already applies.
    res.on('error', (error) => {
      console.error('[voice-bridge] response stream error', error);
    });
    // Populated only on the /v1/turn branch below — its presence in the catch is exactly
    // what gates "only log from the catch when the request that failed was a turn request"
    // (04-RESEARCH.md Pitfall 3): a rejected static file read or a 404 never sets this, so
    // neither ever emits a turn record.
    let turnLogState = null;
    try {
      if (req.method === 'GET' && req.url === '/') {
        return sendFile(res, path.join(webDir, 'index.html'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && req.url === '/app.js') {
        return sendFile(res, path.join(webDir, 'app.js'), 'application/javascript; charset=utf-8');
      }
      if (req.method === 'POST' && req.url === '/v1/turn') {
        const gate = validateRequest(req, res);
        if (!gate.ok) return;
        turnLogState = { clientName: gate.clientName, stageDurationsMs: null };
        return await handleTurn(req, res, { clientName: gate.clientName, turnLogState });
      }
      if (req.method === 'GET' && req.url === '/v1/capabilities') {
        const gate = validateRequest(req, res, { sendError: sendLineErrorHead, checkLimit: checkDiscoveryRateLimit });
        if (!gate.ok) return;
        return handleCapabilities(req, res);
      }
      if (req.method === 'GET' && req.url === '/v1/health') {
        const gate = validateRequest(req, res, { sendError: sendLineErrorHead, checkLimit: checkDiscoveryRateLimit });
        if (!gate.ok) return;
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
        if (turnLogState) {
          logTurn({
            client: turnLogState.clientName,
            outcome: code === 'TURN_ABORTED' ? TURN_OUTCOMES.ABORTED : TURN_OUTCOMES.ERROR,
            durationsMs: turnLogState.stageDurationsMs ?? {},
            errorCode: code && isKnownErrorCode(code) ? code : 'INTERNAL_ERROR',
          });
        }
        if (!res.writableEnded) res.destroy();
        return;
      }

      if (code === 'TURN_ABORTED') {
        if (turnLogState) {
          logTurn({
            client: turnLogState.clientName,
            outcome: TURN_OUTCOMES.ABORTED,
            durationsMs: turnLogState.stageDurationsMs ?? {},
            errorCode: 'TURN_ABORTED',
          });
        }
        return sendErrorHead(res, buildError('TURN_ABORTED'));
      }

      // TURN_BUSY (from turn-errors.js) and AUDIO_MALFORMED/AUDIO_TOO_LARGE/
      // AUDIO_CONVERSION_FAILED (thrown per wav.js/convert.js's documented throw-vs-resolve
      // contract) all carry a registered catalogue code already — map straight through.
      if (code && isKnownErrorCode(code)) {
        if (turnLogState) {
          logTurn({
            client: turnLogState.clientName,
            outcome: TURN_OUTCOMES.ERROR,
            durationsMs: turnLogState.stageDurationsMs ?? {},
            errorCode: code,
          });
        }
        return sendErrorHead(res, buildError(code));
      }

      // Anything else collapses to INTERNAL_ERROR. The caught error's message, stack, and
      // any path it carries are logged server-side only (existing console.error
      // convention) and must never reach the client — buildError('INTERNAL_ERROR') with no
      // message argument always falls back to the catalogue's fixed title.
      console.error('[voice-bridge] request failed', error);
      if (turnLogState) {
        logTurn({
          client: turnLogState.clientName,
          outcome: TURN_OUTCOMES.ERROR,
          durationsMs: turnLogState.stageDurationsMs ?? {},
          errorCode: 'INTERNAL_ERROR',
        });
      }
      return sendErrorHead(res, buildError('INTERNAL_ERROR'));
    }
  };
}
