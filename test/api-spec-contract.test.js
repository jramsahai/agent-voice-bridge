// Contract test: proves the drift loop end to end on the error catalogue (06-01-PLAN.md,
// Task 1 tracer). Three checks, all deriving truth from imported code, never from parsing
// docs/API.md: (1) every ERROR_CODES entry's key and status appear in the doc text, (2) the
// X-Error-Code header name is derived from buildError() and checked against the doc text,
// (3) a live in-process server proves a real 401 and a real 404 match the envelope the doc
// publishes. Boots a real http.createServer with fake adapters — no whisper, no OpenClaw
// CLI, no Kokoro service, no network beyond the loopback socket this file itself opens
// (same hermetic pattern as test/http-turn.test.js).
//
// DIRECTIONALITY NOTE (flagged assumption, 06-01-PLAN.md; narrowed 06-06-PLAN.md): this gate
// mostly proves one direction — that every value the code's own catalogues declare is present
// in docs/API.md and in a live response. For header names, format ids, and the discovery-route
// values, it does NOT prove the reverse: a stale doc claim naming a header, format, or value the
// code has since removed would stay green here, because nothing iterates docs/API.md to find
// claims the running code can no longer honour. The error catalogue is the one exception:
// assertErrorCatalogueMatchesCode() below checks it in both directions — a published row naming
// a code ERROR_CODES no longer carries now fails the build too, closing that direction for the
// catalogue specifically. Narrowed by the append-only error-catalogue rule the doc itself
// publishes and by 06-03's live negotiation checks — do not read a green run on the remaining
// one-directional surfaces as a fully symmetric guarantee.

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
import { MIN_CLIENT_READ_TIMEOUT_MS } from '../packages/shared/transport/read-timeout.js';
import { TRANSCRIBE_TIMEOUT_MS, AGENT_TIMEOUT_MS } from '../packages/shared/adapters/stage-timeouts.js';
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

function buildTestAdapters() {
  return makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
}

// =====================================================================================
// Pattern 2 (06-RESEARCH.md), error catalogue: import the catalogue, check the doc text,
// never regex-parse docs/API.md to derive truth.
//
// The catalogue gets a stronger check than plain Pattern 2 substring presence (06-06-PLAN.md,
// closing 06-VERIFICATION.md SC5 / 06-REVIEW.md CR-01). Two independent substring checks — "the
// code appears somewhere" and "the status appears somewhere" — cannot detect a transposed row,
// because every status value in this table already appears elsewhere in the document for a
// different code. `parseErrorCatalogueRows` and `assertErrorCatalogueMatchesCode` below instead
// pair each code with the status on its own catalogue row. `ERROR_CODES` stays the only source
// of truth throughout: docs/API.md is parsed solely to locate the row being compared, never to
// derive what a code's status should be — that boundary is the whole point of Pattern 2 and
// this stronger check keeps it.
// =====================================================================================

// Finds the `### Error catalogue` heading and extracts `{ code -> status }` for every data row
// in the table that follows it. The header row (`| Code | HTTP status | Meaning |`) and the
// dash-separator row never match the backticked-code-cell pattern below, so they are skipped
// without any special-cased row-counting. Returns an empty Map (never throws) when the heading
// is absent or the table has no rows matching the pattern — the caller decides what an empty
// result means, so a negative fixture can drive this same code path.
function parseErrorCatalogueRows(docText) {
  const headingIndex = docText.indexOf('### Error catalogue');
  const rows = new Map();
  if (headingIndex === -1) {
    return rows;
  }
  const rowPattern = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|\s*(\d+)\s*\|/;
  for (const line of docText.slice(headingIndex).split('\n')) {
    if (line.startsWith('#') && line.trim() !== '### Error catalogue') {
      // Left the Error catalogue section for the next heading — stop scanning.
      break;
    }
    const match = rowPattern.exec(line);
    if (match) {
      const [, code, status] = match;
      rows.set(code, Number(status));
    }
  }
  return rows;
}

// Compares parsed catalogue rows against ERROR_CODES in both directions. Takes docText as a
// parameter rather than closing over the module-level specText, so the negative-case tests
// below can drive an in-memory fixture through the identical assertion path. Throws (via the
// assert library) on the first mismatch found; callers wrap this in assert.throws() for the
// negative-case proofs.
function assertErrorCatalogueMatchesCode(docText) {
  const parsed = parseErrorCatalogueRows(docText);
  assert.ok(
    parsed.size > 0,
    'the error catalogue table parsed to zero rows — an absent heading, a renamed heading, or a reformatted table must fail loudly, never match nothing and pass',
  );

  const parsedKeys = [...parsed.keys()].sort();
  const declaredKeys = Object.keys(ERROR_CODES).sort();
  assert.deepEqual(
    parsedKeys,
    declaredKeys,
    'the catalogue table must publish exactly the codes ERROR_CODES declares, in both directions — a code with no published row, or a published row naming a code ERROR_CODES no longer carries, both fail',
  );

  for (const [code, { status }] of Object.entries(ERROR_CODES)) {
    assert.equal(
      parsed.get(code),
      status,
      `docs/API.md's error catalogue pairs ${code} with status ${parsed.get(code)}, but ERROR_CODES declares ${status}`,
    );
  }
}

for (const [code, { status }] of Object.entries(ERROR_CODES)) {
  test(`docs/API.md pairs error code ${code} with its HTTP status ${status} on the same catalogue table row`, () => {
    const parsed = parseErrorCatalogueRows(specText);
    assert.equal(
      parsed.get(code),
      status,
      `docs/API.md's error catalogue does not pair ${code} with status ${status} on the same row`,
    );
  });
}

test("docs/API.md's error catalogue publishes exactly the codes ERROR_CODES declares — no missing row, no orphaned row", () => {
  const parsed = parseErrorCatalogueRows(specText);
  assert.ok(parsed.size > 0, 'the error catalogue table parsed to zero rows');
  assert.deepEqual(
    [...parsed.keys()].sort(),
    Object.keys(ERROR_CODES).sort(),
    'parsed catalogue keys must equal ERROR_CODES keys exactly, in both directions',
  );
});

test('the catalogue check rejects a transposed row that the superseded independent-substring check accepted', () => {
  // Derive the fixture structurally: pick the first two ERROR_CODES entries whose statuses
  // differ. No error-code name and no HTTP status is typed as a literal anywhere below.
  const entries = Object.entries(ERROR_CODES);
  let first;
  let second;
  outer: for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[i][1].status !== entries[j][1].status) {
        first = entries[i];
        second = entries[j];
        break outer;
      }
    }
  }
  assert.ok(first && second, 'expected at least two ERROR_CODES entries with differing statuses');

  const [codeA, { status: statusA }] = first;
  const [codeB, { status: statusB }] = second;

  const rowPatternA = new RegExp(`(\`${codeA}\`\\s*\\|\\s*)${statusA}(\\s*\\|)`);
  const rowPatternB = new RegExp(`(\`${codeB}\`\\s*\\|\\s*)${statusB}(\\s*\\|)`);
  assert.ok(rowPatternA.test(specText), `expected to find ${codeA}'s catalogue row in docs/API.md`);
  assert.ok(rowPatternB.test(specText), `expected to find ${codeB}'s catalogue row in docs/API.md`);

  // Two-phase substitution through a unique placeholder token, so the second replacement
  // cannot undo or collide with the first (a direct A-status -> B-status swap risks the second
  // replacement matching the row the first replacement just wrote).
  const placeholderA = `__TRANSPOSE_PLACEHOLDER_${codeA}__`;
  const placeholderB = `__TRANSPOSE_PLACEHOLDER_${codeB}__`;

  let transposedText = specText.replace(rowPatternA, `$1${placeholderA}$2`);
  transposedText = transposedText.replace(rowPatternB, `$1${placeholderB}$2`);
  transposedText = transposedText.replace(placeholderA, String(statusB));
  transposedText = transposedText.replace(placeholderB, String(statusA));

  // This is the criterion that proves the vacuity is gone: the structural check throws on the
  // transposed fixture.
  assert.throws(
    () => assertErrorCatalogueMatchesCode(transposedText),
    'assertErrorCatalogueMatchesCode must throw on a transposed catalogue row',
  );

  // Demonstration only — not reinstated as a live gate anywhere. The superseded independent
  // substring predicate ("code appears somewhere" AND "status appears somewhere") still accepts
  // this exact transposed text, because the transposition only ever moves a status value that
  // was already present elsewhere in the document onto a different code's row. This is why that
  // predicate could never have caught this class of drift.
  assert.ok(transposedText.includes(codeA), `${codeA} must still independently appear in the transposed text`);
  assert.ok(transposedText.includes(String(statusA)), `${statusA} must still independently appear in the transposed text`);
  assert.ok(transposedText.includes(codeB), `${codeB} must still independently appear in the transposed text`);
  assert.ok(transposedText.includes(String(statusB)), `${statusB} must still independently appear in the transposed text`);
});

test('the catalogue check fails loudly when the catalogue table parses to zero rows', () => {
  const headingIndex = specText.indexOf('### Error catalogue');
  assert.ok(headingIndex !== -1, 'expected to find the Error catalogue heading in docs/API.md');
  const firstDataRowIndex = specText.indexOf('| `', headingIndex);
  assert.ok(firstDataRowIndex !== -1, 'expected to find at least one catalogue data row in docs/API.md');
  // Keeps the heading and the header/separator rows, drops every data row — a heading-present,
  // zero-data-rows fixture, distinct from an absent-heading fixture.
  const zeroRowFixture = specText.slice(0, firstDataRowIndex);
  assert.throws(
    () => assertErrorCatalogueMatchesCode(zeroRowFixture),
    'assertErrorCatalogueMatchesCode must throw when the catalogue table has a heading but zero data rows',
  );
});

test('catalogue matching is keyed by error code, not by table row order', () => {
  const entries = Object.entries(ERROR_CODES);
  assert.ok(entries.length >= 2, 'expected at least two catalogue entries to swap');
  const [codeA, { status: statusA }] = entries[0];
  const [codeB, { status: statusB }] = entries[1];

  const rowPatternA = new RegExp(`\\|\\s*\`${codeA}\`\\s*\\|\\s*${statusA}\\s*\\|[^\\n]*`);
  const rowPatternB = new RegExp(`\\|\\s*\`${codeB}\`\\s*\\|\\s*${statusB}\\s*\\|[^\\n]*`);
  const matchA = rowPatternA.exec(specText);
  const matchB = rowPatternB.exec(specText);
  assert.ok(matchA && matchB, 'expected to find both rows to swap in docs/API.md');

  // Swap the two full row lines by position — every code-to-status pair stays intact, only
  // their order in the table changes.
  const placeholder = '__ROWSWAP_PLACEHOLDER__';
  let swappedText = specText.replace(matchA[0], placeholder);
  swappedText = swappedText.replace(matchB[0], matchA[0]);
  swappedText = swappedText.replace(placeholder, matchB[0]);

  // Must not throw: matching is keyed by code, never by row index.
  assertErrorCatalogueMatchesCode(swappedText);
});

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

// =====================================================================================
// Task 2 (06-04-PLAN.md): the published minimum client read timeout (D-01/SPEC-02). Every
// number is asserted by its string form derived from an imported constant, never a typed
// literal — raising either stage ceiling in stage-timeouts.js fails this test until
// docs/API.md's stated floor and its derivation both follow.
// =====================================================================================

test('docs/API.md states the published read-timeout floor and both stage ceilings it is derived from', () => {
  assert.ok(
    specText.includes(String(MIN_CLIENT_READ_TIMEOUT_MS)),
    `MIN_CLIENT_READ_TIMEOUT_MS (${MIN_CLIENT_READ_TIMEOUT_MS}) is missing from docs/API.md`,
  );
  assert.ok(
    specText.includes(String(TRANSCRIBE_TIMEOUT_MS)),
    `TRANSCRIBE_TIMEOUT_MS (${TRANSCRIBE_TIMEOUT_MS}) is missing from docs/API.md`,
  );
  assert.ok(
    specText.includes(String(AGENT_TIMEOUT_MS)),
    `AGENT_TIMEOUT_MS (${AGENT_TIMEOUT_MS}) is missing from docs/API.md`,
  );
});

// =====================================================================================
// Task 1 (06-05-PLAN.md): streaming consumption guidance — a POST /v1/turn success
// response carries no body-length header of any kind, and docs/API.md must both say so and
// prove it live. Reads res.rawHeaders (the flat, un-deduplicated wire array), not
// res.headers (an object Node already flattens/overwrites duplicates into), so a duplicated
// or later-overwritten header is visible to this assertion instead of silently collapsed —
// same rationale as test/http-turn.test.js's assertWireHygiene.
// =====================================================================================

function assertNoBodyLengthHeader(response) {
  const names = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    names.push(response.rawHeaders[i].toLowerCase());
  }
  assert.ok(
    !names.includes('content-length'),
    'a /v1/turn success response must rely on chunked framing only — no body-length header of any kind may be present',
  );
}

test('docs/API.md states in prose that no body-length header is sent on a /v1/turn response, and names chunked framing', () => {
  assert.ok(
    specText.toLowerCase().includes('no body-length header'),
    'docs/API.md must state plainly that no body-length header is sent on a turn response',
  );
  assert.ok(specText.includes('chunked'), 'docs/API.md must name chunked framing as the mechanism this relies on');
});

test('docs/API.md documents the recommended read buffer size and the audio byte rate it is justified against', () => {
  assert.ok(specText.includes('4096'), 'docs/API.md must state the recommended 4096-byte read buffer size');
  assert.ok(
    specText.includes('32000'),
    'docs/API.md must state the 32000-bytes-per-second audio rate the buffer size is justified against',
  );
});

test('docs/API.md states a body length exactly equal to transcript bytes plus reply bytes is a valid no-audio response, not truncated', () => {
  assert.ok(
    specText.toLowerCase().includes('not a truncated one'),
    'docs/API.md must state the exactly-equal-length no-audio case is valid, not truncated',
  );
});

test('a live audio-bearing 200 turn response carries no body-length header of any kind, proving the chunked-framing claim docs/API.md makes', async () => {
  const config = buildTestConfig();
  const adapters = buildTestAdapters();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}`, [INPUT_FORMAT_HEADER]: 'pcm16' },
    });
    assert.equal(response.statusCode, 200);
    assertNoBodyLengthHeader(response);
  } finally {
    await closeServer(server);
  }
});

test('a live audio-disabled 200 turn response carries no body-length header of any kind either', async () => {
  const config = buildTestConfig();
  const adapters = buildTestAdapters();
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
    assertNoBodyLengthHeader(response);
  } finally {
    await closeServer(server);
  }
});

// =====================================================================================
// Task 2 (06-05-PLAN.md): reverse-proxy deployment requirements. The origin half is
// verified live by test/http-turn.test.js's existing wire-hygiene tests; this file adds a
// structural guard so that delegated coverage cannot silently disappear, plus a check that
// docs/API.md carries the no-transform directive it claims the origin always sends.
// =====================================================================================

test('docs/API.md contains the no-transform cache directive string', () => {
  assert.ok(specText.includes('no-transform'), 'docs/API.md must state the no-transform cache directive');
});

test('docs/API.md contains a Deployment requirements section covering TLS posture and the origin/proxy split', () => {
  assert.ok(specText.includes('## Deployment requirements'), 'docs/API.md is missing the Deployment requirements heading');
  assert.ok(
    specText.toLowerCase().includes('never terminate'),
    'docs/API.md must state in prose that the service never terminates TLS',
  );
});

test('test/http-turn.test.js still contains the five wire-hygiene test names this file delegates origin-side no-cookie, no-redirect, no-compression coverage to — deleting one removes coverage docs/API.md claims', () => {
  const httpTurnSource = fs.readFileSync(new URL('../test/http-turn.test.js', import.meta.url), 'utf8');
  const wireHygieneTestNames = [
    'wire hygiene: a 200 response with audio carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control',
    'wire hygiene: a 200 text-only response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control',
    'wire hygiene: a 401 response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control',
    'wire hygiene: a 413 response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control',
    'wire hygiene: a 415 response carries no cookie, no redirect status, no compression, and exactly one no-transform cache-control',
  ];
  for (const name of wireHygieneTestNames) {
    assert.ok(
      httpTurnSource.includes(name),
      `test/http-turn.test.js is missing the wire-hygiene test '${name}' — this file delegates origin-side coverage to it`,
    );
  }
});
