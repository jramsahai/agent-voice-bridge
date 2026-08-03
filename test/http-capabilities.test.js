// GET /v1/capabilities — the whole /v1/turn vocabulary, discoverable as line-based text
// with no JSON parser required (D-02, locked). Real-socket test file (03-01's http-turn.test.js
// precedent); exempted from both offline-scan guards (test/convert.test.js,
// test/turn-suite-hygiene.test.js) via their documented HTTP_SOCKET_EXEMPT_FILES sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { createRequestHandler, DISCOVERY_RATE_LIMIT_MAX_REQUESTS } from '../apps/voice-bridge/request-handler.js';
import {
  MAX_REQUEST_AUDIO_BYTES,
  TRANSCRIPT_BYTES_HEADER,
  REPLY_BYTES_HEADER,
} from '../packages/shared/transport/turn-response.js';
import {
  listReplyFormats,
  defaultOutputFormatId,
  INPUT_FORMAT_HEADER,
  OUTPUT_FORMAT_HEADER,
  WANT_AUDIO_HEADER,
} from '../packages/shared/transport/negotiate.js';
import { listSupportedFormats } from '../packages/shared/audio/format-registry.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

function uniqueSessionId(label) {
  return `http-capabilities-test-${label}-${randomUUID()}`;
}

function buildTestConfig({ security = {}, tts = { voices: ['af_heart', 'af_bella'] } } = {}) {
  return {
    security: {
      token: '',
      expectedHost: null,
      allowedOrigins: [],
      maxJsonBytes: 50_000_000,
      rateLimitWindowMs: 15_000,
      rateLimitMaxRequests: 1000,
      ...security,
    },
    stt: {},
    openclaw: { sessionId: uniqueSessionId('capabilities') },
    tts,
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

function getPath(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function postTurn(port, { body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/turn',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
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

// Parses the line-based body into an ordered Map, asserting the ': '-split shape holds for
// every non-empty line rather than comparing against one expected blob.
function parseLineBody(body) {
  const map = new Map();
  const lines = body.split('\n').filter((line) => line.length > 0);
  for (const line of lines) {
    const idx = line.indexOf(': ');
    assert.ok(idx > 0, `line '${line}' does not split into a non-empty key and a defined value on ': '`);
    const key = line.slice(0, idx);
    const value = line.slice(idx + 2);
    assert.ok(key.length > 0);
    assert.ok(value !== undefined);
    map.set(key, value);
  }
  return map;
}

test('GET /v1/capabilities returns 200 text/plain with every non-empty line a key: value pair', async () => {
  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const response = await getPath(server.address().port, '/v1/capabilities');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    const pairs = parseLineBody(response.body);
    assert.ok(pairs.size > 0);
  } finally {
    await closeServer(server);
  }
});

test('the input-formats, reply-formats, default-reply-format, and max-audio-bytes lines are derived from the registry and exported constants', async () => {
  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const response = await getPath(server.address().port, '/v1/capabilities');
    const pairs = parseLineBody(response.body);

    assert.deepEqual(pairs.get('input-formats').split(','), listSupportedFormats());
    assert.deepEqual(pairs.get('reply-formats').split(','), listReplyFormats());
    assert.equal(pairs.get('default-reply-format'), defaultOutputFormatId());
    assert.equal(Number.parseInt(pairs.get('max-audio-bytes'), 10), MAX_REQUEST_AUDIO_BYTES);
  } finally {
    await closeServer(server);
  }
});

test('the voices line deep-equals the config voices list, and a config with voice but no voices still yields a one-entry list', async () => {
  const multiVoiceHandler = createRequestHandler({
    config: buildTestConfig({ tts: { voices: ['af_heart', 'af_bella'] } }),
    adapters: {},
    webDir: '/nonexistent',
  });
  const multiVoiceServer = await startServer(multiVoiceHandler);

  const singleVoiceHandler = createRequestHandler({
    config: buildTestConfig({ tts: { voice: 'af_heart' } }),
    adapters: {},
    webDir: '/nonexistent',
  });
  const singleVoiceServer = await startServer(singleVoiceHandler);

  try {
    const multiResponse = await getPath(multiVoiceServer.address().port, '/v1/capabilities');
    const multiPairs = parseLineBody(multiResponse.body);
    assert.deepEqual(multiPairs.get('voices').split(','), ['af_heart', 'af_bella']);

    const singleResponse = await getPath(singleVoiceServer.address().port, '/v1/capabilities');
    const singlePairs = parseLineBody(singleResponse.body);
    assert.deepEqual(singlePairs.get('voices').split(','), ['af_heart']);
  } finally {
    await closeServer(multiVoiceServer);
    await closeServer(singleVoiceServer);
  }
});

test('the body names all three request header names and both byte-count response header names', async () => {
  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const response = await getPath(server.address().port, '/v1/capabilities');
    for (const headerName of [
      INPUT_FORMAT_HEADER,
      OUTPUT_FORMAT_HEADER,
      WANT_AUDIO_HEADER,
      TRANSCRIPT_BYTES_HEADER,
      REPLY_BYTES_HEADER,
    ]) {
      assert.ok(response.body.includes(headerName), `body must name header '${headerName}'`);
    }
  } finally {
    await closeServer(server);
  }
});

test('a request with a wrong bearer token returns 401 with a line-based body, not the JSON envelope', async () => {
  const handler = createRequestHandler({
    config: buildTestConfig({ security: { token: 'the-real-token' } }),
    adapters: {},
    webDir: '/nonexistent',
  });
  const server = await startServer(handler);
  try {
    const response = await getPath(server.address().port, '/v1/capabilities', {
      Authorization: 'Bearer wrong-token',
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['x-error-code'], 'UNAUTHORIZED');
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
    const firstLine = response.body.split('\n')[0];
    const idx = firstLine.indexOf(': ');
    assert.ok(idx > 0, 'first line must split into a key and a value on \': \'');
    assert.equal(firstLine.slice(0, idx), 'error-code');
    assert.equal(firstLine.slice(idx + 2), 'UNAUTHORIZED');
  } finally {
    await closeServer(server);
  }
});

test('GET /v1/capabilities issued while a fake-adapter turn is in flight returns 200, not 409', async () => {
  const gate = makeGate();
  const calls = [];
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
  const handler = createRequestHandler({ config: buildTestConfig(), adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const turnPromise = postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    await waitUntil(() => calls.length === 1);

    const capabilitiesResponse = await getPath(port, '/v1/capabilities');
    assert.equal(capabilitiesResponse.statusCode, 200);

    gate.release();
    const turnResponse = await turnPromise;
    assert.equal(turnResponse.statusCode, 200);
  } finally {
    await closeServer(server);
  }
});

function makeFakeAdapters({ transcript, reply, wavBuffer }) {
  return {
    transcribe: async () => ({ text: transcript, meta: {} }),
    agent: async () => ({ text: reply, rawText: reply, meta: {} }),
    speak: async () => ({ audioBuffer: wavBuffer, mimeType: 'audio/wav', meta: {} }),
  };
}

// =====================================================================================
// Task 3: the discovery endpoints' own rate-limit bucket
// =====================================================================================

test(`${DISCOVERY_RATE_LIMIT_MAX_REQUESTS} sequential GET /v1/capabilities requests from one address all return 200`, async () => {
  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    for (let i = 0; i < DISCOVERY_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await getPath(port, '/v1/capabilities');
      assert.equal(response.statusCode, 200, `request ${i + 1} must return 200`);
    }
  } finally {
    await closeServer(server);
  }
});

test('a burst that exhausts the turn bucket leaves a subsequent GET /v1/capabilities admissible, and a burst that exhausts the discovery bucket leaves a subsequent POST /v1/turn admissible', async () => {
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const config = buildTestConfig({ security: { rateLimitMaxRequests: 6, rateLimitWindowMs: 15_000 } });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;

    // Exhaust the turn bucket: six admitted, the seventh refused 429.
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
      assert.equal(response.statusCode, 200, `turn ${i + 1} must be admitted`);
    }
    const seventhTurn = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.equal(seventhTurn.statusCode, 429);

    const capabilitiesAfterTurnBurst = await getPath(port, '/v1/capabilities');
    assert.equal(capabilitiesAfterTurnBurst.statusCode, 200, 'a poller must not be crowded out by an exhausted turn bucket');
  } finally {
    await closeServer(server);
  }
});

test('after a burst that exhausts the discovery bucket, a POST /v1/turn from the same address is still admitted', async () => {
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const config = buildTestConfig({ security: { rateLimitMaxRequests: 6, rateLimitWindowMs: 15_000 } });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;

    for (let i = 0; i < DISCOVERY_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await getPath(port, '/v1/capabilities');
    }
    const turnResponse = await postTurn(port, { body: makePcm16({ samples: 10 }), headers: { 'X-Voice-Input-Format': 'pcm16' } });
    assert.notEqual(turnResponse.statusCode, 429, 'an exhausted discovery bucket must never block a turn');
  } finally {
    await closeServer(server);
  }
});

test(`request number ${DISCOVERY_RATE_LIMIT_MAX_REQUESTS + 1} to GET /v1/capabilities inside one window returns 429 with a line-based RATE_LIMITED body`, async () => {
  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    for (let i = 0; i < DISCOVERY_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await getPath(port, '/v1/capabilities');
    }
    const overLimit = await getPath(port, '/v1/capabilities');
    assert.equal(overLimit.statusCode, 429);
    assert.equal(overLimit.headers['x-error-code'], 'RATE_LIMITED');
    const firstLine = overLimit.body.split('\n')[0];
    const idx = firstLine.indexOf(': ');
    assert.ok(idx > 0, 'first line must split into a key and a value on \': \' — it is not JSON');
    assert.equal(firstLine.slice(0, idx), 'error-code');
    assert.equal(firstLine.slice(idx + 2), 'RATE_LIMITED');
  } finally {
    await closeServer(server);
  }
});
