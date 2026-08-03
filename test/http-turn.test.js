// The first test file in this repository to open a real loopback socket — it exists to
// prove Phase 3's HTTP layer end to end (a real http.createServer, a real listen(0), a real
// client request) against fake adapters, no whisper, no OpenClaw binary, no speech backend
// and no network beyond the loopback socket this file itself opens. Exempted from both
// offline-scan guards (test/convert.test.js, test/turn-suite-hygiene.test.js) via their
// documented HTTP_SOCKET_EXEMPT_FILES sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { createRequestHandler } from '../apps/voice-bridge/request-handler.js';
import { buildTurnResponseHead, MAX_REQUEST_AUDIO_BYTES } from '../packages/shared/transport/turn-response.js';
import { defaultOutputFormatId } from '../packages/shared/transport/negotiate.js';
import { wavToPcm } from '../packages/shared/audio/wav.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

function uniqueSessionId(label) {
  return `http-turn-test-${label}-${randomUUID()}`;
}

function buildTestConfig(securityOverrides = {}) {
  return {
    security: {
      token: '',
      expectedHost: null,
      allowedOrigins: [],
      maxJsonBytes: 50_000_000,
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

// =====================================================================================
// Task 1: one error contract for every /v1/turn failure, and the raw-body size ceiling
// =====================================================================================

test('a wrong bearer token returns 401 with x-error-code UNAUTHORIZED', async () => {
  const config = buildTestConfig({ token: 'the-real-token' });
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
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
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
    // synchronous with clientReq.destroy() — give the event loop a short window for it to
    // actually fire and abort the controller before releasing the gate.
    await new Promise((resolve) => setTimeout(resolve, 100));
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

test('wire hygiene: a 401 response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control', async () => {
  const config = buildTestConfig({ token: 'the-real-token' });
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
