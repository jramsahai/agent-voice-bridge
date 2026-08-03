// GET /v1/health — the reachability of transcription, agent, and speech, as line-based text
// (D-02, locked), each backed by the same TTL-windowed backend-health-cache the speech
// adapter itself reads. Real-socket test file (03-01's http-turn.test.js precedent);
// exempted from both offline-scan guards (test/convert.test.js, test/turn-suite-hygiene.test.js)
// via their documented HTTP_SOCKET_EXEMPT_FILES sets — this file legitimately opens real
// loopback sockets (the request-handler's own server, plus a throwaway health-probe target).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { createRequestHandler } from '../apps/voice-bridge/request-handler.js';
import {
  getBackendStatus,
  resetBackendHealthCache,
  BACKEND_UP,
  BACKEND_DOWN,
} from '../packages/shared/health/backend-health-cache.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

function uniqueSessionId(label) {
  return `http-health-test-${label}-${randomUUID()}`;
}

const UNRESOLVABLE_COMMAND = 'this-command-does-not-exist-anywhere-xyz';
const UNREACHABLE_SERVICE_URL = 'http://127.0.0.1:1';

function buildTestConfig({ security = {}, stt = {}, openclaw = {}, tts = {} } = {}) {
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
    stt: { command: UNRESOLVABLE_COMMAND, ...stt },
    openclaw: { sessionId: uniqueSessionId('health'), command: UNRESOLVABLE_COMMAND, ...openclaw },
    tts: { serviceUrl: UNREACHABLE_SERVICE_URL, ...tts },
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

// A throwaway health-probe target — this file's own http.createServer(), answering the
// probeHttpService('/health') path with a 200, exactly the shape a live Kokoro FastAPI
// service would answer, so the all-up case is proven real rather than mocked.
function startProbeTargetServer() {
  return startServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      return res.end('ok');
    }
    res.writeHead(404);
    res.end();
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

// Splits the body into ordered [key, value] pairs, asserting the ': '-split shape holds
// for every non-empty line rather than comparing against one expected blob.
function parseLineBody(body) {
  const lines = body.split('\n').filter((line) => line.length > 0);
  return lines.map((line) => {
    const idx = line.indexOf(': ');
    assert.ok(idx > 0, `line '${line}' does not split into a non-empty key and a defined value on ': '`);
    return [line.slice(0, idx), line.slice(idx + 2)];
  });
}

test.beforeEach(() => {
  resetBackendHealthCache();
});

test('the body split on newline yields exactly three backend lines named transcribe, agent, speech, in that order, on two successive calls', async () => {
  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const first = await getPath(port, '/v1/health');
    const second = await getPath(port, '/v1/health');

    for (const response of [first, second]) {
      const pairs = parseLineBody(response.body);
      assert.deepEqual(pairs.map(([key]) => key), ['transcribe', 'agent', 'speech']);
    }
  } finally {
    await closeServer(server);
  }
});

test('each backend line value is strictly BACKEND_UP or BACKEND_DOWN', async () => {
  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const response = await getPath(server.address().port, '/v1/health');
    const pairs = parseLineBody(response.body);
    for (const [, value] of pairs) {
      assert.ok(value === BACKEND_UP || value === BACKEND_DOWN, `value '${value}' must be BACKEND_UP or BACKEND_DOWN`);
    }
  } finally {
    await closeServer(server);
  }
});

test('D-04 locked contract: all three backends resolving returns exactly 200, and exactly one unresolvable backend returns exactly 503, with the full three-line body present in both cases and the same key set', async () => {
  const probeTargetServer = await startProbeTargetServer();
  const probeTargetPort = probeTargetServer.address().port;

  const upConfig = buildTestConfig({
    stt: { command: process.execPath },
    openclaw: { command: process.execPath },
    tts: { serviceUrl: `http://127.0.0.1:${probeTargetPort}` },
  });
  const upHandler = createRequestHandler({ config: upConfig, adapters: {}, webDir: '/nonexistent' });
  const upServer = await startServer(upHandler);

  const downConfig = buildTestConfig({ stt: { command: process.execPath }, openclaw: { command: process.execPath } });
  const downHandler = createRequestHandler({ config: downConfig, adapters: {}, webDir: '/nonexistent' });
  const downServer = await startServer(downHandler);

  try {
    const upResponse = await getPath(upServer.address().port, '/v1/health');
    assert.equal(upResponse.statusCode, 200);
    const upPairs = parseLineBody(upResponse.body);
    assert.deepEqual(
      upPairs.map(([, value]) => value),
      [BACKEND_UP, BACKEND_UP, BACKEND_UP],
    );

    resetBackendHealthCache();

    const downResponse = await getPath(downServer.address().port, '/v1/health');
    assert.equal(downResponse.statusCode, 503);
    const downPairs = parseLineBody(downResponse.body);
    assert.deepEqual(downPairs.map(([key]) => key).sort(), upPairs.map(([key]) => key).sort());
    assert.ok(downPairs.some(([, value]) => value === BACKEND_DOWN));
  } finally {
    await closeServer(upServer);
    await closeServer(downServer);
    await closeServer(probeTargetServer);
  }
});

test('ten concurrent GET /v1/health requests issued inside one TTL window leave each backend counting fake probe at a call count of 1', async () => {
  const counts = { transcribe: 0, agent: 0, speech: 0 };
  await Promise.all([
    getBackendStatus('transcribe', async () => {
      counts.transcribe += 1;
    }),
    getBackendStatus('agent', async () => {
      counts.agent += 1;
    }),
    getBackendStatus('speech', async () => {
      counts.speech += 1;
    }),
  ]);
  assert.deepEqual(counts, { transcribe: 1, agent: 1, speech: 1 });

  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const responses = await Promise.all(Array.from({ length: 10 }, () => getPath(port, '/v1/health')));
    for (const response of responses) {
      assert.ok([200, 503].includes(response.statusCode));
    }

    // If any of the ten requests above had re-probed instead of reading the primed cache
    // entries, it would have done so through the handler's own probeExecutable/
    // probeHttpService closures, never through these fakes — so the counts staying exactly
    // 1 proves at most one probe per backend ran across all ten requests.
    assert.deepEqual(counts, { transcribe: 1, agent: 1, speech: 1 });
  } finally {
    await closeServer(server);
  }
});

test('the body contains no service URL, filesystem path, or probe error text — reconstructing the body from its parsed pairs matches the received body byte-for-byte', async () => {
  const handler = createRequestHandler({ config: buildTestConfig(), adapters: {}, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const response = await getPath(server.address().port, '/v1/health');
    const pairs = parseLineBody(response.body);
    const reconstructed = pairs.map(([key, value]) => `${key}: ${value}`).join('\n') + '\n';
    assert.equal(reconstructed, response.body);
    assert.ok(!response.body.includes('/'), 'body must contain no path separator');
  } finally {
    await closeServer(server);
  }
});

test('GET /v1/health issued while a fake-adapter turn is in flight returns 200 or 503, never 409', async () => {
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

    const healthResponse = await getPath(port, '/v1/health');
    assert.ok([200, 503].includes(healthResponse.statusCode));
    assert.notEqual(healthResponse.statusCode, 409);

    gate.release();
    const turnResponse = await turnPromise;
    assert.equal(turnResponse.statusCode, 200);
  } finally {
    await closeServer(server);
  }
});

test('a wrong bearer token returns 401 with a line-based body, not the JSON envelope', async () => {
  const handler = createRequestHandler({
    config: buildTestConfig({ security: { token: 'the-real-token' } }),
    adapters: {},
    webDir: '/nonexistent',
  });
  const server = await startServer(handler);
  try {
    const response = await getPath(server.address().port, '/v1/health', { Authorization: 'Bearer wrong-token' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['x-error-code'], 'UNAUTHORIZED');
    const firstLine = response.body.split('\n')[0];
    const idx = firstLine.indexOf(': ');
    assert.ok(idx > 0, 'first line must split into a key and a value on \': \'');
    assert.equal(firstLine.slice(0, idx), 'error-code');
  } finally {
    await closeServer(server);
  }
});
