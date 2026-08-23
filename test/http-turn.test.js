// The first test file in this repository to open a real loopback socket — it exists to
// prove Phase 3's HTTP layer end to end (a real http.createServer, a real listen(0), a real
// client request) against fake adapters, no whisper, no OpenClaw binary, no speech backend
// and no network beyond the loopback socket this file itself opens. Exempted from both
// offline-scan guards (test/convert.test.js, test/turn-suite-hygiene.test.js) via their
// documented HTTP_SOCKET_EXEMPT_FILES sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createRequestHandler } from '../apps/voice-bridge/request-handler.js';
import { buildTurnResponseHead, MAX_REQUEST_AUDIO_BYTES } from '../packages/shared/transport/turn-response.js';
import {
  defaultOutputFormatId,
  WANT_AUDIO_HEADER,
  WANT_AUDIO_DISABLED_TOKEN,
} from '../packages/shared/transport/negotiate.js';
import { wavToPcm } from '../packages/shared/audio/wav.js';
import { prepareClientOutput } from '../packages/shared/audio/convert.js';
import { buildClientDigests, resolveClientIdentity } from '../packages/shared/security/token-auth.js';
import { TURN_OUTCOMES } from '../packages/shared/logging/turn-log.js';
import { makePcm16, makeCanonicalWav, makeStereoWav } from './helpers/fixtures.js';

// Plan 04-05 (WR-01 gap closure): source read of handleTurn's own file, so the structural
// test below can never drift from what actually ships — same convention as
// test/turn-lock.test.js and test/wav.test.js.
const REQUEST_HANDLER_SOURCE_URL = new URL('../apps/voice-bridge/request-handler.js', import.meta.url);

// Plan 05-05 Task 1: resolved from this test file's own location, never from process.cwd(),
// so the byte-identity assertion below points at the real served directory regardless of
// where `node --test` is invoked from.
const REAL_WEB_DIR = new URL('../apps/voice-web/', import.meta.url);

function uniqueSessionId(label) {
  return `http-turn-test-${label}-${randomUUID()}`;
}

function buildTestConfig(securityOverrides = {}) {
  return {
    security: {
      clients: {},
      expectedHost: null,
      allowedOrigins: [],
      rateLimitWindowMs: 15_000,
      rateLimitMaxRequests: 1000,
      ...securityOverrides,
    },
    stt: {},
    openclaw: { sessionId: uniqueSessionId('turn') },
    tts: {},
  };
}

function makeFakeAdapters({ transcript, reply, wavBuffer }) {
  return {
    transcribe: async () => ({ text: transcript, meta: {} }),
    agent: async () => ({ text: reply, rawText: reply, meta: {} }),
    speak: async () => ({ audioBuffer: wavBuffer, mimeType: 'audio/wav', meta: {} }),
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Forces immediate teardown of every connection (including idle keep-alive sockets a test's
// own client left open, e.g. after a declared-Content-Length-mismatch rejection where the
// server never drained the request body) rather than waiting out Node's default 5s
// keepAliveTimeout — server.close() alone only resolves once every connection has ended on
// its own.
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

// setContentLength: false lets a test omit the declared Content-Length entirely (forcing
// Node's client to fall back to Transfer-Encoding: chunked) — needed for the streaming
// body-size-cap test, where no upfront length is declared at all.
function postTurn(port, { body, headers = {}, setContentLength = true }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/turn',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(setContentLength ? { 'Content-Length': body.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: timed out waiting for predicate');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function makeGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function parseErrorBody(body) {
  return JSON.parse(body.toString('utf8'));
}

test('a real client POSTs raw pcm16 bytes to /v1/turn and receives transcript, reply, and audio bytes in one chunked response', async () => {
  const requestPcm = makePcm16({ samples: 8000 });
  const replyPcm = makePcm16({ samples: 4000 });
  const replyWav = makeCanonicalWav({ pcm: replyPcm });

  const fakeTranscript = 'what time is it';
  // Contains a multi-byte UTF-8 character ('°') so byte length must exceed character length.
  const fakeReply = 'The temperature is 22°C today.';

  const adapters = makeFakeAdapters({ transcript: fakeTranscript, reply: fakeReply, wavBuffer: replyWav });
  const config = buildTestConfig();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });

  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: requestPcm,
      headers: { 'X-Voice-Input-Format': 'pcm16' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.headers['cache-control'], 'no-transform');
    assert.equal(response.headers['x-api-version'], '1');
    assert.equal(response.headers['transfer-encoding'], 'chunked');
    assert.equal(response.headers['content-length'], undefined);

    const transcriptBytes = Number(response.headers['x-voice-transcript-bytes']);
    const replyBytes = Number(response.headers['x-voice-reply-bytes']);
    assert.equal(transcriptBytes, Buffer.byteLength(fakeTranscript, 'utf8'));
    assert.equal(replyBytes, Buffer.byteLength(fakeReply, 'utf8'));
    assert.ok(replyBytes > fakeReply.length, 'a multi-byte reply must declare more bytes than its character length');

    const body = response.body;
    const transcriptSegment = body.subarray(0, transcriptBytes);
    const replySegment = body.subarray(transcriptBytes, transcriptBytes + replyBytes);
    const audioSegment = body.subarray(transcriptBytes + replyBytes);

    assert.equal(transcriptSegment.toString('utf8'), fakeTranscript);
    assert.equal(replySegment.toString('utf8'), fakeReply);
    assert.deepEqual(audioSegment, wavToPcm(replyWav));
  } finally {
    await closeServer(server);
  }
});

test('buildTurnResponseHead returns a plain, socket-free object with no ServerResponse or res in scope', () => {
  const head = buildTurnResponseHead({
    transcript: 'a',
    reply: 'b',
    outputFormatId: defaultOutputFormatId(),
    audioPresent: true,
  });

  assert.equal(head.status, 200);
  assert.ok(head.headers);
  assert.ok(Buffer.isBuffer(head.transcriptBuffer));
  assert.ok(Buffer.isBuffer(head.replyBuffer));
  assert.equal(head.transcriptBuffer.toString('utf8'), 'a');
  assert.equal(head.replyBuffer.toString('utf8'), 'b');
});

test('buildTurnResponseHead declares zero transcript-bytes and starts the reply segment at body offset 0 for a zero-length transcript', () => {
  const head = buildTurnResponseHead({
    transcript: '',
    reply: 'reply text',
    outputFormatId: defaultOutputFormatId(),
    audioPresent: false,
  });

  assert.equal(head.headers['X-Voice-Transcript-Bytes'], '0');
  assert.equal(head.transcriptBuffer.length, 0);
  assert.equal(head.replyBuffer.toString('utf8'), 'reply text');
});

// =====================================================================================
// Task 1: one error contract for every /v1/turn failure, and the raw-body size ceiling
// =====================================================================================

test('a wrong bearer token returns 401 with x-error-code UNAUTHORIZED', async () => {
  const config = buildTestConfig({ clients: { 'test-client': 'the-real-token' } });
  const adapters = makeFakeAdapters({ transcript: 'hi', reply: 'ok', wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }) });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['x-error-code'], 'UNAUTHORIZED');
    assert.equal(parseErrorBody(response.body).error.code, 'UNAUTHORIZED');
  } finally {
    await closeServer(server);
  }
});

test('a disallowed host and a disallowed origin both return 403 with x-error-code FORBIDDEN, with byte-identical bodies', async () => {
  const hostConfig = buildTestConfig({ expectedHost: 'expected.example' });
  const hostAdapters = makeFakeAdapters({ transcript: 'hi', reply: 'ok', wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }) });
  const hostHandler = createRequestHandler({ config: hostConfig, adapters: hostAdapters, webDir: '/nonexistent' });
  const hostServer = await startServer(hostHandler);

  const originConfig = buildTestConfig({ allowedOrigins: ['https://allowed.example'] });
  const originAdapters = makeFakeAdapters({ transcript: 'hi', reply: 'ok', wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }) });
  const originHandler = createRequestHandler({ config: originConfig, adapters: originAdapters, webDir: '/nonexistent' });
  const originServer = await startServer(originHandler);

  try {
    const hostResponse = await postTurn(hostServer.address().port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16' },
    });
    const originResponse = await postTurn(originServer.address().port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', Origin: 'https://not-allowed.example' },
    });

    assert.equal(hostResponse.statusCode, 403);
    assert.equal(originResponse.statusCode, 403);
    assert.equal(hostResponse.headers['x-error-code'], 'FORBIDDEN');
    assert.equal(originResponse.headers['x-error-code'], 'FORBIDDEN');
    assert.deepEqual(hostResponse.body, originResponse.body);
  } finally {
    await closeServer(hostServer);
    await closeServer(originServer);
  }
});

// docs/API.md tells every non-browser client to omit Origin entirely, on the strength of the
// `origin &&` guard in validateRequest — an absent Origin passes whatever allowedOrigins holds.
// The test above only proves a *disallowed* Origin is refused, which a guard-less implementation
// satisfies just as well, so nothing pinned the absent case. Dropping that guard would 403 every
// embedded client while leaving the published instruction silently wrong — exactly the class of
// documented-but-ungated claim the milestone retrospective flags. Both configured and absent
// allowedOrigins are asserted, so the claim holds in the deployment that has an origin list
// (where the guard is load-bearing) and not only in the vacuous empty-list case.
test('an absent Origin passes the origin check even when allowedOrigins is configured, as docs/API.md instructs non-browser clients to rely on', async () => {
  const pcm = makePcm16({ samples: 10 });
  const wavBuffer = makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) });

  for (const allowedOrigins of [['https://allowed.example'], []]) {
    const config = buildTestConfig({ allowedOrigins });
    const adapters = makeFakeAdapters({ transcript: 'hi', reply: 'ok', wavBuffer });
    const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
    const server = await startServer(handler);

    try {
      const response = await postTurn(server.address().port, {
        body: pcm,
        headers: { 'X-Voice-Input-Format': 'pcm16' },
      });

      assert.equal(
        response.statusCode,
        200,
        `a request carrying no Origin must complete with allowedOrigins=${JSON.stringify(allowedOrigins)} — docs/API.md instructs embedded clients to send none`,
      );
      assert.equal(response.headers['x-error-code'], undefined);
    } finally {
      await closeServer(server);
    }
  }
});

// WINDOWS.md id 5: one expectedHost value must admit both deployment shapes at once — a
// Serve-fronted browser (port 443, so no port suffix on the wire) and a TLS-less client
// addressing the bridge directly on its own port (which sends that port in Host verbatim) —
// with no config edit between them. Same server instance, same config, three requests.
test('one array-valued expectedHost admits both a bare hostname and a hostname:port Host, and still refuses an unrelated one', async () => {
  const config = buildTestConfig({ expectedHost: ['expected.example', 'expected.example:4318'] });
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);

  try {
    const port = server.address().port;
    const send = (hostHeader) =>
      postTurn(port, {
        body: makePcm16({ samples: 10 }),
        headers: { 'X-Voice-Input-Format': 'pcm16', Host: hostHeader },
      });

    const serveFronted = await send('expected.example');
    const directTlsLess = await send('expected.example:4318');
    const unrelated = await send('wrong-host.example');

    assert.equal(serveFronted.statusCode, 200, 'the Serve-fronted Host (no port suffix) must be admitted');
    assert.equal(directTlsLess.statusCode, 200, 'the direct TLS-less Host (explicit port) must be admitted by the same config');
    assert.equal(unrelated.statusCode, 403, 'a host matching no allowlist entry must still be refused');
    assert.equal(unrelated.headers['x-error-code'], 'FORBIDDEN');
  } finally {
    await closeServer(server);
  }
});

test('exceeding the rate limit returns 429 with x-error-code RATE_LIMITED', async () => {
  const config = buildTestConfig({ rateLimitMaxRequests: 1 });
  const adapters = makeFakeAdapters({ transcript: 'hi', reply: 'ok', wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }) });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const first = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(first.statusCode, 200);
    const second = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(second.statusCode, 429);
    assert.equal(second.headers['x-error-code'], 'RATE_LIMITED');
    assert.equal(parseErrorBody(second.body).error.code, 'RATE_LIMITED');
  } finally {
    await closeServer(server);
  }
});

test('an unregistered X-Voice-Input-Format returns 415 with x-error-code FMT_UNSUPPORTED and a body listing supported formats', async () => {
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({ transcript: 'hi', reply: 'ok', wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }) });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'not-a-real-format' },
    });
    assert.equal(response.statusCode, 415);
    assert.equal(response.headers['x-error-code'], 'FMT_UNSUPPORTED');
    const body = parseErrorBody(response.body);
    assert.ok(Array.isArray(body.error.supportedFormats) && body.error.supportedFormats.length > 0);
  } finally {
    await closeServer(server);
  }
});

test('a declared Content-Length over MAX_REQUEST_AUDIO_BYTES is refused 413 before any body byte is consumed', async () => {
  let transcribeCallCount = 0;
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => {
      transcribeCallCount += 1;
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'ok', meta: {} }),
    speak: async () => ({ audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} }),
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const smallBody = makePcm16({ samples: 10 });
    const response = await postTurn(port, {
      body: smallBody,
      headers: {
        'X-Voice-Input-Format': 'pcm16',
        'Content-Length': String(MAX_REQUEST_AUDIO_BYTES + 1),
      },
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.headers['x-error-code'], 'AUDIO_TOO_LARGE');
    assert.equal(transcribeCallCount, 0);
  } finally {
    await closeServer(server);
  }
});

test('a body that streams past MAX_REQUEST_AUDIO_BYTES without a declared length is refused 413', async () => {
  let transcribeCallCount = 0;
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => {
      transcribeCallCount += 1;
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'ok', meta: {} }),
    speak: async () => ({ audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} }),
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const oversizedBody = Buffer.alloc(MAX_REQUEST_AUDIO_BYTES + 1024);
    const response = await postTurn(port, {
      body: oversizedBody,
      headers: { 'X-Voice-Input-Format': 'pcm16' },
      setContentLength: false,
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.headers['x-error-code'], 'AUDIO_TOO_LARGE');
    assert.equal(transcribeCallCount, 0);
  } finally {
    await closeServer(server);
  }
});

test('a fake transcribe adapter returning whitespace-only text returns 422 with x-error-code TRANSCRIPT_EMPTY', async () => {
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: '   ', meta: {} }),
    agent: async () => {
      throw new Error('agent must not be called when the transcript is empty');
    },
    speak: async () => {
      throw new Error('speak must not be called when the transcript is empty');
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(response.statusCode, 422);
    assert.equal(response.headers['x-error-code'], 'TRANSCRIPT_EMPTY');
    assert.equal(parseErrorBody(response.body).error.code, 'TRANSCRIPT_EMPTY');
  } finally {
    await closeServer(server);
  }
});

test('a second concurrent turn returns 409 with x-error-code TURN_BUSY', async () => {
  const gate = makeGate();
  const calls = [];
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => {
      calls.push('transcribe');
      await gate.promise;
      return { text: 'hi', meta: {} };
    },
    agent: async () => {
      calls.push('agent');
      return { text: 'ok', rawText: 'ok', meta: {} };
    },
    speak: async () => {
      calls.push('speak');
      return { audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} };
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const firstPromise = postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    await waitUntil(() => calls.length === 1);

    const second = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(second.statusCode, 409);
    assert.equal(second.headers['x-error-code'], 'TURN_BUSY');
    assert.deepEqual(calls, ['transcribe'], 'the second request must not have added any stage calls');

    gate.release();
    const first = await firstPromise;
    assert.equal(first.statusCode, 200);
    assert.deepEqual(calls, ['transcribe', 'agent', 'speak']);
  } finally {
    await closeServer(server);
  }
});

test('a fake agent adapter that throws an ordinary error returns 500 with x-error-code INTERNAL_ERROR and a body leaking neither the message nor a path', async () => {
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: 'hi', meta: {} }),
    agent: async () => {
      throw new Error('/private/tmp/leaked-secret-path/reason-12345');
    },
    speak: async () => {
      throw new Error('speak must not be called');
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(response.statusCode, 500);
    assert.equal(response.headers['x-error-code'], 'INTERNAL_ERROR');
    const body = parseErrorBody(response.body);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!body.error.message.includes('leaked-secret-path'));
    assert.ok(!body.error.message.includes('/'));
  } finally {
    await closeServer(server);
  }
});

test('an unknown path returns 404 with x-error-code NOT_FOUND', async () => {
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({ transcript: 'hi', reply: 'ok', wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }) });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/does-not-exist' }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['x-error-code'], 'NOT_FOUND');
    assert.equal(parseErrorBody(response.body).error.code, 'NOT_FOUND');
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// Task 2: text-only turns, text-before-synthesis ordering, and mid-turn disconnect
// =====================================================================================

test('X-Voice-Want-Audio set to the disabled token returns 200 with no audio segment and the fake speak adapter is never called', async () => {
  let speakCallCount = 0;
  const fakeTranscript = 'hello';
  const fakeReply = 'ok then';
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: fakeTranscript, meta: {} }),
    agent: async () => ({ text: fakeReply, rawText: fakeReply, meta: {} }),
    speak: async () => {
      speakCallCount += 1;
      throw new Error('speak must not be called when audio is disabled');
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', 'X-Voice-Want-Audio': '0' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-voice-audio-present'], '0');
    const transcriptBytes = Number(response.headers['x-voice-transcript-bytes']);
    const replyBytes = Number(response.headers['x-voice-reply-bytes']);
    assert.equal(response.body.length, transcriptBytes + replyBytes);
    assert.equal(speakCallCount, 0);
  } finally {
    await closeServer(server);
  }
});

test('the same request with X-Voice-Want-Audio absent returns audio-present 1 and a non-empty audio segment', async () => {
  const fakeTranscript = 'hello';
  const fakeReply = 'ok then';
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 20 }) });
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({ transcript: fakeTranscript, reply: fakeReply, wavBuffer: replyWav });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-voice-audio-present'], '1');
    const transcriptBytes = Number(response.headers['x-voice-transcript-bytes']);
    const replyBytes = Number(response.headers['x-voice-reply-bytes']);
    assert.ok(response.body.length > transcriptBytes + replyBytes);
  } finally {
    await closeServer(server);
  }
});

test('the client can read the full text preamble before the speak stage resolves — an ordering proof, not a timing one', async () => {
  const gate = makeGate();
  const fakeTranscript = 'hello there';
  const fakeReply = 'a careful reply';
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 50 }) });
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: fakeTranscript, meta: {} }),
    agent: async () => ({ text: fakeReply, rawText: fakeReply, meta: {} }),
    speak: async () => {
      await gate.promise;
      return { audioBuffer: replyWav, mimeType: 'audio/wav', meta: {} };
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const requestBody = makePcm16({ samples: 10 });
    const result = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/turn',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': requestBody.length,
            'X-Voice-Input-Format': 'pcm16',
          },
        },
        (res) => {
          const expectedTextBytes =
            Number(res.headers['x-voice-transcript-bytes']) + Number(res.headers['x-voice-reply-bytes']);
          let receivedBytes = 0;
          let released = false;
          const chunks = [];
          res.on('data', (chunk) => {
            chunks.push(chunk);
            receivedBytes += chunk.length;
            // The client has now received both full text segments off the wire — only
            // now does the test let synthesis finish. If the handler ever buffered the
            // whole turn before writing anything, this data event (and this release)
            // would never fire until well after speak had already resolved on its own —
            // this is an assertion on arrival order, not on elapsed time.
            if (!released && receivedBytes >= expectedTextBytes) {
              released = true;
              gate.release();
            }
          });
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    assert.equal(Number(result.headers['x-voice-audio-present']), 1);
    const transcriptBytes = Number(result.headers['x-voice-transcript-bytes']);
    const replyBytes = Number(result.headers['x-voice-reply-bytes']);
    assert.equal(result.body.subarray(0, transcriptBytes).toString('utf8'), fakeTranscript);
    assert.equal(result.body.subarray(transcriptBytes, transcriptBytes + replyBytes).toString('utf8'), fakeReply);
    assert.deepEqual(result.body.subarray(transcriptBytes + replyBytes), wavToPcm(replyWav));
  } finally {
    await closeServer(server);
  }
});

test('a fake agent adapter returning an empty string yields reply-bytes 0 with the audio segment starting immediately after the transcript', async () => {
  const fakeTranscript = 'hello';
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 20 }) });
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: fakeTranscript, meta: {} }),
    agent: async () => ({ text: '', rawText: '', meta: {} }),
    speak: async () => ({ audioBuffer: replyWav, mimeType: 'audio/wav', meta: {} }),
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-voice-reply-bytes'], '0');
    const transcriptBytes = Number(response.headers['x-voice-transcript-bytes']);
    const audioSegment = response.body.subarray(transcriptBytes);
    assert.deepEqual(audioSegment, wavToPcm(replyWav));
  } finally {
    await closeServer(server);
  }
});

test('two overlapping requests where the first is text-only still yield one 200 and one 409', async () => {
  const gate = makeGate();
  const calls = [];
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => {
      calls.push('transcribe');
      await gate.promise;
      return { text: 'hi', meta: {} };
    },
    agent: async () => {
      calls.push('agent');
      return { text: 'ok', rawText: 'ok', meta: {} };
    },
    speak: async () => {
      calls.push('speak');
      throw new Error('speak must not be called for a text-only turn');
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const firstPromise = postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', 'X-Voice-Want-Audio': '0' },
    });
    await waitUntil(() => calls.length === 1);

    const second = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(second.statusCode, 409);
    assert.equal(second.headers['x-error-code'], 'TURN_BUSY');

    gate.release();
    const first = await firstPromise;
    assert.equal(first.statusCode, 200);
    assert.deepEqual(calls, ['transcribe', 'agent']);
  } finally {
    await closeServer(server);
  }
});

test('a client that destroys its socket mid-turn causes the in-flight fake speak adapter to observe an aborted signal', async () => {
  const gate = makeGate();
  const inFlightControllers = new Set();
  let observedAborted = null;
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: 'hello', meta: {} }),
    agent: async () => ({ text: 'a careful reply', rawText: 'a careful reply', meta: {} }),
    speak: async (text, ttsConfig, { signal } = {}) => {
      await gate.promise;
      observedAborted = signal?.aborted ?? false;
      if (signal?.aborted) {
        // Realistic adapter behavior: a well-behaved adapter rejects once it observes its
        // own signal aborted, letting the pipeline's runStage() normalize this to
        // TurnAbortedError rather than resolving a reply nobody will ever receive.
        throw new Error('speak observed an aborted signal');
      }
      return { audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} };
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent', inFlightControllers });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const body = makePcm16({ samples: 10 });
    let headersReceived = false;
    const clientReq = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/turn',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          'X-Voice-Input-Format': 'pcm16',
        },
      },
      (res) => {
        headersReceived = true;
        res.on('data', () => {});
        res.on('error', () => {});
      },
    );
    // Destroying the request mid-flight is expected to surface a client-side socket error —
    // this is the disconnect being proven, not a failure of the test.
    clientReq.on('error', () => {});
    clientReq.write(body);
    clientReq.end();

    await waitUntil(() => headersReceived);
    clientReq.destroy();

    // The server's response 'close' event is driven by the underlying socket teardown, not
    // synchronous with clientReq.destroy() — poll the tracked controller's own signal
    // directly, rather than sleeping a fixed guess at how long that teardown takes, so this
    // assertion is deterministic instead of CI-load-dependent (WR-07).
    await waitUntil(() => [...inFlightControllers][0]?.signal.aborted === true);
    gate.release();
    await waitUntil(() => observedAborted !== null);

    assert.equal(observedAborted, true);
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// Task 3: wire hygiene — assert on the raw response header block, not on intent
// =====================================================================================

// Reads res.rawHeaders (the flat, un-deduplicated wire array) rather than res.headers (an
// object Node already flattens/overwrites duplicates into) so a duplicated or
// later-overwritten header is visible to the assertion instead of silently collapsed.
function assertWireHygiene(response) {
  const pairs = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    pairs.push([response.rawHeaders[i].toLowerCase(), response.rawHeaders[i + 1]]);
  }
  const names = pairs.map(([name]) => name);

  assert.ok(!names.includes('set-cookie'), 'response must never carry a Set-Cookie header');
  assert.ok(
    response.statusCode < 300 || response.statusCode >= 400,
    `response status ${response.statusCode} must never be a 3xx redirect`,
  );
  for (const [name, value] of pairs) {
    if (name === 'content-encoding') {
      assert.equal(value, 'identity', 'any content-encoding present must be exactly identity');
    }
  }
  const cacheControlPairs = pairs.filter(([name]) => name === 'cache-control');
  assert.equal(cacheControlPairs.length, 1, 'cache-control must appear exactly once in the raw header block');
  assert.ok(
    cacheControlPairs[0][1].includes('no-transform'),
    'cache-control must include the no-transform directive',
  );
}

// WIRE-HYGIENE-COVERAGE-ANCHOR: 200-audio
test('wire hygiene: a 200 response with audio carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control', async () => {
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(response.statusCode, 200);
    assertWireHygiene(response);
  } finally {
    await closeServer(server);
  }
});

// WIRE-HYGIENE-COVERAGE-ANCHOR: 200-text
test('wire hygiene: a 200 text-only response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control', async () => {
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', 'X-Voice-Want-Audio': '0' },
    });
    assert.equal(response.statusCode, 200);
    assertWireHygiene(response);
  } finally {
    await closeServer(server);
  }
});

// WIRE-HYGIENE-COVERAGE-ANCHOR: 401
test('wire hygiene: a 401 response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control', async () => {
  const config = buildTestConfig({ clients: { 'test-client': 'the-real-token' } });
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(response.statusCode, 401);
    assertWireHygiene(response);
  } finally {
    await closeServer(server);
  }
});

// WIRE-HYGIENE-COVERAGE-ANCHOR: 413
test('wire hygiene: a 413 response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control', async () => {
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: {
        'X-Voice-Input-Format': 'pcm16',
        'Content-Length': String(MAX_REQUEST_AUDIO_BYTES + 1),
      },
    });
    assert.equal(response.statusCode, 413);
    assertWireHygiene(response);
  } finally {
    await closeServer(server);
  }
});

// WIRE-HYGIENE-COVERAGE-ANCHOR: 415
test('wire hygiene: a 415 response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control', async () => {
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'not-a-real-format' },
    });
    assert.equal(response.statusCode, 415);
    assertWireHygiene(response);
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// Plan 03-06: pin the adapter-to-transport contract — every real speech path now returns
// a WAV buffer, and prepareClientOutput() must accept it. Asserted from both the passing
// side (matching shape, differing shape) and the failing side (a non-RIFF buffer, the
// regression this whole plan exists to remove), plus a re-assertion that D-01's 415 for a
// container-format reply request is unchanged.
// =====================================================================================

test('prepareClientOutput accepts a WAV already at the pcm16 registry shape with no subprocess spawned', async () => {
  const pcm = makePcm16({ samples: 100 });
  const result = await prepareClientOutput(makeCanonicalWav({ pcm }), 'pcm16');
  assert.equal(result.meta.spawned, false);
  assert.deepEqual(result.buffer, pcm);
});

test('prepareClientOutput resamples a differently-shaped WAV rather than rejecting it', async () => {
  const pcm = makePcm16({ samples: 100 });
  const result = await prepareClientOutput(makeStereoWav({ pcm }), 'pcm16');
  assert.equal(result.meta.converted, true);
  assert.ok(result.buffer.length > 0);
});

test('prepareClientOutput throws AUDIO_MALFORMED for a non-RIFF buffer — the regression this plan removes, asserted from the failing side', async () => {
  await assert.rejects(
    () => prepareClientOutput(Buffer.from('not-a-riff-container'), 'pcm16'),
    (err) => {
      assert.equal(err.code, 'AUDIO_MALFORMED');
      return true;
    },
  );
});

test('prepareClientOutput still resolves the 415 FMT_UNSUPPORTED envelope for a container-format reply request — D-01 unchanged by this plan', async () => {
  const pcm = makePcm16({ samples: 100 });
  const result = await prepareClientOutput(makeCanonicalWav({ pcm }), 'wav');
  assert.equal(result.error.status, 415);
  assert.equal(result.error.headers['X-Error-Code'], 'FMT_UNSUPPORTED');
});

test('a full POST /v1/turn whose fake speak adapter returns exactly what the rewritten real adapters now return (a WAV buffer, audio/wav) yields a byte-identical audio segment', async () => {
  const pcm = makePcm16({ samples: 200 });
  const replyWav = makeCanonicalWav({ pcm });
  const fakeTranscript = 'hello';
  const fakeReply = 'hi there';
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: fakeTranscript, meta: {} }),
    agent: async () => ({ text: fakeReply, rawText: fakeReply, meta: {} }),
    speak: async () => ({ audioBuffer: replyWav, mimeType: 'audio/wav', meta: {} }),
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(response.statusCode, 200);
    const transcriptBytes = Number(response.headers['x-voice-transcript-bytes']);
    const replyBytes = Number(response.headers['x-voice-reply-bytes']);
    const audioSegment = response.body.subarray(transcriptBytes + replyBytes);
    assert.deepEqual(audioSegment, wavToPcm(replyWav));
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// 03-REVIEW.md CR-01/CR-02 regression coverage: both findings describe a process crash,
// not a wrong response — the fix must keep the server (and every other in-flight turn)
// alive, not just return a nicer status code. Each test below proves survival by making a
// second, ordinary request against the same server immediately after the crash-inducing
// one.
// =====================================================================================

test('CR-01 regression: a corrupt speech buffer thrown as AUDIO_MALFORMED after headers were already flushed truncates the response instead of crashing the process', async () => {
  const fakeTranscript = 'hello';
  const fakeReply = 'ok then';
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: fakeTranscript, meta: {} }),
    agent: async () => ({ text: fakeReply, rawText: fakeReply, meta: {} }),
    // Not a RIFF container — prepareClientOutput() throws AUDIO_MALFORMED for this. By the
    // time this resolves, the transcript/reply preamble is already flushed (writeHead + two
    // writes already on the wire), which is exactly the post-headers-sent throw CR-01
    // describes.
    speak: async () => ({ audioBuffer: Buffer.from('not-a-riff-container'), mimeType: 'audio/wav', meta: {} }),
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const body = makePcm16({ samples: 10 });

    // The server destroying the response mid-stream (post-fix behavior) surfaces to this
    // client as a socket reset rather than a clean 'end' — on either the response object or
    // the request object, depending on timing. Neither is a test failure: both are resolved
    // to whatever partial data arrived, since the point of this test is that the process
    // survives, not that the client sees a graceful close.
    const response = await new Promise((resolve) => {
      const chunks = [];
      const result = { statusCode: null, headers: {} };
      const finish = () => resolve({ ...result, body: Buffer.concat(chunks) });
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/turn',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': body.length,
            'X-Voice-Input-Format': 'pcm16',
          },
        },
        (res) => {
          result.statusCode = res.statusCode;
          result.headers = res.headers;
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', finish);
          res.on('error', finish);
        },
      );
      req.on('error', finish);
      req.write(body);
      req.end();
    });

    // With fake adapters resolving synchronously, the writeHead/write/destroy sequence all
    // happens within one tick, faster than the loopback socket flushes — so the client may
    // see the connection reset before its HTTP parser ever completes a status line (a bare
    // ECONNRESET, statusCode still null) rather than a parsed 200 followed by a truncated
    // body. Both are proof the fix never attempted a second writeHead: if it had, Node
    // would have thrown ERR_HTTP_HEADERS_SENT server-side regardless of what the client
    // observed. When a status line %does% get through, it must be the original 200 — never
    // a second, different status.
    if (response.statusCode !== null) {
      assert.equal(response.statusCode, 200);
      const transcriptBytes = Number(response.headers['x-voice-transcript-bytes']);
      const replyBytes = Number(response.headers['x-voice-reply-bytes']);
      // No audio bytes were ever written once the throw happened — the body ends at or
      // before the reply segment boundary, never carrying a bogus audio segment.
      assert.ok(response.body.length <= transcriptBytes + replyBytes);
    }

    // The real assertion: the server process is still alive. If the pre-fix bug had fired
    // (ERR_HTTP_HEADERS_SENT as an unhandled rejection), Node's default
    // --unhandled-rejections=throw would have already killed the process, and this
    // follow-up request would never complete.
    const followUp = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', 'X-Voice-Want-Audio': '0' },
    });
    assert.equal(followUp.statusCode, 200);
  } finally {
    await closeServer(server);
  }
});

test('CR-02 regression: GET / against a webDir missing index.html returns 404 instead of crashing the process', async () => {
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  // A real, existing directory with no index.html/app.js in it — createReadStream() fails
  // with ENOENT, the exact unguarded-stream-error path CR-02 describes. This project's own
  // repo root always exists and never happens to contain these two filenames at its top
  // level.
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  try {
    const port = server.address().port;

    const response = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal(response.statusCode, 404);

    // Process survival proof, same shape as the CR-01 test above: a second GET /app.js
    // against the same missing-file webDir, and an ordinary /v1/turn request, must both
    // still succeed.
    const appJsResponse = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/app.js' }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(appJsResponse.statusCode, 404);

    const followUp = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', 'X-Voice-Want-Audio': '0' },
    });
    assert.equal(followUp.statusCode, 200);
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// Plan 05-05 Task 1 (WEB-01/WEB-02): the served page is proven byte-identical to the file on
// disk — not merely "some 200 response" — so any future templating, token interpolation, or
// host substitution step fails this test rather than shipping. Both static routes are also
// proven reachable with no Authorization header, recording that the page itself carries no
// operator state and needs none. A separate browser-shaped turn proves WEB-01's endpoint-
// parity claim on the same route the CLI uses.
// =====================================================================================

test('WEB-02: GET / and GET /app.js return the on-disk apps/voice-web bytes unchanged, with no Authorization header present', async () => {
  const webDir = REAL_WEB_DIR;
  const indexPath = path.join(webDir.pathname, 'index.html');
  const appJsPath = path.join(webDir.pathname, 'app.js');
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: webDir.pathname });
  const server = await startServer(handler);
  try {
    const port = server.address().port;

    const getRoute = (route) =>
      new Promise((resolve, reject) => {
        // Deliberately no Authorization header on either request — the property under test
        // is that the page is reachable without one.
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: route }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
      });

    const indexResponse = await getRoute('/');
    assert.equal(indexResponse.statusCode, 200);
    assert.deepEqual(indexResponse.body, fs.readFileSync(indexPath));
    assert.equal(indexResponse.headers['content-type'], 'text/html; charset=utf-8');

    const appJsResponse = await getRoute('/app.js');
    assert.equal(appJsResponse.statusCode, 200);
    assert.deepEqual(appJsResponse.body, fs.readFileSync(appJsPath));
    assert.equal(appJsResponse.headers['content-type'], 'application/javascript; charset=utf-8');
  } finally {
    await closeServer(server);
  }
});

test('WEB-01: a browser-shaped turn — canonical WAV body, X-Voice-Input-Format: wav, a bearer token, no output-format header — completes 200 on the same /v1/turn route the CLI uses', async () => {
  const config = buildTestConfig({ clients: { browser: 'browser-token' } });
  const adapters = makeFakeAdapters({
    transcript: 'what is the weather',
    reply: 'sunny today',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 20 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const wavBody = makeCanonicalWav({ pcm: makePcm16({ samples: 30 }) });

    const response = await postTurn(port, {
      body: wavBody,
      headers: { 'X-Voice-Input-Format': 'wav', Authorization: 'Bearer browser-token' },
    });

    assert.equal(response.statusCode, 200);
    assert.ok('x-voice-transcript-bytes' in response.headers);
    assert.ok('x-voice-reply-bytes' in response.headers);
    assert.equal(response.headers['x-voice-audio-present'], '1');
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// Plan 05-05 Task 2: the turn lock (packages/shared/session/turn-lock.js) is keyed by
// sessionId alone and carries no client field — this test proves that structural fact
// behaviorally, across two distinct authenticated identities, in both directions. The
// existing 409 coverage above (line ~409 and line ~630) proves the lock is global to a
// process; it runs against a config with no named clients at all, so it never exercises the
// identity axis this test adds.
// =====================================================================================

test('the turn lock refuses a different client\'s turn while another client holds it, symmetric in both directions', async () => {
  async function assertCrossClientBusy({ holderToken, refusedToken }) {
    const gate = makeGate();
    const calls = [];
    const config = buildTestConfig({ clients: { alpha: 'alpha-token', beta: 'beta-token' } });
    const adapters = {
      transcribe: async () => {
        calls.push('transcribe');
        await gate.promise;
        return { text: 'hi', meta: {} };
      },
      agent: async () => {
        calls.push('agent');
        return { text: 'ok', rawText: 'ok', meta: {} };
      },
      speak: async () => {
        calls.push('speak');
        return { audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} };
      },
    };
    const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
    const server = await startServer(handler);
    try {
      const port = server.address().port;

      const holderPromise = postTurn(port, {
        body: makePcm16({ samples: 10 }),
        headers: { 'X-Voice-Input-Format': 'pcm16', Authorization: `Bearer ${holderToken}` },
      });
      await waitUntil(() => calls.length === 1);

      const refused = await postTurn(port, {
        body: makePcm16({ samples: 10 }),
        headers: { 'X-Voice-Input-Format': 'pcm16', Authorization: `Bearer ${refusedToken}` },
      });
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.headers['x-error-code'], 'TURN_BUSY');
      assert.deepEqual(calls, ['transcribe'], 'the refused client\'s request must not have added any adapter stage calls');

      gate.release();
      const holder = await holderPromise;
      assert.equal(holder.statusCode, 200);
      assert.deepEqual(calls, ['transcribe', 'agent', 'speak']);
    } finally {
      await closeServer(server);
    }
  }

  // Direction 1: alpha holds, beta is refused.
  await assertCrossClientBusy({ holderToken: 'alpha-token', refusedToken: 'beta-token' });
  // Direction 2: swapped — beta holds, alpha is refused. Proves the refusal is symmetric
  // rather than an artifact of which client happened to send the request first.
  await assertCrossClientBusy({ holderToken: 'beta-token', refusedToken: 'alpha-token' });
});

// =====================================================================================
// Plan 04-01: multi-client identity end to end — two named clients, resolved name reaching
// the injected logTurn collector, an unknown token refused before the body is read, and
// identity- (never address-) keyed rate-limit buckets.
// =====================================================================================

// A fake, never-connects-a-real-socket async-iterable request, exercised directly against
// the handler function createRequestHandler() returns — used to prove AUTH-04's
// before-body-read ordering (test 4) and rate-limit-bucket identity (test 5) without needing
// a second real TCP client whose own socket.remoteAddress cannot be spoofed.
function makeFakeTurnReq({ headers, body, remoteAddress = '127.0.0.1' }) {
  let advanced = false;
  let yielded = false;
  return {
    method: 'POST',
    url: '/v1/turn',
    headers,
    socket: { remoteAddress },
    get bodyIteratorAdvanced() {
      return advanced;
    },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          advanced = true;
          if (!yielded && body) {
            yielded = true;
            return { done: false, value: body };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

// A fake ServerResponse capturing status/headers/body without ever touching a real socket.
function makeFakeTurnRes() {
  const chunks = [];
  return {
    statusCode: null,
    headers: {},
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.writableEnded = true;
    },
    on() {
      // handleTurn registers a 'close' listener; this fake response never fires it.
    },
    get body() {
      return Buffer.concat(chunks);
    },
  };
}

test('two named clients each authenticate with their own token over a real socket, and the injected logTurn collector records the resolved name and three numeric stage durations per turn', async () => {
  const fakeTranscript = 'what time is it';
  const fakeReply = 'noon';
  const wavBuffer = makeCanonicalWav({ pcm: makePcm16({ samples: 20 }) });
  const adapters = makeFakeAdapters({ transcript: fakeTranscript, reply: fakeReply, wavBuffer });
  const config = buildTestConfig({ clients: { alpha: 'alpha-token', beta: 'beta-token' } });
  const records = [];
  const handler = createRequestHandler({
    config,
    adapters,
    webDir: '/nonexistent',
    logTurn: (record) => records.push(record),
  });
  const server = await startServer(handler);
  try {
    const port = server.address().port;

    const alphaResponse = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', Authorization: 'Bearer alpha-token' },
    });
    assert.equal(alphaResponse.statusCode, 200);

    const betaResponse = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', Authorization: 'Bearer beta-token' },
    });
    assert.equal(betaResponse.statusCode, 200);

    assert.equal(records.length, 2);
    assert.equal(records[0].client, 'alpha');
    assert.equal(records[1].client, 'beta');
    for (const record of records) {
      assert.equal(typeof record.durationsMs.transcribe, 'number');
      assert.equal(typeof record.durationsMs.agent, 'number');
      assert.equal(typeof record.durationsMs.speak, 'number');
    }
  } finally {
    await closeServer(server);
  }
});

test('a token matching neither configured client returns 401 with x-error-code UNAUTHORIZED', async () => {
  const config = buildTestConfig({ clients: { alpha: 'alpha-token', beta: 'beta-token' } });
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', Authorization: 'Bearer someone-elses-token' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['x-error-code'], 'UNAUTHORIZED');
  } finally {
    await closeServer(server);
  }
});

test('AUTH-04: an unresolvable-token request is refused 401 before the fake request body-reading iterator is ever advanced', async () => {
  const config = buildTestConfig({ clients: { alpha: 'alpha-token' } });
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });

  const req = makeFakeTurnReq({
    headers: { 'x-voice-input-format': 'pcm16', authorization: 'Bearer wrong-token' },
    body: makePcm16({ samples: 10 }),
  });
  const res = makeFakeTurnRes();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(req.bodyIteratorAdvanced, false);
});

test('resolveClientIdentity(buildClientDigests({ a: "x" }), "") returns null and does not throw', () => {
  const digests = buildClientDigests({ a: 'x' });
  assert.equal(resolveClientIdentity(digests, ''), null);
});

test('rate-limit buckets are keyed by resolved client identity, not by source address: two requests carrying one client\'s token from two different socket addresses draw on one bucket, and the other client\'s token is still admitted', async () => {
  const config = buildTestConfig({ clients: { alpha: 'alpha-token', beta: 'beta-token' }, rateLimitMaxRequests: 1 });
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });

  const body = makePcm16({ samples: 10 });
  const headersFor = (token) => ({ 'x-voice-input-format': 'pcm16', authorization: `Bearer ${token}` });

  const firstRes = makeFakeTurnRes();
  await handler(makeFakeTurnReq({ headers: headersFor('alpha-token'), body, remoteAddress: '10.0.0.1' }), firstRes);
  assert.equal(firstRes.statusCode, 200);

  const secondRes = makeFakeTurnRes();
  await handler(makeFakeTurnReq({ headers: headersFor('alpha-token'), body, remoteAddress: '10.0.0.2' }), secondRes);
  assert.equal(secondRes.statusCode, 429);

  const thirdRes = makeFakeTurnRes();
  await handler(makeFakeTurnReq({ headers: headersFor('beta-token'), body, remoteAddress: '10.0.0.3' }), thirdRes);
  assert.equal(thirdRes.statusCode, 200);
});

// =====================================================================================
// Plan 04-02: OPS-01's credential-free guarantee, proven end to end through the real call
// site — not just through a direct logTurnCompletion() call (see test/turn-log.test.js).
// =====================================================================================

// =====================================================================================
// Plan 04-04 Task 1: inFlightControllers tracks every in-flight turn's own AbortController,
// draining it on every way a turn can end — success, thrown error, and abort alike. This is
// the set 04-04's shutdown handler will later abort from; proving it here (rather than in
// shutdown.test.js) keeps the proof anchored to the real handleTurn() call site instead of a
// double.
// =====================================================================================

test('inFlightControllers has size 1 while a turn is held open on an unresolved adapter promise, and size 0 once the turn completes', async () => {
  const gate = makeGate();
  const inFlightControllers = new Set();
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => {
      await gate.promise;
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'ok', meta: {} }),
    speak: async () => ({ audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} }),
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent', inFlightControllers });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const turnPromise = postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    await waitUntil(() => inFlightControllers.size === 1);
    assert.equal(inFlightControllers.size, 1);

    gate.release();
    const response = await turnPromise;
    assert.equal(response.statusCode, 200);
    assert.equal(inFlightControllers.size, 0);
  } finally {
    await closeServer(server);
  }
});

test('inFlightControllers is empty after a turn whose adapter threw', async () => {
  const inFlightControllers = new Set();
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: 'hi', meta: {} }),
    agent: async () => {
      throw new Error('agent failed on purpose');
    },
    speak: async () => {
      throw new Error('speak must not be called');
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent', inFlightControllers });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(response.statusCode, 500);
    assert.equal(inFlightControllers.size, 0);
  } finally {
    await closeServer(server);
  }
});

test('inFlightControllers is empty after a turn whose client disconnected mid-flight', async () => {
  const gate = makeGate();
  const inFlightControllers = new Set();
  const config = buildTestConfig();
  const adapters = {
    transcribe: async () => ({ text: 'hello', meta: {} }),
    agent: async () => ({ text: 'a careful reply', rawText: 'a careful reply', meta: {} }),
    speak: async (text, ttsConfig, { signal } = {}) => {
      await gate.promise;
      if (signal?.aborted) {
        throw new Error('speak observed an aborted signal');
      }
      return { audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} };
    },
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent', inFlightControllers });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const body = makePcm16({ samples: 10 });
    let headersReceived = false;
    const clientReq = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/turn',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          'X-Voice-Input-Format': 'pcm16',
        },
      },
      (res) => {
        headersReceived = true;
        res.on('data', () => {});
        res.on('error', () => {});
      },
    );
    clientReq.on('error', () => {});
    clientReq.write(body);
    clientReq.end();

    await waitUntil(() => headersReceived);
    await waitUntil(() => inFlightControllers.size === 1);
    clientReq.destroy();

    // Poll the tracked controller's own signal directly rather than sleeping a fixed guess
    // at how long socket teardown takes, so this assertion is deterministic instead of
    // CI-load-dependent (WR-07).
    await waitUntil(() => [...inFlightControllers][0]?.signal.aborted === true);
    gate.release();
    await waitUntil(() => inFlightControllers.size === 0);
    assert.equal(inFlightControllers.size, 0);
  } finally {
    await closeServer(server);
  }
});

test('aborting the tracked controller directly while a turn is held open ends the response and drains the set — proving it is the same controller the disconnect path uses', async () => {
  const gate = makeGate();
  const inFlightControllers = new Set();
  const config = buildTestConfig();
  const adapters = {
    transcribe: async (audioBuffer, sttConfig, { signal } = {}) => {
      await gate.promise;
      if (signal?.aborted) {
        throw new Error('transcribe observed an aborted signal');
      }
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'ok', meta: {} }),
    speak: async () => ({ audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} }),
  };
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent', inFlightControllers });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const turnPromise = postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    await waitUntil(() => inFlightControllers.size === 1);

    const [controller] = inFlightControllers;
    controller.abort();
    gate.release();

    const response = await turnPromise;
    assert.equal(response.statusCode, 499);
    await waitUntil(() => inFlightControllers.size === 0);
    assert.equal(inFlightControllers.size, 0);
  } finally {
    await closeServer(server);
  }
});

test('OPS-01: a real turn whose configured client token, transcript, and reply are each a distinct sentinel yields a collected record containing none of the three', async () => {
  const TOKEN_SENTINEL = 'sentinel-token-h3x9v2qz';
  const TRANSCRIPT_SENTINEL = 'sentinel-transcript-r5t1c8mn';
  const REPLY_SENTINEL = 'sentinel-reply-w2n7q4kd';
  const wavBuffer = makeCanonicalWav({ pcm: makePcm16({ samples: 20 }) });
  const adapters = makeFakeAdapters({ transcript: TRANSCRIPT_SENTINEL, reply: REPLY_SENTINEL, wavBuffer });
  const config = buildTestConfig({ clients: { sentinel: TOKEN_SENTINEL } });
  const records = [];
  const handler = createRequestHandler({
    config,
    adapters,
    webDir: '/nonexistent',
    logTurn: (record) => records.push(record),
  });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'pcm16', Authorization: `Bearer ${TOKEN_SENTINEL}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(records.length, 1);
    const serialised = JSON.stringify(records[0]);
    assert.ok(!serialised.includes(TOKEN_SENTINEL));
    assert.ok(!serialised.includes(TRANSCRIPT_SENTINEL));
    assert.ok(!serialised.includes(REPLY_SENTINEL));
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// Plan 04-05 (gap closure): 04-VERIFICATION.md gap 1 (WR-01) — a turn rejected before any
// pipeline stage runs must still reach the turn log, naming the resolved client and the
// right error code. D-13: the negotiate() branch is proven behaviorally below; the
// prepareTranscriptionInput() branch is proven structurally instead, since it has no
// offline-reachable trigger over HTTP.
// =====================================================================================

test('WR-01: two turns rejected at format negotiation under two different client tokens each yield exactly one collected record naming that client, outcome error, errorCode FMT_UNSUPPORTED, and no stage timings', async () => {
  let transcribeCallCount = 0;
  const config = buildTestConfig({ clients: { alpha: 'alpha-token', beta: 'beta-token' } });
  const adapters = {
    transcribe: async () => {
      transcribeCallCount += 1;
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'ok', meta: {} }),
    speak: async () => ({ audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} }),
  };
  const records = [];
  const handler = createRequestHandler({
    config,
    adapters,
    webDir: '/nonexistent',
    logTurn: (record) => records.push(record),
  });
  const server = await startServer(handler);
  try {
    const port = server.address().port;

    const alphaResponse = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'not-a-real-format', Authorization: 'Bearer alpha-token' },
    });
    const betaResponse = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { 'X-Voice-Input-Format': 'not-a-real-format', Authorization: 'Bearer beta-token' },
    });

    assert.equal(alphaResponse.statusCode, 415);
    assert.equal(alphaResponse.headers['x-error-code'], 'FMT_UNSUPPORTED');
    assert.equal(betaResponse.statusCode, 415);
    assert.equal(betaResponse.headers['x-error-code'], 'FMT_UNSUPPORTED');

    assert.equal(records.length, 2);
    assert.equal(records[0].client, 'alpha');
    assert.equal(records[1].client, 'beta');
    for (const record of records) {
      assert.equal(record.outcome, TURN_OUTCOMES.ERROR);
      assert.equal(record.errorCode, 'FMT_UNSUPPORTED');
      assert.deepEqual(record.durationsMs, {});
    }
    assert.equal(transcribeCallCount, 0);
  } finally {
    await closeServer(server);
  }
});

test('WR-01: both of handleTurn\'s sendErrorHead-direct-return branches call logTurn between the branch condition and the return, with comment lines excluded from the scan', () => {
  const source = fs.readFileSync(REQUEST_HANDLER_SOURCE_URL, 'utf8');

  const branchPairs = [
    { openMarker: 'if (negotiated.error) {', returnMarker: 'return sendErrorHead(res, negotiated.error);' },
    { openMarker: 'if (prepared.error) {', returnMarker: 'return sendErrorHead(res, prepared.error);' },
  ];

  for (const { openMarker, returnMarker } of branchPairs) {
    const openIndex = source.indexOf(openMarker);
    const returnIndex = source.indexOf(returnMarker);
    assert.notEqual(openIndex, -1, `expected to find "${openMarker}" in request-handler.js`);
    assert.notEqual(returnIndex, -1, `expected to find "${returnMarker}" in request-handler.js`);
    assert.equal(openIndex, source.lastIndexOf(openMarker), `"${openMarker}" must appear exactly once`);
    assert.equal(returnIndex, source.lastIndexOf(returnMarker), `"${returnMarker}" must appear exactly once`);
    assert.ok(openIndex < returnIndex, `"${openMarker}" must precede its own "${returnMarker}"`);

    const region = source.slice(openIndex, returnIndex);
    const surviving = region
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    assert.ok(surviving.includes('logTurn({'), `region for "${openMarker}" must call logTurn({ before returning`);
    assert.ok(surviving.includes('TURN_OUTCOMES.ERROR'), `region for "${openMarker}" must log TURN_OUTCOMES.ERROR`);
  }
});

test('GAP-2 / AUTH-05 / T-4-05: clientName reaches only rate-limit bucket key and logTurn calls, never adapter/config construction', () => {
  const source = fs.readFileSync(REQUEST_HANDLER_SOURCE_URL, 'utf8');

  // The critical forbidden regions where clientName must NEVER appear
  // Extract these blocks and verify they contain no clientName token in the field/argument position

  // Region 1: turnAdapters construction block — clientName must not appear
  const turnAdaptersMarker = 'const turnAdapters = {';
  const turnAdaptersStart = source.indexOf(turnAdaptersMarker);
  assert.notEqual(turnAdaptersStart, -1, 'expected to find turnAdapters construction');
  const turnAdaptersEnd = source.indexOf('      };', turnAdaptersStart); // The closing brace of the object
  const turnAdaptersBlock = source.slice(turnAdaptersStart, turnAdaptersEnd + 7);
  const turnAdaptersStripped = turnAdaptersBlock
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    !turnAdaptersStripped.includes('clientName'),
    'turnAdapters block must NOT contain clientName — config selection must use only config.* values (T-4-05)',
  );

  // Region 2: runTurn({ ... }) call — clientName must not appear in the arguments
  const runTurnMarker = 'const runTurnPromise = runTurn({';
  const runTurnStart = source.indexOf(runTurnMarker);
  assert.notEqual(runTurnStart, -1, 'expected to find runTurn call');
  const runTurnEnd = source.indexOf('      });', runTurnStart);
  const runTurnBlock = source.slice(runTurnStart, runTurnEnd + 8);
  const runTurnStripped = runTurnBlock
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    !runTurnStripped.includes('clientName'),
    'runTurn(...) call must NOT pass clientName as an argument — config objects are built from config.* only (T-4-05)',
  );
});

// =====================================================================================
// GAP TESTS: Verify behaviors that surviving mutations would break
// =====================================================================================

// Helper to capture turn-log lines (console.log output)
function captureLogLines(fn) {
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => {
    lines.push(line);
  };
  try {
    return fn(lines);
  } finally {
    console.log = originalLog;
  }
}

test('G3 / OPS-01 / T-4-04: a text-only successful turn emits exactly one turn-log line with outcome ok', async () => {
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript: 'hello',
    reply: 'world',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);

  try {
    const port = server.address().port;
    const originalLog = console.log;
    const lines = [];
    console.log = (line) => {
      lines.push(line);
    };

    try {
      // Text-only turn: wantAudio=false
      const response = await postTurn(port, {
        body: makePcm16({ samples: 10 }),
        // The header is X-Voice-Want-Audio (singular) and the only disabling token is the
        // literal '0' (transport/negotiate.js) — any other spelling or value leaves wantAudio
        // true, which would silently route this turn through the *audio* success branch and
        // assert nothing about the text-only one.
        headers: {
          'X-Voice-Input-Format': 'pcm16',
          'X-Voice-Output-Format': 'pcm16',
          [WANT_AUDIO_HEADER]: WANT_AUDIO_DISABLED_TOKEN,
        },
      });
      assert.equal(response.statusCode, 200);
      // Proves this turn really settled on the text-only branch rather than the audio one —
      // without this the assertion below would still pass against the audio success path,
      // which is a different (already-covered) log call site.
      assert.equal(
        response.headers['x-voice-audio-present'],
        '0',
        'this turn must settle on the text-only branch for the log assertion below to mean anything',
      );

      // Should have exactly one log line
      const turnLogLines = lines.filter((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed.event === 'turn';
        } catch {
          return false;
        }
      });
      assert.equal(turnLogLines.length, 1, 'text-only turn should emit exactly one turn-log line');

      const logRecord = JSON.parse(turnLogLines[0]);
      assert.equal(logRecord.outcome, 'ok', 'text-only successful turn should have outcome ok');
    } finally {
      console.log = originalLog;
    }
  } finally {
    await closeServer(server);
  }
});

test('G4 / OPS-01 / T-4-04: a turn with an adapter throwing an unknown error logs INTERNAL_ERROR', async () => {
  const config = buildTestConfig();
  const faultyAdapter = {
    transcribe: async () => {
      const err = new Error('something went wrong');
      err.code = 'UNKNOWN_CODE'; // Not a registered error code
      throw err;
    },
    agent: async () => ({ text: '', rawText: '', meta: {} }),
    speak: async () => ({ audioBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }), mimeType: 'audio/wav', meta: {} }),
  };

  const handler = createRequestHandler({ config, adapters: faultyAdapter, webDir: '/nonexistent' });
  const server = await startServer(handler);

  try {
    const port = server.address().port;
    const originalLog = console.log;
    const lines = [];
    console.log = (line) => {
      lines.push(line);
    };

    try {
      const response = await postTurn(port, {
        body: makePcm16({ samples: 10 }),
        headers: { 'X-Voice-Input-Format': 'pcm16' },
      });
      // Should get a 500 or similar error
      assert.ok(response.statusCode >= 400);

      const turnLogLines = lines.filter((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed.event === 'turn';
        } catch {
          return false;
        }
      });
      assert.equal(turnLogLines.length, 1, 'errored turn should emit exactly one turn-log line');

      const logRecord = JSON.parse(turnLogLines[0]);
      assert.equal(logRecord.outcome, 'error', 'error turn should have outcome error');
      assert.equal(logRecord.errorCode, 'INTERNAL_ERROR', 'unknown error codes should be logged as INTERNAL_ERROR');
    } finally {
      console.log = originalLog;
    }
  } finally {
    await closeServer(server);
  }
});

test('G1 / AUTH-05 / T-4-02: failed-auth requests from different source addresses all draw on one fixed-key bucket', async () => {
  const config = buildTestConfig({
    clients: { device1: 'device1-secret-value-12345' },
  });
  const adapters = makeFakeAdapters({
    transcript: 'test',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);

  try {
    const port = server.address().port;
    // Send FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS + 1 bad-auth requests
    // Each with a different bad token (simulating different callers trying different credentials)
    // If the bucket is per-address, they might not throttle. If it's a fixed key, they share.
    const maxRequests = 20; // FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS = 20
    const responses = [];

    for (let i = 0; i < maxRequests + 1; i++) {
      const response = await postTurn(port, {
        body: makePcm16({ samples: 10 }),
        headers: {
          'X-Voice-Input-Format': 'pcm16',
          'Authorization': `Bearer bad-token-${i}`,
        },
      });
      responses.push(response.statusCode);
    }

    // First 20 should be 401 (UNAUTHORIZED), the 21st should be 429 (RATE_LIMITED)
    for (let i = 0; i < maxRequests; i++) {
      assert.equal(responses[i], 401, `request ${i + 1} should be UNAUTHORIZED (401)`);
    }
    assert.equal(responses[maxRequests], 429, `request ${maxRequests + 1} should be RATE_LIMITED (429)`);
  } finally {
    await closeServer(server);
  }
});

test('G5 / AUTH-05 / WR-03: host mismatch rejection draws on the failed-auth throttle, not an unbounded stream', async () => {
  // Build a custom config with expectedHost set
  const config = {
    security: {
      clients: { device1: 'device1-secret-value-12345' },
      expectedHost: 'expected.example.com',
      allowedOrigins: [],
      rateLimitWindowMs: 15_000,
      rateLimitMaxRequests: 1000,
    },
    stt: {},
    openclaw: { sessionId: uniqueSessionId('turn') },
    tts: {},
  };

  const adapters = makeFakeAdapters({
    transcript: 'test',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);

  try {
    const port = server.address().port;
    // Send more than FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS (20) host-mismatched requests
    const maxFailedAuth = 20;
    const responses = [];

    for (let i = 0; i < maxFailedAuth + 1; i++) {
      const response = await postTurn(port, {
        body: makePcm16({ samples: 10 }),
        headers: {
          'X-Voice-Input-Format': 'pcm16',
          'Host': 'wrong-host.example.com', // Does not match expectedHost
        },
      });
      responses.push(response.statusCode);
    }

    // First 20 should be 403 (FORBIDDEN), the 21st should be 429 (RATE_LIMITED)
    // If the host-mismatch path doesn't use the failed-auth bucket, we'd see all 403s
    for (let i = 0; i < maxFailedAuth; i++) {
      assert.equal(responses[i], 403, `request ${i + 1} should be FORBIDDEN (403)`);
    }
    assert.equal(
      responses[maxFailedAuth],
      429,
      `request ${maxFailedAuth + 1} should be RATE_LIMITED (429) — host-mismatch must draw on failed-auth bucket`,
    );
  } finally {
    await closeServer(server);
  }
});
