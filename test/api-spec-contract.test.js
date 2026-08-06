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
import {
  API_VERSION,
  MAX_REQUEST_AUDIO_BYTES,
  TRANSCRIPT_BYTES_HEADER,
  REPLY_BYTES_HEADER,
  AUDIO_PRESENT_HEADER,
  OUTPUT_FORMAT_RESPONSE_HEADER,
} from '../packages/shared/transport/turn-response.js';
import {
  listReplyFormats,
  defaultOutputFormatId,
  INPUT_FORMAT_HEADER,
  OUTPUT_FORMAT_HEADER,
  WANT_AUDIO_HEADER,
  WANT_AUDIO_DISABLED_TOKEN,
} from '../packages/shared/transport/negotiate.js';
import { listSupportedFormats } from '../packages/shared/audio/format-registry.js';
import { BACKEND_UP, BACKEND_DOWN } from '../packages/shared/health/backend-health-cache.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

const specText = fs.readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');

const TEST_CLIENT_NAME = 'contract-test-client';
const TEST_CLIENT_TOKEN = randomUUID();

// Matches config/config.example.json's tts.voices — the value docs/API.md's capabilities
// example body cites, so the live 'voices' line and the doc's worked example agree.
const EXAMPLE_VOICES = ['af_heart'];

function uniqueSessionId(label) {
  return `api-spec-contract-${label}-${randomUUID()}`;
}

// Adapted from test/http-turn.test.js's buildTestConfig: seeds one real security.clients
// entry with a per-run randomUUID() token, so this harness always exercises the
// authenticated path — auth is never disabled here (T-06-03). tts.voices defaults to the
// example config's list (06-04-PLAN.md Task 1) so a capabilities response built from this
// config matches docs/API.md's worked example.
function buildTestConfig({ security = {}, tts = { voices: EXAMPLE_VOICES } } = {}) {
  return {
    security: {
      clients: { [TEST_CLIENT_NAME]: TEST_CLIENT_TOKEN },
      expectedHost: null,
      allowedOrigins: [],
      rateLimitWindowMs: 15_000,
      rateLimitMaxRequests: 1000,
      ...security,
    },
    stt: {},
    openclaw: { sessionId: uniqueSessionId('turn') },
    tts,
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

// POST /v1/turn helper (mirrors test/http-turn.test.js's postTurn): writes a real body and
// sets Content-Length automatically, so a caller only supplies the audio bytes and any
// header overrides (bearer token, negotiation headers).
function postTurn(port, { body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/turn',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
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

// Task 2: a future bump to API_VERSION must fail the build until docs/API.md follows —
// checked against the imported constant, never a typed '1'.
test('docs/API.md states the API_VERSION constant in an api-version context', () => {
  const versionPattern = new RegExp(`api-version[^\\n]*${API_VERSION}|X-API-Version[^\\n]*${API_VERSION}`, 'i');
  assert.ok(
    versionPattern.test(specText),
    `API_VERSION (${API_VERSION}) not found in an api-version/X-API-Version context in docs/API.md`,
  );
});

// Task 2: deleted-surface guard. Both literals are hand-typed deliberately — they are
// values that must never appear in docs/API.md, not a catalogue being duplicated, so there
// is nothing to import. The pre-Phase-3 turn endpoint and the singular shared-secret
// security config key were both removed with no compatibility shim, and validateConfig()
// now rejects the latter at startup — a document naming either would send a firmware team
// down a dead path.
test('docs/API.md does not resurrect the removed pre-Phase-3 turn endpoint or the removed singular security.token config key', () => {
  assert.ok(
    !specText.includes('/api/turn'),
    'docs/API.md must not document /api/turn — it was deleted with no compatibility shim and the running code no longer routes to it',
  );
  assert.ok(
    !specText.includes('security.token'),
    'docs/API.md must not document security.token — validateConfig rejects it at startup; clients authenticate via security.clients',
  );
});

// =====================================================================================
// Task 1 (06-03-PLAN.md): what a client sends — auth, request headers, formats, limits.
// Same Pattern 2 rule: import the constant, check the doc text, never type a duplicate.
// =====================================================================================

test('docs/API.md documents the three X-Voice-* request header names', () => {
  for (const headerName of [INPUT_FORMAT_HEADER, OUTPUT_FORMAT_HEADER, WANT_AUDIO_HEADER]) {
    assert.ok(specText.includes(headerName), `${headerName} is missing from docs/API.md`);
  }
});

test('docs/API.md documents every registered input format id', () => {
  for (const formatId of listSupportedFormats()) {
    assert.ok(specText.includes(formatId), `input format '${formatId}' is missing from docs/API.md`);
  }
});

test('docs/API.md documents every reply-direction format id and the default reply format', () => {
  for (const formatId of listReplyFormats()) {
    assert.ok(specText.includes(formatId), `reply format '${formatId}' is missing from docs/API.md`);
  }
  assert.ok(specText.includes(defaultOutputFormatId()), 'default reply format id is missing from docs/API.md');
});

test('docs/API.md documents the want-audio disable token and the maximum request byte count', () => {
  assert.ok(
    specText.includes(WANT_AUDIO_DISABLED_TOKEN),
    `want-audio disable token '${WANT_AUDIO_DISABLED_TOKEN}' is missing from docs/API.md`,
  );
  assert.ok(
    specText.includes(String(MAX_REQUEST_AUDIO_BYTES)),
    `MAX_REQUEST_AUDIO_BYTES (${MAX_REQUEST_AUDIO_BYTES}) is missing from docs/API.md`,
  );
});

test('docs/API.md carries a worked request example addressed to the placeholder tailnet host', () => {
  assert.ok(
    specText.includes('your-device.your-tailnet.ts.net'),
    'docs/API.md worked example must use the placeholder tailnet hostname',
  );
});

test('a live turn requesting an input-only container format as the reply format is rejected 415 FMT_UNSUPPORTED, matching docs/API.md', async () => {
  const config = buildTestConfig();
  const adapters = buildTestAdapters();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    // Derived structurally, never typed: the id present in the full registry but absent
    // from the reply-direction list is exactly the container format (wav) — this survives
    // a future registry change without editing this test (06-RESEARCH.md Pattern 2).
    const replyFormats = new Set(listReplyFormats());
    const containerFormatId = listSupportedFormats().find((id) => !replyFormats.has(id));
    assert.ok(containerFormatId, 'expected at least one registered format absent from the reply-direction list');

    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        [INPUT_FORMAT_HEADER]: defaultOutputFormatId(),
        [OUTPUT_FORMAT_HEADER]: containerFormatId,
      },
    });
    assert.equal(response.statusCode, 415);
    assert.equal(response.headers['x-error-code'], 'FMT_UNSUPPORTED');
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// Task 2 (06-03-PLAN.md): what a client gets back — response headers and the three-segment
// body framing. Do not re-implement the cookie/redirect/compression wire-hygiene
// assertions — those live in test/http-turn.test.js:749-862; this file owns negotiation
// and framing only.
// =====================================================================================

test('docs/API.md documents the response byte-count, audio-present, and output-format response headers', () => {
  for (const headerName of [TRANSCRIPT_BYTES_HEADER, REPLY_BYTES_HEADER, AUDIO_PRESENT_HEADER, OUTPUT_FORMAT_RESPONSE_HEADER]) {
    assert.ok(specText.includes(headerName), `${headerName} is missing from docs/API.md`);
  }
});

test('docs/API.md states the body segments carry no delimiter and the byte counts are UTF-8 byte lengths', () => {
  assert.ok(specText.includes('no delimiter'), 'docs/API.md must state the segments carry no delimiter');
  assert.ok(specText.toLowerCase().includes('utf-8'), 'docs/API.md must state the byte counts are UTF-8 byte lengths');
});

test('a live audio-bearing turn carries every documented response header and its body slices exactly at the declared byte offsets', async () => {
  const transcript = 'hello there';
  const reply = 'general kenobi';
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript,
    reply,
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        [INPUT_FORMAT_HEADER]: 'pcm16',
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.headers['cache-control'], 'no-transform');
    assert.equal(response.headers['x-api-version'], API_VERSION);
    assert.equal(response.headers[AUDIO_PRESENT_HEADER.toLowerCase()], '1');
    assert.equal(response.headers[OUTPUT_FORMAT_RESPONSE_HEADER.toLowerCase()], defaultOutputFormatId());

    const transcriptBytes = Number(response.headers[TRANSCRIPT_BYTES_HEADER.toLowerCase()]);
    const replyBytes = Number(response.headers[REPLY_BYTES_HEADER.toLowerCase()]);
    assert.equal(transcriptBytes, Buffer.byteLength(transcript, 'utf8'));
    assert.equal(replyBytes, Buffer.byteLength(reply, 'utf8'));

    const transcriptSlice = response.body.subarray(0, transcriptBytes).toString('utf8');
    const replySlice = response.body.subarray(transcriptBytes, transcriptBytes + replyBytes).toString('utf8');
    assert.equal(transcriptSlice, transcript);
    assert.equal(replySlice, reply);

    const audioSlice = response.body.subarray(transcriptBytes + replyBytes);
    assert.ok(audioSlice.length > 0, 'an audio-bearing turn must carry a non-empty audio segment after the two text segments');
  } finally {
    await closeServer(server);
  }
});

test('a live audio-disabled turn carries the disabled audio-present value and a body length equal to transcript bytes plus reply bytes exactly', async () => {
  const transcript = 'hello there';
  const reply = 'general kenobi';
  const config = buildTestConfig();
  const adapters = makeFakeAdapters({
    transcript,
    reply,
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: {
        Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
        [INPUT_FORMAT_HEADER]: 'pcm16',
        [WANT_AUDIO_HEADER]: WANT_AUDIO_DISABLED_TOKEN,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers[AUDIO_PRESENT_HEADER.toLowerCase()], '0');

    const transcriptBytes = Number(response.headers[TRANSCRIPT_BYTES_HEADER.toLowerCase()]);
    const replyBytes = Number(response.headers[REPLY_BYTES_HEADER.toLowerCase()]);
    assert.equal(response.body.length, transcriptBytes + replyBytes);
  } finally {
    await closeServer(server);
  }
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

// =====================================================================================
// Task 1 (06-04-PLAN.md): the two pre-first-turn discovery routes. Every advertised value
// is compared against an imported constant, never a typed string, and the doc text is
// checked in both directions — a live response must match the imported source of truth,
// and docs/API.md must carry that same live value (06-RESEARCH.md Pattern 2).
// =====================================================================================

// Splits a line-based discovery body into an ordered key -> value Map, asserting the
// ': '-split shape holds for every non-empty line — mirrors test/http-capabilities.test.js's
// and test/http-health.test.js's own parseLineBody helpers.
function parseLineBody(bodyText) {
  const map = new Map();
  for (const line of bodyText.split('\n').filter((line) => line.length > 0)) {
    const idx = line.indexOf(': ');
    assert.ok(idx > 0, `line '${line}' does not split into a non-empty key and a defined value on ': '`);
    map.set(line.slice(0, idx), line.slice(idx + 2));
  }
  return map;
}

test('a live GET /v1/capabilities returns text/plain and every advertised value equals its imported source of truth, pinned against docs/API.md in both directions', async () => {
  const config = buildTestConfig();
  const adapters = buildTestAdapters();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await request(port, {
      method: 'GET',
      path: '/v1/capabilities',
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');

    const pairs = parseLineBody(response.body.toString('utf8'));

    // Every advertised value the plan enumerates, keyed by the imported constant/derived
    // value it must equal — never a typed literal (06-04-PLAN.md Task 1, RESEARCH.md
    // Pattern 2). 'voices' is deliberately excluded: it is config-dependent, not a
    // catalogue constant to import.
    const expected = new Map([
      ['api-version', API_VERSION],
      ['input-formats', listSupportedFormats().join(',')],
      ['reply-formats', listReplyFormats().join(',')],
      ['default-reply-format', defaultOutputFormatId()],
      ['max-audio-bytes', String(MAX_REQUEST_AUDIO_BYTES)],
      ['input-format-header', INPUT_FORMAT_HEADER],
      ['output-format-header', OUTPUT_FORMAT_HEADER],
      ['want-audio-header', WANT_AUDIO_HEADER],
      ['transcript-bytes-header', TRANSCRIPT_BYTES_HEADER],
      ['reply-bytes-header', REPLY_BYTES_HEADER],
    ]);

    for (const [key, value] of expected) {
      assert.equal(pairs.get(key), value, `live capabilities body key '${key}' did not equal its imported source of truth`);
      assert.ok(specText.includes(value), `docs/API.md is missing the live capabilities value '${value}' (key '${key}')`);
    }
  } finally {
    await closeServer(server);
  }
});

test('a live GET /v1/health returns exactly three named backend lines whose values are drawn only from the two permitted status tokens', async () => {
  const config = {
    security: {
      clients: { [TEST_CLIENT_NAME]: TEST_CLIENT_TOKEN },
      expectedHost: null,
      allowedOrigins: [],
      rateLimitWindowMs: 15_000,
      rateLimitMaxRequests: 1000,
    },
    // Deterministic-down inputs (test/http-health.test.js's own pattern): an unresolvable
    // command and an unreachable service URL, so this check never depends on whether a real
    // whisper/openclaw binary happens to be on this host's PATH.
    stt: { command: 'this-command-does-not-exist-anywhere-xyz' },
    openclaw: { sessionId: uniqueSessionId('health'), command: 'this-command-does-not-exist-anywhere-xyz' },
    tts: { serviceUrl: 'http://127.0.0.1:1' },
  };
  const adapters = buildTestAdapters();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await request(port, {
      method: 'GET',
      path: '/v1/health',
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}` },
    });
    assert.ok([200, 503].includes(response.statusCode));

    const bodyText = response.body.toString('utf8');
    const nonEmptyLines = bodyText.split('\n').filter((line) => line.length > 0);
    assert.equal(nonEmptyLines.length, 3, 'health body must be exactly three non-empty lines');

    const pairs = parseLineBody(bodyText);
    assert.deepEqual([...pairs.keys()], ['transcribe', 'agent', 'speech']);

    for (const [name, value] of pairs) {
      assert.ok(
        value === BACKEND_UP || value === BACKEND_DOWN,
        `health value '${value}' for backend '${name}' must be exactly the up or down status token`,
      );
    }

    assert.ok(specText.includes(BACKEND_UP), `docs/API.md is missing the up status token '${BACKEND_UP}'`);
    assert.ok(specText.includes(BACKEND_DOWN), `docs/API.md is missing the down status token '${BACKEND_DOWN}'`);
    for (const name of ['transcribe', 'agent', 'speech']) {
      assert.ok(specText.includes(name), `docs/API.md is missing the backend name '${name}'`);
    }
  } finally {
    await closeServer(server);
  }
});
