// Contract test: proves the drift loop end to end on the error catalogue (06-01-PLAN.md,
// Task 1 tracer). Three checks, all deriving truth from imported code, never from parsing
// docs/API.md: (1) every ERROR_CODES entry's key and status appear in the doc text, (2) the
// X-Error-Code header name is derived from buildError() and checked against the doc text,
// (3) a live in-process server proves a real 401 and a real 404 match the envelope the doc
// publishes. Boots a real http.createServer with fake adapters — no whisper, no OpenClaw
// CLI, no Kokoro service, no network beyond the loopback socket this file itself opens
// (same hermetic pattern as test/http-turn.test.js).
//
// DIRECTIONALITY NOTE (flagged assumption, 06-01-PLAN.md): this gate only proves one
// direction — that every value the code's own catalogues declare is present in docs/API.md
// and in a live response. It does NOT prove the reverse: a stale doc claim that names an
// error code, header, or format the code has since removed would stay green here, because
// nothing iterates docs/API.md to find claims the running code can no longer honour.
// Narrowed by the append-only error-catalogue rule the doc itself publishes and by 06-03's
// live negotiation checks — do not read a green run here as a fully symmetric guarantee.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createRequestHandler } from '../apps/voice-bridge/request-handler.js';
import { ERROR_CODES } from '../packages/shared/errors/error-codes.js';
import { buildError } from '../packages/shared/errors/error-response.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

const specText = fs.readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');

const TEST_CLIENT_NAME = 'contract-test-client';
const TEST_CLIENT_TOKEN = randomUUID();

function uniqueSessionId(label) {
  return `api-spec-contract-${label}-${randomUUID()}`;
}

// Adapted from test/http-turn.test.js's buildTestConfig: seeds one real security.clients
// entry with a per-run randomUUID() token, so this harness always exercises the
// authenticated path — auth is never disabled here (T-06-03).
function buildTestConfig(securityOverrides = {}) {
  return {
    security: {
      clients: { [TEST_CLIENT_NAME]: TEST_CLIENT_TOKEN },
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

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

function request(port, { method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function buildTestAdapters() {
  return makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
}

// =====================================================================================
// Pattern 2 (06-RESEARCH.md): import the catalogue, check the doc text, never regex-parse
// docs/API.md to derive truth.
// =====================================================================================

for (const [code, { status }] of Object.entries(ERROR_CODES)) {
  test(`docs/API.md documents error code ${code} with its HTTP status ${status}`, () => {
    assert.ok(specText.includes(code), `${code} is missing from docs/API.md`);
    assert.ok(specText.includes(String(status)), `status ${status} for ${code} is missing from docs/API.md`);
  });
}

test('docs/API.md documents the X-Error-Code header name buildError() actually returns', () => {
  const envelope = buildError('NOT_FOUND');
  const [headerName] = Object.keys(envelope.headers);
  assert.ok(specText.includes(headerName), `${headerName} is missing from docs/API.md`);
});

// =====================================================================================
// Live server checks: the doc's published envelope must match a real response, not just a
// literal appearing somewhere in the doc text.
// =====================================================================================

test('a live unauthenticated POST /v1/turn returns 401, x-error-code UNAUTHORIZED, and the published JSON envelope', async () => {
  const config = buildTestConfig();
  const adapters = buildTestAdapters();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await request(port, {
      method: 'POST',
      path: '/v1/turn',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Voice-Input-Format': 'pcm16' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['x-error-code'], 'UNAUTHORIZED');
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(body.error.code, 'UNAUTHORIZED');
    assert.ok(typeof body.error.message === 'string' && body.error.message.length > 0);
  } finally {
    await closeServer(server);
  }
});

test('a live GET to an unmatched path with a valid bearer token returns 404, x-error-code NOT_FOUND, and the published JSON envelope', async () => {
  const config = buildTestConfig();
  const adapters = buildTestAdapters();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await request(port, {
      method: 'GET',
      path: '/v1/does-not-exist',
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers['x-error-code'], 'NOT_FOUND');
    const body = JSON.parse(response.body.toString('utf8'));
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(typeof body.error.message === 'string' && body.error.message.length > 0);
  } finally {
    await closeServer(server);
  }
});
