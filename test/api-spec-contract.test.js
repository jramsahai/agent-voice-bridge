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
import { validateConfig } from '../packages/shared/config/validate-config.js';
import {
  API_VERSION,
  MAX_REQUEST_AUDIO_BYTES,
  TRANSCRIPT_BYTES_HEADER,
  REPLY_BYTES_HEADER,
  AUDIO_PRESENT_HEADER,
  OUTPUT_FORMAT_RESPONSE_HEADER,
  buildTurnResponseHead,
} from '../packages/shared/transport/turn-response.js';
import {
  listReplyFormats,
  defaultOutputFormatId,
  INPUT_FORMAT_HEADER,
  OUTPUT_FORMAT_HEADER,
  WANT_AUDIO_HEADER,
  WANT_AUDIO_DISABLED_TOKEN,
} from '../packages/shared/transport/negotiate.js';
import { listSupportedFormats, AUDIO_FORMATS } from '../packages/shared/audio/format-registry.js';
import { BACKEND_UP, BACKEND_DOWN } from '../packages/shared/health/backend-health-cache.js';
import { MIN_CLIENT_READ_TIMEOUT_MS } from '../packages/shared/transport/read-timeout.js';
import { TRANSCRIBE_TIMEOUT_MS, AGENT_TIMEOUT_MS } from '../packages/shared/adapters/stage-timeouts.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

const specText = fs.readFileSync(new URL('../docs/API.md', import.meta.url), 'utf8');

const TEST_CLIENT_NAME = 'contract-test-client';
const TEST_CLIENT_TOKEN = randomUUID();

// Derived from the registry, not hardcoded, so this file's negotiation fixtures never have
// to know the exact wire id of "the codec-free format" (same pattern as
// test/convert.test.js:28's CODEC_FREE_FORMAT_ID).
const CODEC_FREE_FORMAT_ID = Object.keys(AUDIO_FORMATS).find((id) => AUDIO_FORMATS[id].headerless);
assert.ok(CODEC_FREE_FORMAT_ID, 'a headerless format must be registered for this suite to run');

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
        [INPUT_FORMAT_HEADER]: CODEC_FREE_FORMAT_ID,
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
        [INPUT_FORMAT_HEADER]: CODEC_FREE_FORMAT_ID,
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
      headers: { 'Content-Type': 'application/octet-stream', [INPUT_FORMAT_HEADER]: CODEC_FREE_FORMAT_ID },
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

// =====================================================================================
// Task 3 (06-07-PLAN.md): region-scoped drift assertions on the client-posture paragraph
// recording which client honours the MUST-level no-full-buffering claim and which
// deliberately opts out. Both operate on the slice of docs/API.md from the
// '## Consuming the response body' heading to the next top-level heading, never on the
// whole document — a whole-document substring check is the exact vacuity plan 06-06 removed
// from the error catalogue (a superseded independent-substring check that could not detect a
// transposed row), and reintroducing that shape here would be the same defect in a new place.
// =====================================================================================

function consumingResponseBodySection(docText) {
  const headingText = '## Consuming the response body';
  const headingIndex = docText.indexOf(headingText);
  assert.ok(headingIndex !== -1, `docs/API.md is missing its '${headingText}' heading`);
  const afterHeading = docText.slice(headingIndex + headingText.length);
  // A top-level heading only, never an h3 subheading like '### Consumption algorithm' — the
  // pattern requires the two hashes to be followed directly by a space.
  const nextHeadingOffset = afterHeading.search(/\n## /);
  assert.ok(nextHeadingOffset !== -1, `expected another top-level heading after '${headingText}'`);
  return afterHeading.slice(0, nextHeadingOffset);
}

const CONSUMING_SECTION_MUST_CLAIM =
  'A client must stream through that ceiling, never buffer the whole reply in memory to reach it.';

// Takes the section text as a parameter — not a closure over the module-level specText — so
// the negative-case proof below can drive an in-memory mutated fixture through the identical
// assertion path the real check uses (mirrors assertErrorCatalogueMatchesCode's own shape).
function assertConsumingSectionCarriesMustClaim(section) {
  assert.ok(
    section.includes(CONSUMING_SECTION_MUST_CLAIM),
    'the Consuming the response body section is missing its MUST-level no-full-buffering claim',
  );
}

test('the Consuming the response body section still carries its MUST-level no-full-buffering claim', () => {
  const section = consumingResponseBodySection(specText);
  assertConsumingSectionCarriesMustClaim(section);

  // Negative-case proof, driven through the identical assertion helper: a section fixture
  // with the clause removed must fail this check — otherwise this test only restates the
  // claim's presence rather than proving the check can catch its absence.
  assert.ok(
    section.includes(CONSUMING_SECTION_MUST_CLAIM),
    'sanity: expected to find the MUST claim in the real section before mutating it away',
  );
  const mutatedSection = section.replace(CONSUMING_SECTION_MUST_CLAIM, '');
  assert.notEqual(mutatedSection, section, 'sanity: the mutation must have actually removed something');
  assert.throws(
    () => assertConsumingSectionCarriesMustClaim(mutatedSection),
    'assertConsumingSectionCarriesMustClaim must throw once the MUST-level claim has been removed from the section',
  );
});

test("the Consuming the response body section names the reference CLI as compliant and records the browser client's deliberate opt-out", () => {
  const section = consumingResponseBodySection(specText);
  assert.ok(
    section.includes('apps/voice-cli/cli.js'),
    'the section must name the reference CLI client path as the client that honours the MUST-level claim',
  );
  assert.ok(
    section.includes('apps/voice-web/app.js'),
    "the section must record the browser client's deliberate opt-out by naming its path",
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
      headers: { Authorization: `Bearer ${TEST_CLIENT_TOKEN}`, [INPUT_FORMAT_HEADER]: CODEC_FREE_FORMAT_ID },
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
        [INPUT_FORMAT_HEADER]: CODEC_FREE_FORMAT_ID,
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

// =====================================================================================
// Task 3 (06-06-PLAN.md): README.md's configuration example, guarded against reintroducing
// any shape validateConfig() rejects or any key path the shipped template does not carry.
// Driven entirely by the imported validateConfig() and by reading config/config.example.json
// from disk — no rejection message, rejected key name, or list of rejected keys is imported,
// copied, or restated as a literal anywhere below. Closes 06-VERIFICATION.md Anti-Patterns
// README.md:152-161 / 06-REVIEW.md CR-03.
//
// =====================================================================================

// Extracts and parses the first fenced json block that follows README.md's '## Configuration'
// heading. Takes the doc text as a parameter — not a disk read — so a fixture with no fenced
// block can be driven through the identical extraction path (the extractor-throws test below).
// Asserts both that the heading exists and that a fenced json block follows it, so a future
// README restructure that removes the example fails this guard instead of silently skipping it.
function extractConfigExampleFromReadmeText(readmeText) {
  const configSectionIndex = readmeText.indexOf('## Configuration');
  assert.ok(configSectionIndex !== -1, "README.md is missing its '## Configuration' heading");
  const afterHeading = readmeText.slice(configSectionIndex);
  const match = afterHeading.match(/```json\n([\s\S]*?)```/);
  assert.ok(match, "README.md's '## Configuration' section has no fenced json block");
  return JSON.parse(match[1]);
}

function readmeConfigExample() {
  const readmeText = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  return extractConfigExampleFromReadmeText(readmeText);
}

// Flattens a parsed config object into a sorted array of dotted key paths, for the
// README-subset-of-template comparison. Arrays are treated as leaves — their contents are
// values, not schema. security.clients is also treated as a leaf: its own keys are
// operator-chosen client names ('browser', 'handheld', ...), not schema keys, so descending
// into them would wrongly compare client names as if they were config paths.
function isPlainObjectForKeyPaths(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectKeyPaths(value, prefix = '') {
  const paths = [];
  for (const key of Object.keys(value).sort()) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const child = value[key];
    if (fullPath === 'security.clients' || !isPlainObjectForKeyPaths(child)) {
      paths.push(fullPath);
    } else {
      paths.push(...collectKeyPaths(child, fullPath));
    }
  }
  return paths;
}

test("README.md's configuration example produces the same validateConfig error set as config/config.example.json", () => {
  const shippedTemplate = JSON.parse(fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
  const readmeExample = readmeConfigExample();
  const readmeErrors = validateConfig(readmeExample).slice().sort();
  const templateErrors = validateConfig(shippedTemplate).slice().sort();
  // Parity, not emptiness, is the right invariant here: the shipped template deliberately
  // carries placeholder tokens that validateConfig rejects by design, so an emptiness
  // assertion would fail against a genuinely correct README. Parity instead catches both a
  // rejected key appearing in the README and a real secret being pasted into it.
  assert.deepEqual(readmeErrors, templateErrors);
});

test("README.md's configuration example declares no key path absent from config/config.example.json", () => {
  const shippedTemplate = JSON.parse(fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
  const readmeExample = readmeConfigExample();
  const templatePaths = new Set(collectKeyPaths(shippedTemplate));
  for (const path of collectKeyPaths(readmeExample)) {
    assert.ok(
      templatePaths.has(path),
      `README.md's configuration example declares key path '${path}', which config/config.example.json does not carry`,
    );
  }
});

test('the README config guard rejects a mutated example that reinstates the removed singular security token key', () => {
  const shippedTemplate = JSON.parse(fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
  const readmeExample = readmeConfigExample();
  const mutated = structuredClone(readmeExample);
  // Reinstates the key validateConfig is known to reject (packages/shared/config/validate-
  // config.js's `'token' in config.security` check) — the assertion below is that the
  // resulting error set differs from the correct README's, never that a message string
  // matched, so this stays driven by the validator's own behavior.
  mutated.security.token = 'reinstated-shared-secret-value';
  const mutatedErrors = validateConfig(mutated).slice().sort();
  const templateErrors = validateConfig(shippedTemplate).slice().sort();
  assert.notDeepEqual(mutatedErrors, templateErrors);
});

test('the README config guard rejects a cloned example whose placeholder token is replaced with a real-looking secret', () => {
  const shippedTemplate = JSON.parse(fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
  const readmeExample = readmeConfigExample();
  const mutated = structuredClone(readmeExample);
  const [firstClientName] = Object.keys(mutated.security.clients);
  mutated.security.clients[firstClientName] = 'a'.repeat(40);
  const mutatedErrors = validateConfig(mutated).slice().sort();
  const templateErrors = validateConfig(shippedTemplate).slice().sort();
  // The placeholder-token rejection disappears once a real-looking secret replaces it, so
  // the error sets must differ — a pasted real secret is exactly what this guard catches.
  assert.notDeepEqual(mutatedErrors, templateErrors);
});

test('the README config guard rejects a cloned example carrying a key path the shipped template does not have', () => {
  const shippedTemplate = JSON.parse(fs.readFileSync(new URL('../config/config.example.json', import.meta.url), 'utf8'));
  const readmeExample = readmeConfigExample();
  const mutated = structuredClone(readmeExample);
  mutated.security.driftedExtraKey = 'unexpected';
  const templatePaths = new Set(collectKeyPaths(shippedTemplate));
  const offendingPath = collectKeyPaths(mutated).find((path) => !templatePaths.has(path));
  assert.ok(offendingPath, 'expected the mutated fixture to carry at least one key path absent from the shipped template');
});

test('the README config extractor throws when handed README-shaped text with no fenced json block under the Configuration heading', () => {
  const fixtureText = '## Configuration\n\nNo fenced example follows this heading.\n';
  assert.throws(
    () => extractConfigExampleFromReadmeText(fixtureText),
    'extractConfigExampleFromReadmeText must throw when no fenced json block follows the heading',
  );
});

// =====================================================================================
// 06-04 T3/T5 gap closure (/gsd-validate-phase): two prose facts the phase carried as
// human_judgment with no persisted assertion. Both are region-scoped for the reason spelled
// out above consumingResponseBodySection — every string below occurs elsewhere in the
// document for a different reason, so a whole-document includes() would pass even with the
// fact deleted from the section that must carry it.
// =====================================================================================

// Shared implementation for both region-slicing helpers below (sectionUnderHeading here,
// regionUnderHeading further down). The two only differ in (a) which pattern terminates the
// slice and (b) whether a missing terminator is an error or falls back to end-of-document —
// expressing both through one function keeps a future slicing-logic fix (e.g. a `\r\n`
// line-ending edge case) from being applied to one and forgotten on the other.
function sliceUnderHeading(docText, headingText, { terminatorPattern, requireTerminator = true }) {
  const headingIndex = docText.indexOf(headingText);
  assert.ok(headingIndex !== -1, `docs/API.md is missing its '${headingText}' heading`);
  const afterHeading = docText.slice(headingIndex + headingText.length);
  const nextHeadingOffset = afterHeading.search(terminatorPattern);
  if (nextHeadingOffset === -1) {
    assert.ok(!requireTerminator, `expected a top-level heading after '${headingText}'`);
    return afterHeading;
  }
  return afterHeading.slice(0, nextHeadingOffset);
}

// Slices from a heading to the next top-level heading. An h3 heading is a valid start (its
// region simply runs to the following h2), but only an h2 ever terminates a region.
function sectionUnderHeading(docText, headingText) {
  return sliceUnderHeading(docText, headingText, { terminatorPattern: /\n## / });
}

const SEGMENT_ORDER_CLAIM = 'The segment order is fixed and never varies';

function assertFramingSectionFixesSegmentOrder(section) {
  assert.ok(
    section.includes(SEGMENT_ORDER_CLAIM),
    'the Response body framing section must state that the segment order is fixed and never varies — a client that cannot rely on the order cannot slice the body at all',
  );
}

test('the Response body framing section states the segment order is fixed and never varies', () => {
  const section = sectionUnderHeading(specText, '### Response body framing');
  assertFramingSectionFixesSegmentOrder(section);

  // Negative-case proof through the identical assertion path.
  const mutated = section.replace(SEGMENT_ORDER_CLAIM, '');
  assert.notEqual(mutated, section, 'sanity: the mutation must have actually removed the claim');
  assert.throws(
    () => assertFramingSectionFixesSegmentOrder(mutated),
    'the check must throw once the fixed-segment-order claim is removed from the section',
  );
});

// The two line-based discovery bodies are the only routes whose parse rule is order-independent.
// Each must carry that rule in its own section — a reader implementing one route never reads the
// other's prose.
for (const { heading, phrase } of [
  { heading: '## GET /v1/capabilities', phrase: 'must not depend on line order' },
  { heading: '## GET /v1/health', phrase: 'read by key, never by line position' },
]) {
  test(`${heading} instructs parse-by-key rather than by line position`, () => {
    const section = sectionUnderHeading(specText, heading);
    assert.ok(
      /by key/.test(section),
      `${heading} must instruct a client to parse its body by key`,
    );
    assert.ok(
      section.includes(phrase),
      `${heading} must state that line order is not a promise ('${phrase}')`,
    );
  });
}

const BOUNDARY_FAILURE_CLAIM =
  'there is no server-side error to correlate the failure against';

function assertTimeoutSectionStatesBoundaryFailure(section) {
  assert.ok(
    section.includes('can abort a turn the server is still legitimately processing'),
    'the Client read timeout section must state that a too-tight client aborts a turn the server is still working on',
  );
  assert.ok(
    section.includes(BOUNDARY_FAILURE_CLAIM),
    'the Client read timeout section must state that the failure leaves no server-side error to correlate against — the detail that makes a too-tight timeout hard to diagnose',
  );
}

test('the Client read timeout section states the boundary failure mode', () => {
  const section = sectionUnderHeading(specText, '## Client read timeout');
  assertTimeoutSectionStatesBoundaryFailure(section);

  const mutated = section.replace(BOUNDARY_FAILURE_CLAIM, '');
  assert.notEqual(mutated, section, 'sanity: the mutation must have actually removed the claim');
  assert.throws(
    () => assertTimeoutSectionStatesBoundaryFailure(mutated),
    'the check must throw once the no-correlating-error consequence is removed from the section',
  );
});

test('the Client read timeout section cites its measured time-to-first-byte figures as typical, not as the floor', () => {
  const section = sectionUnderHeading(specText, '## Client read timeout');
  for (const measurement of ['5,438 ms', '10,274 ms']) {
    assert.ok(
      section.includes(measurement),
      `the Client read timeout section must cite the measured ${measurement} time to first byte`,
    );
  }
  // The framing matters more than the figures: presented as a floor rather than a typical
  // case, these numbers would argue a client for a ~10s timeout — 30x under the real floor.
  assert.ok(
    section.includes('the **typical** case, not the floor'),
    'the measured figures must be framed as the typical case, explicitly not as the floor',
  );
});

// 06-01 D5 was verified once by hand (`grep -c 'docs/API.md' README.md`) and never persisted.
// The published contract is only discoverable if the repo root still points at it.
test('README.md links to the published API specification', () => {
  const readmeText = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(
    readmeText.includes('docs/API.md'),
    'README.md must link to docs/API.md so a reader arriving at the repo root finds the published contract',
  );
});

// =====================================================================================
// 07-01-PLAN.md (SPEC-05/SPEC-06): region-scoped drift assertions for the proxy-observed
// bad-Host rejection and the absent-X-Error-Code rule. `sectionUnderHeading` above only
// terminates at the next '## ' (level 2) heading and throws when none follows — wrong for
// the new '### Rejections that never reach the origin' h3 subsection, whose region must stop
// at the following h3 ('### What the origin guarantees'), not run past it. `regionUnderHeading`
// terminates at the next level-2 OR level-3 heading, or end-of-document if neither follows.
// =====================================================================================

function regionUnderHeading(docText, headingText) {
  return sliceUnderHeading(docText, headingText, {
    terminatorPattern: /\n(## |### )/,
    requireTerminator: false,
  });
}

const PROXY_REJECTION_HEADING = '### Rejections that never reach the origin';
const PROXY_REJECTION_TERMINAL_CLAIM = 'terminal, not retryable';

function assertProxyRejectionSectionStatesObservedFailure(section) {
  assert.ok(section.includes('Tailscale Serve'), 'the proxy-rejection subsection must name Tailscale Serve');
  assert.ok(section.includes('404'), 'the proxy-rejection subsection must state the observed 404 status');
  assert.ok(
    section.includes('no `X-Error-Code` header'),
    'the proxy-rejection subsection must state that no X-Error-Code header is present',
  );
  assert.ok(
    section.includes('the origin never sees the request, so its logs show nothing for it'),
    'the proxy-rejection subsection must state that the origin never sees the request and its logs show nothing for it',
  );
  assert.ok(
    section.includes(PROXY_REJECTION_TERMINAL_CLAIM),
    'the proxy-rejection subsection must state the outcome is terminal, not retryable',
  );
}

test('the Deployment requirements proxy-rejection subsection states the observed 404, the absent X-Error-Code header, and that the outcome is terminal', () => {
  const section = regionUnderHeading(specText, PROXY_REJECTION_HEADING);
  assertProxyRejectionSectionStatesObservedFailure(section);

  // Negative-case proof, driven through the identical assertion path: removing the terminal
  // claim from the section must make the check throw, otherwise this test only restates the
  // claim's presence rather than proving the check can catch its absence.
  const mutated = section.replace(PROXY_REJECTION_TERMINAL_CLAIM, '');
  assert.notEqual(mutated, section, 'sanity: the mutation must have actually removed the claim');
  assert.throws(
    () => assertProxyRejectionSectionStatesObservedFailure(mutated),
    'the check must throw once the terminal-not-retryable claim is removed from the section',
  );
});

test('regionUnderHeading slices a strict subset of the document, never the whole of it', () => {
  const section = regionUnderHeading(specText, PROXY_REJECTION_HEADING);
  assert.ok(
    section.length < specText.length,
    'regionUnderHeading must return a strict subset of the document, not the whole of it',
  );
  assert.ok(
    !section.includes('## Authentication'),
    'the sliced region must not reach back into an earlier, unrelated section of the document',
  );
});

const ABSENT_ERROR_CODE_CLAIM = "it did not come from this service's origin";

function assertErrorsSectionStatesAbsentErrorCodeRule(section) {
  assert.ok(
    section.includes('If `X-Error-Code` is absent from an error response'),
    'the Errors section must state the rule for an error response with no X-Error-Code header',
  );
  assert.ok(
    section.includes(ABSENT_ERROR_CODE_CLAIM),
    "the Errors section must state that an absent X-Error-Code response did not come from this service's origin",
  );
  assert.ok(
    section.includes('Do not retry it'),
    'the Errors section must instruct a client not to retry a response with no X-Error-Code',
  );
  assert.ok(
    section.includes('Rejections that never reach the origin'),
    'the Errors section must cross-reference the Deployment requirements proxy-rejection subsection by name',
  );
}

test('the Errors section states what an absent X-Error-Code means and cross-references the proxy-rejection subsection', () => {
  const section = regionUnderHeading(specText, '## Errors');
  assertErrorsSectionStatesAbsentErrorCodeRule(section);

  // Negative-case proof, identical to Task 1's shape: removing the claim must make the
  // check throw, proving this test can catch the claim's absence, not just restate it.
  const mutated = section.replace(ABSENT_ERROR_CODE_CLAIM, '');
  assert.notEqual(mutated, section, 'sanity: the mutation must have actually removed the claim');
  assert.throws(
    () => assertErrorsSectionStatesAbsentErrorCodeRule(mutated),
    'the check must throw once the absent-X-Error-Code claim is removed from the section',
  );
});

// =====================================================================================
// 07-02-PLAN.md Task 1 (SPEC-08): the mid-upload 413 trigger — a second, distinct path to
// 413 AUDIO_TOO_LARGE that fires on the running received-byte total rather than the declared
// Content-Length, and the client instruction to keep reading the response after a failed
// body write rather than treating a broken pipe as terminal.
// =====================================================================================

const MID_UPLOAD_READ_RESPONSE_CLAIM = 'still read the response after a failed body write';

function assertTurnRequestSectionStatesMidUploadTrigger(section) {
  assert.ok(
    section.includes('while the request body is still uploading'),
    'the POST /v1/turn request section must state that a second 413 trigger can fire while the request body is still uploading',
  );
  assert.ok(
    section.includes(MID_UPLOAD_READ_RESPONSE_CLAIM),
    'the POST /v1/turn request section must instruct a client to still read the response after a failed body write',
  );
  assert.ok(
    section.includes('not treat the broken pipe as terminal'),
    'the POST /v1/turn request section must instruct a client not to treat the broken pipe as terminal',
  );
}

test('the POST /v1/turn request section states a 413 can arrive mid-upload and that the client must still read the response after a failed body write', () => {
  const section = regionUnderHeading(specText, '## POST /v1/turn — request');
  assertTurnRequestSectionStatesMidUploadTrigger(section);

  const mutated = section.replace(MID_UPLOAD_READ_RESPONSE_CLAIM, '');
  assert.notEqual(mutated, section, 'sanity: the mutation must have actually removed the claim');
  assert.throws(
    () => assertTurnRequestSectionStatesMidUploadTrigger(mutated),
    'the check must throw once the mid-upload read-response claim is removed from the section',
  );
});

// =====================================================================================
// 07-02-PLAN.md Task 2 (SPEC-07): all four framing claims are already stated in docs/API.md
// (confirmed present at 06-line-cited locations below). This does not rewrite that prose — it
// pins each claim to the section that must carry it, region-scoped via regionUnderHeading,
// so a later edit that relocates or deletes one out of its section fails the build. The
// whole-document checks at lines ~476-479 and ~763-769 above are retained, not replaced —
// those prove cross-section presence; these prove the claim lives in the right place.
// =====================================================================================

const CAPABILITIES_CONTENT_LENGTH_CLAIM = 'this response carries a real `Content-Length` header';

function assertSpec07FramingClaimsLiveInTheRightSections({ framingSection, consumingSection, capabilitiesSection }) {
  assert.ok(
    framingSection.includes('no delimiter of any kind'),
    'the Response body framing section must state the segments carry no delimiter of any kind',
  );
  assert.ok(
    /multi-byte character/.test(framingSection),
    'the Response body framing section must state the multi-byte-misalignment consequence of byte-offset slicing',
  );
  assert.ok(
    consumingSection.includes('no body-length header'),
    'the Consuming the response body section must state that no body-length header is sent',
  );
  assert.ok(
    consumingSection.includes('Read until the connection ends'),
    'the Consuming the response body section must instruct the client to read until the connection ends',
  );
  assert.ok(
    capabilitiesSection.includes(CAPABILITIES_CONTENT_LENGTH_CLAIM),
    'the GET /v1/capabilities section must state that it carries a real Content-Length header',
  );
  assert.ok(
    capabilitiesSection.includes('Unlike `POST /v1/turn`'),
    'the GET /v1/capabilities section must contrast its real Content-Length against the turn response, not state it unqualified',
  );
}

test('each SPEC-07 framing claim lives in the section that must carry it, not merely somewhere in the document', () => {
  const framingSection = regionUnderHeading(specText, '### Response body framing');
  const consumingSection = regionUnderHeading(specText, '## Consuming the response body');
  const capabilitiesSection = regionUnderHeading(specText, '## GET /v1/capabilities');
  assertSpec07FramingClaimsLiveInTheRightSections({ framingSection, consumingSection, capabilitiesSection });

  // Negative-case proof driven on the claim with no prior coverage anywhere in the suite —
  // demonstrates a genuinely new guard rather than re-proving what the whole-document tests
  // already cover.
  const mutatedCapabilitiesSection = capabilitiesSection.replace(CAPABILITIES_CONTENT_LENGTH_CLAIM, '');
  assert.notEqual(
    mutatedCapabilitiesSection,
    capabilitiesSection,
    'sanity: the mutation must have actually removed the claim',
  );
  assert.throws(
    () =>
      assertSpec07FramingClaimsLiveInTheRightSections({
        framingSection,
        consumingSection,
        capabilitiesSection: mutatedCapabilitiesSection,
      }),
    'the check must throw once the capabilities real-Content-Length claim is removed from its section',
  );
});

// =====================================================================================
// 07-02-PLAN.md Task 3 (SPEC-09): both claims are already stated in docs/API.md. As with
// Task 2, no prose rewrite — confirm and pin, region-scoped.
// =====================================================================================

const ORIGIN_OMISSION_CLAIM = 'Do not synthesize a plausible-looking `Origin` value.';

function assertOriginSectionStatesOmissionRatherThanSynthesis(section) {
  assert.ok(
    section.includes('omit `Origin` entirely'),
    'the Origin header section must instruct a non-browser client to omit Origin entirely',
  );
  assert.ok(
    section.includes(ORIGIN_OMISSION_CLAIM),
    'the Origin header section must separately instruct a client not to synthesize a plausible-looking Origin value',
  );
}

test('the Origin header section states omission rather than synthesis', () => {
  const section = regionUnderHeading(specText, '### The `Origin` header');
  assertOriginSectionStatesOmissionRatherThanSynthesis(section);

  const mutated = section.replace(ORIGIN_OMISSION_CLAIM, '');
  assert.notEqual(mutated, section, 'sanity: the mutation must have actually removed the claim');
  assert.throws(
    () => assertOriginSectionStatesOmissionRatherThanSynthesis(mutated),
    'the check must throw once the do-not-synthesize claim is removed from the section',
  );
});

const REPLY_DIRECTION_CLAIM = 'must not reuse the input format list for the reply direction';

function assertReplyDirectionScopeIsStatedInBothSections({ audioFormatsSection, capabilitiesSection }) {
  assert.ok(
    audioFormatsSection.includes(REPLY_DIRECTION_CLAIM),
    'the Audio formats section must forbid reusing the input format list for the reply direction',
  );
  assert.ok(
    /reused `input-formats` for the reply direction/.test(capabilitiesSection),
    'the GET /v1/capabilities section must separately warn against reusing input-formats for the reply direction',
  );
}

test('the Audio formats and capabilities sections each forbid reusing the input format list for the reply direction', () => {
  const audioFormatsSection = regionUnderHeading(specText, '## Audio formats');
  const capabilitiesSection = regionUnderHeading(specText, '## GET /v1/capabilities');
  assertReplyDirectionScopeIsStatedInBothSections({ audioFormatsSection, capabilitiesSection });

  const mutatedAudioFormatsSection = audioFormatsSection.replace(REPLY_DIRECTION_CLAIM, '');
  assert.notEqual(
    mutatedAudioFormatsSection,
    audioFormatsSection,
    'sanity: the mutation must have actually removed the claim',
  );
  assert.throws(
    () =>
      assertReplyDirectionScopeIsStatedInBothSections({
        audioFormatsSection: mutatedAudioFormatsSection,
        capabilitiesSection,
      }),
    'the check must throw once the reply-direction-scope claim is removed from the Audio formats section',
  );
});

// =====================================================================================
// 07 UAT gap G-07-2 (SPEC-10): the sixth measured correction. Every other SPEC-05..09 claim
// this phase landed carries a region-scoped pin above; this one did not, and the section was
// deletable with the whole suite still green — the one correction found by reading the
// firmware skill directly was the one correction nothing defended. Region-scoped for the same
// reason as the pins above: "reply" and "deterministic" both occur elsewhere in the document
// for unrelated reasons, so a whole-document includes() would stay green with the fact gone
// from the section that must carry it.
// =====================================================================================

const REPLY_DETERMINISM_HEADING = '### Reply text is not deterministic';
const REPLY_NONDETERMINISM_CLAIM =
  'Two turns carrying byte-identical request audio can return different reply text';
const REPLY_NO_FIXTURE_DIFF_CLAIM = 'A client must not diff reply text against a fixture';

function assertReplyDeterminismSectionStatesTheMeasuredCorrection(section) {
  assert.ok(
    section.includes(REPLY_NONDETERMINISM_CLAIM),
    'the reply-determinism section must state that byte-identical request audio can return different reply text — the measured fact a client author would otherwise learn only from the firmware skill',
  );
  assert.ok(
    section.includes(REPLY_NO_FIXTURE_DIFF_CLAIM),
    'the reply-determinism section must instruct a client not to diff reply text against a fixture — the fact without its consequence leaves the test-writing trap open',
  );
  assert.ok(
    section.includes('Assert on the framing instead'),
    'the reply-determinism section must name the alternative a client should assert on instead of reply content',
  );
  assert.ok(
    section.includes('is stable for identical input; the reply segment is not'),
    'the reply-determinism section must scope the instability to the reply segment — a client CAN rely on transcript stability, and losing that contrast overstates what varies',
  );
  assert.ok(
    section.includes('`X-Voice-Reply-Bytes` always describes the reply that was actually sent'),
    'the reply-determinism section must state that a varying reply never makes the byte-count header wrong — otherwise a reader can conclude the framing headers are unreliable too',
  );
}

test('the reply-determinism section states that reply text varies for identical input and that a client must not diff it against a fixture', () => {
  const section = regionUnderHeading(specText, REPLY_DETERMINISM_HEADING);
  assertReplyDeterminismSectionStatesTheMeasuredCorrection(section);

  // Negative-case proof through the identical assertion path, on the do-not-diff instruction:
  // the fact alone does not tell a firmware author what to do differently.
  const mutated = section.replace(REPLY_NO_FIXTURE_DIFF_CLAIM, '');
  assert.notEqual(mutated, section, 'sanity: the mutation must have actually removed the claim');
  assert.throws(
    () => assertReplyDeterminismSectionStatesTheMeasuredCorrection(mutated),
    'the check must throw once the do-not-diff-against-a-fixture instruction is removed from the section',
  );
});

// =====================================================================================
// 08-01-PLAN.md (TEST-06/TEST-07): the proxy-fronted half of the drift gate. Every live check
// above dials the origin directly — docs/API.md's proxy-path claims (the
// '### Rejections that never reach the origin' region, PROXY_REJECTION_HEADING above) had
// nothing behind them. This section stands up an in-process, standard-library stub proxy
// that routes by `Host` — forward to the origin, or answer 404 itself with no origin
// contact — proves live that a client observes something different through the proxy than
// the origin itself emits for the same bad `Host`, and adds a bidirectional parse-and-compare
// of the proxy-rejection claim against the live-observed values, mirroring
// assertErrorCatalogueMatchesCode's own shape (parameter-not-closure, non-vacuity guard
// first, forward-and-reverse direction).
//
// D-A (08-01-PLAN.md): this stub proves docs/API.md and the running code agree with each
// other, not that either agrees with a real Tailscale Serve instance. That residual is a
// manual verification carried in 08-VALIDATION.md — no test name, assertion message, or
// comment below may state or imply the stub proxy is verified fidelity to a live Serve
// instance.
// =====================================================================================

// Same placeholder tailnet hostname docs/API.md's worked example uses (asserted present
// above by the 'carries a worked request example' test) — reused rather than a fresh
// literal, so the stub proxy's knownHosts set and the origin's configured expectedHost agree
// with the one hostname the published contract already shows a client.
const PLACEHOLDER_TAILNET_HOST = 'your-device.your-tailnet.ts.net';

// Unmistakably outside PLACEHOLDER_TAILNET_HOST and outside every other expectedHost fixture
// in this suite — never a value any config in this file configures.
const UNRECOGNIZED_HOST = 'not-a-configured-host.invalid';

// The X-Error-Code header name, recovered from buildError() rather than typed — same idiom
// as the existing 'docs/API.md documents the X-Error-Code header name...' test above.
const ERROR_CODE_HEADER_NAME = Object.keys(buildError('NOT_FOUND').headers)[0];

// The X-API-Version header name, recovered from buildTurnResponseHead() by finding the
// header key whose value equals the imported API_VERSION constant — never typed.
const SAMPLE_TURN_RESPONSE_HEAD = buildTurnResponseHead({
  transcript: '',
  reply: '',
  outputFormatId: defaultOutputFormatId(),
  audioPresent: false,
});
const API_VERSION_HEADER_NAME = Object.keys(SAMPLE_TURN_RESPONSE_HEAD.headers).find(
  (key) => SAMPLE_TURN_RESPONSE_HEAD.headers[key] === API_VERSION,
);
assert.ok(API_VERSION_HEADER_NAME, 'expected buildTurnResponseHead to expose a header carrying API_VERSION');

// Boots a loopback stub proxy that routes by `Host`: a member of knownHosts is forwarded
// verbatim to the origin on originPort; anything else is answered 404 by the proxy itself,
// with no connection to the origin ever opened on that branch — the only thing that makes an
// origin-invocation counter meaningful for the reject-branch tests below. Streams both
// directions rather than buffering either, so this never changes the mid-upload timing
// characteristics docs/API.md documents elsewhere.
function startStubProxy({ knownHosts, originPort }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : req.headers.host;
      if (!knownHosts.has(host)) {
        req.resume();
        res.writeHead(404);
        res.end();
        return;
      }
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: originPort,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Boots an origin (with an invocation counter wrapped around createRequestHandler) and a
// stub proxy in front of it, whose only known host is PLACEHOLDER_TAILNET_HOST, then issues
// the bad-Host turn through the proxy with UNRECOGNIZED_HOST. Both this function's own live
// test and Task 2's negative-case tests below call this, so the fixtures and the live check
// share one observation path. Tears both servers down in a single finally via Promise.all —
// closing only one would leak the other listener for the rest of the run.
async function observeProxyRejection() {
  const config = buildTestConfig({ security: { expectedHost: PLACEHOLDER_TAILNET_HOST } });
  const adapters = buildTestAdapters();
  let originInvocations = 0;
  const baseHandler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const originServer = await startServer((req, res) => {
    originInvocations += 1;
    baseHandler(req, res);
  });
  const proxyServer = await startStubProxy({
    knownHosts: new Set([PLACEHOLDER_TAILNET_HOST]),
    originPort: originServer.address().port,
  });
  try {
    const response = await postTurn(proxyServer.address().port, {
      body: makePcm16({ samples: 10 }),
      headers: { Host: UNRECOGNIZED_HOST },
    });
    return { response, originInvocations };
  } finally {
    await Promise.all([closeServer(originServer), closeServer(proxyServer)]);
  }
}

// Finds the paragraph in a docs/API.md region carrying the proxy-rejection claim sentence and
// extracts { claimedStatus, claimedAbsentHeaderTokens } from it — the backticked three-digit
// status following 'observes a', plus the ordered backticked X-* header tokens (including the
// wildcard family token ending in a hyphen-star, e.g. X-Voice-*) the sentence names as
// absent. Takes text as a parameter, never closes over the module-level specText, and never
// throws — a negative fixture with the claim paragraph removed or truncated away must reach
// the caller's own non-vacuity guard, not throw here. Modelled on parseErrorCatalogueRows.
function parseProxyRejectionClaim(section) {
  const paragraphs = section.split(/\n\n+/);
  const claimParagraph = paragraphs.find((paragraph) => paragraph.includes('observes a `'));
  if (!claimParagraph) {
    return { claimedStatus: null, claimedAbsentHeaderTokens: [] };
  }
  const statusMatch = /observes a `(\d{3})`/.exec(claimParagraph);
  const claimedStatus = statusMatch ? Number(statusMatch[1]) : null;
  const claimedAbsentHeaderTokens = [...claimParagraph.matchAll(/`(X-[A-Za-z0-9-]+\*?)`/g)].map((match) => match[1]);
  return { claimedStatus, claimedAbsentHeaderTokens };
}

// Bidirectional compare of the parsed proxy-rejection claim against live-observed values,
// modelled on assertErrorCatalogueMatchesCode: (1) non-vacuity guard first — a renamed
// heading or reworded claim must fail loudly, never match nothing and pass; (2) the claimed
// status must equal what was actually observed; (3) forward direction — no header the claim
// names as absent may appear in the observed response (exact lowercased equality for a plain
// token, prefix match for the wildcard family token); (4) reverse direction — every header
// name in a guarantee set built from imported code must be covered by at least one claimed
// token, so a document that quietly drops one of the guaranteed names from the sentence
// fails too. Takes section as a parameter, never closes over specText, so the live call site
// and both Task 2 negative fixtures share this one assertion path.
function assertProxyRejectionMatchesObserved(section, { observedStatus, observedHeaderNames }) {
  const { claimedStatus, claimedAbsentHeaderTokens } = parseProxyRejectionClaim(section);
  assert.ok(
    claimedStatus !== null && claimedAbsentHeaderTokens.length > 0,
    'the proxy-rejection claim parsed to no claimed status or no claimed absent header tokens — a renamed heading or reworded claim must fail loudly, never match nothing and pass',
  );
  assert.equal(
    claimedStatus,
    observedStatus,
    `docs/API.md's proxy-rejection claim states status ${claimedStatus}, but the live stub proxy observed ${observedStatus}`,
  );

  const lowerObservedHeaderNames = observedHeaderNames.map((name) => name.toLowerCase());
  for (const token of claimedAbsentHeaderTokens) {
    if (token.endsWith('-*')) {
      const prefix = token.slice(0, -1).toLowerCase();
      const present = lowerObservedHeaderNames.find((name) => name.startsWith(prefix));
      assert.ok(
        !present,
        `docs/API.md claims no ${token} headers are present on the proxy-rejected response, but the live response carried '${present}'`,
      );
    } else {
      const lowerToken = token.toLowerCase();
      assert.ok(
        !lowerObservedHeaderNames.includes(lowerToken),
        `docs/API.md claims no ${token} header is present on the proxy-rejected response, but the live response carried one`,
      );
    }
  }

  const guaranteedHeaderNames = [
    TRANSCRIPT_BYTES_HEADER,
    REPLY_BYTES_HEADER,
    AUDIO_PRESENT_HEADER,
    OUTPUT_FORMAT_RESPONSE_HEADER,
    API_VERSION_HEADER_NAME,
    ERROR_CODE_HEADER_NAME,
  ];
  for (const headerName of guaranteedHeaderNames) {
    const covered = claimedAbsentHeaderTokens.some((token) => {
      if (token.endsWith('-*')) {
        return headerName.toLowerCase().startsWith(token.slice(0, -1).toLowerCase());
      }
      return token.toLowerCase() === headerName.toLowerCase();
    });
    assert.ok(
      covered,
      `docs/API.md's proxy-rejection claim silently dropped ${headerName} from its list of headers a client behind the proxy will not see`,
    );
  }
}

test('a live request through the stub proxy with an unrecognized Host is answered 404 with no X-Error-Code header, and the origin is never invoked', async () => {
  const { response, originInvocations } = await observeProxyRejection();
  assert.equal(response.statusCode, 404);
  const observedHeaderNames = Object.keys(response.headers);
  assert.ok(
    !observedHeaderNames.map((name) => name.toLowerCase()).includes(ERROR_CODE_HEADER_NAME.toLowerCase()),
    `expected no ${ERROR_CODE_HEADER_NAME} header on the stub proxy's own 404`,
  );
  assert.equal(response.body.length, 0, "expected a zero-length body on the stub proxy's own 404 — no JSON envelope");
  assert.equal(originInvocations, 0, 'expected the origin to never be invoked for an unrecognized Host');

  const section = regionUnderHeading(specText, PROXY_REJECTION_HEADING);
  assertProxyRejectionMatchesObserved(section, {
    observedStatus: response.statusCode,
    observedHeaderNames,
  });
});

test('the same origin dialed directly with the same unrecognized Host answers 403 FORBIDDEN with an X-Error-Code header, proving the divergence the proxy-path gate exists to catch', async () => {
  const config = buildTestConfig({ security: { expectedHost: PLACEHOLDER_TAILNET_HOST } });
  const adapters = buildTestAdapters();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: makePcm16({ samples: 10 }),
      headers: { Host: UNRECOGNIZED_HOST },
    });
    assert.equal(response.statusCode, ERROR_CODES.FORBIDDEN.status);
    assert.equal(response.headers[ERROR_CODE_HEADER_NAME.toLowerCase()], 'FORBIDDEN');
  } finally {
    await closeServer(server);
  }
});

test('a live request through the stub proxy with a recognized Host reaches the origin and the origin status and X-Error-Code reach the client unchanged', async () => {
  const config = buildTestConfig({ security: { expectedHost: PLACEHOLDER_TAILNET_HOST } });
  const adapters = buildTestAdapters();
  let originInvocations = 0;
  const baseHandler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const originServer = await startServer((req, res) => {
    originInvocations += 1;
    baseHandler(req, res);
  });
  const proxyServer = await startStubProxy({
    knownHosts: new Set([PLACEHOLDER_TAILNET_HOST]),
    originPort: originServer.address().port,
  });
  try {
    // Authorization deliberately omitted so the origin answers its own UNAUTHORIZED
    // rejection cheaply — the point of this test is that the proxy forwards to the origin
    // and relays the origin's status/header unchanged, not what that status happens to be.
    const response = await postTurn(proxyServer.address().port, {
      body: makePcm16({ samples: 10 }),
      headers: { Host: PLACEHOLDER_TAILNET_HOST },
    });
    assert.equal(originInvocations, 1, 'expected a recognized Host to be forwarded to the origin exactly once');
    assert.equal(response.statusCode, ERROR_CODES.UNAUTHORIZED.status);
    assert.equal(response.headers[ERROR_CODE_HEADER_NAME.toLowerCase()], 'UNAUTHORIZED');
  } finally {
    await Promise.all([closeServer(originServer), closeServer(proxyServer)]);
  }
});

// =====================================================================================
// 08-02-PLAN.md Task 1 (TEST-06): byte-fidelity passthrough. Compares a proxied response
// against a direct-to-origin response for the identical request rather than against typed
// expectations — a proxy-only assertion has nothing to detect a rewritten body against, and
// would pass a stub that silently re-encoded the reply. The two requests are issued
// sequentially, not concurrently, because the origin holds a single-conversation turn lock
// (PROJECT.md) — a concurrent pair would race for the lock and one side would observe
// 409 TURN_BUSY instead of 200.
// =====================================================================================

test('a live turn forwarded through the stub proxy to a recognized Host is byte-for-byte identical to the same turn taken directly against the origin', async () => {
  const config = buildTestConfig({ security: { expectedHost: PLACEHOLDER_TAILNET_HOST } });
  const adapters = buildTestAdapters();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });
  const originServer = await startServer(handler);
  const proxyServer = await startStubProxy({
    knownHosts: new Set([PLACEHOLDER_TAILNET_HOST]),
    originPort: originServer.address().port,
  });
  try {
    const body = makePcm16({ samples: 10 });
    const turnHeaders = {
      Authorization: `Bearer ${TEST_CLIENT_TOKEN}`,
      [INPUT_FORMAT_HEADER]: CODEC_FREE_FORMAT_ID,
      Host: PLACEHOLDER_TAILNET_HOST,
    };

    // Sequential, not Promise.all — see comment above.
    const proxied = await postTurn(proxyServer.address().port, { body, headers: turnHeaders });
    const direct = await postTurn(originServer.address().port, { body, headers: turnHeaders });

    assert.equal(proxied.statusCode, 200, 'expected the proxied turn to succeed with 200');
    assert.equal(direct.statusCode, 200, 'expected the direct turn to succeed with 200');

    const proxiedPairs = [];
    for (let i = 0; i < proxied.rawHeaders.length; i += 2) {
      proxiedPairs.push([proxied.rawHeaders[i].toLowerCase(), proxied.rawHeaders[i + 1]]);
    }

    // 1. No compression: any content-encoding present on the proxied response must be identity.
    for (const [name, value] of proxiedPairs) {
      if (name === 'content-encoding') {
        assert.equal(value, 'identity', 'any content-encoding present on the proxied response must be exactly identity');
      }
    }

    // 2. No redirects: status is outside the 3xx range, and matches the direct response's status.
    assert.ok(
      proxied.statusCode < 300 || proxied.statusCode >= 400,
      `proxied response status ${proxied.statusCode} must never be a 3xx redirect`,
    );
    assert.equal(proxied.statusCode, direct.statusCode, 'the proxied and direct responses must carry the same status');

    // 3. No rewrite or re-buffering: bodies are byte-for-byte identical, no body-length header
    // survives the hop, and exactly one no-transform cache-control survives it too.
    assert.ok(
      proxied.body.equals(direct.body),
      'the proxied response body must be byte-for-byte identical to the direct response body',
    );
    assertNoBodyLengthHeader(proxied);
    const cacheControlPairs = proxiedPairs.filter(([name]) => name === 'cache-control');
    assert.equal(cacheControlPairs.length, 1, 'the proxied response must carry exactly one cache-control header');
    assert.ok(
      cacheControlPairs[0][1].includes('no-transform'),
      'the proxied response cache-control must include the no-transform directive',
    );

    // 4. Header passthrough unmodified: the api-version header and every X-Voice-* header
    // arrive at the proxy client with the exact value the origin emitted for the same request.
    const guaranteedHeaderNames = [
      API_VERSION_HEADER_NAME,
      TRANSCRIPT_BYTES_HEADER,
      REPLY_BYTES_HEADER,
      AUDIO_PRESENT_HEADER,
      OUTPUT_FORMAT_RESPONSE_HEADER,
    ];
    for (const headerName of guaranteedHeaderNames) {
      const lowerName = headerName.toLowerCase();
      assert.ok(lowerName in proxied.headers, `expected the proxied response to carry ${headerName}`);
      assert.ok(lowerName in direct.headers, `expected the direct response to carry ${headerName}`);
      assert.equal(
        proxied.headers[lowerName],
        direct.headers[lowerName],
        `${headerName} must survive the proxy hop unmodified — proxied '${proxied.headers[lowerName]}' vs direct '${direct.headers[lowerName]}'`,
      );
    }
  } finally {
    await Promise.all([closeServer(originServer), closeServer(proxyServer)]);
  }
});

// =====================================================================================
// 08-01-PLAN.md Task 2 (TEST-07): the vacuity guard. assertProxyRejectionSectionStatesObservedFailure
// above is a prose-only check whose section.includes('404') assertion is exactly the
// independent-substring predicate Phase 6 closed for the error catalogue — satisfiable by a
// transposed status pair because the transposed value is already present elsewhere in the
// region. Both tests below drive the same assertProxyRejectionMatchesObserved function the
// live test calls — a parallel hand-rolled "does this look empty" check would prove nothing
// about whether the real check can go vacuous.
// =====================================================================================

test('the proxy-rejection check rejects a transposed status pair that the pre-existing prose check still accepts', async () => {
  const { response } = await observeProxyRejection();
  const observedStatus = response.statusCode;
  const observedHeaderNames = Object.keys(response.headers);
  const section = regionUnderHeading(specText, PROXY_REJECTION_HEADING);

  // The two statuses to transpose: the live-observed proxy status (parsed by
  // parseProxyRejectionClaim from 'observes a `NNN`') and the origin-side status the same
  // region already names in its opening sentence ('`NNN FORBIDDEN`'). Neither is typed —
  // both are read from live observation or from the imported catalogue.
  const originStatus = ERROR_CODES.FORBIDDEN.status;
  const proxyStatusPattern = new RegExp(`(observes a \`)${observedStatus}(\`)`);
  const originStatusPattern = new RegExp(`(\`)${originStatus}( FORBIDDEN\`)`);
  assert.ok(proxyStatusPattern.test(section), 'expected to find the live-observed proxy status in the proxy-rejection region');
  assert.ok(originStatusPattern.test(section), "expected to find the origin's own status in the proxy-rejection region");

  // Two-phase substitution through unique placeholder tokens, mirroring the existing
  // __TRANSPOSE_PLACEHOLDER_...__ technique above, so the second replacement cannot rewrite
  // output the first just produced.
  const proxyPlaceholder = '__TRANSPOSE_PLACEHOLDER_PROXY_STATUS__';
  const originPlaceholder = '__TRANSPOSE_PLACEHOLDER_ORIGIN_STATUS__';
  let transposedSection = section.replace(proxyStatusPattern, `$1${proxyPlaceholder}$2`);
  transposedSection = transposedSection.replace(originStatusPattern, `$1${originPlaceholder}$2`);
  transposedSection = transposedSection.replace(proxyPlaceholder, String(originStatus));
  transposedSection = transposedSection.replace(originPlaceholder, String(observedStatus));
  assert.notEqual(transposedSection, section, 'sanity: the mutation must have actually swapped the two statuses');

  // 1. The structured check rejects the fixture.
  assert.throws(
    () => assertProxyRejectionMatchesObserved(transposedSection, { observedStatus, observedHeaderNames }),
    'assertProxyRejectionMatchesObserved must throw on a transposed proxy/origin status pair',
  );

  // 2. Demonstration half: the superseded prose check does NOT throw on this exact fixture —
  // called directly, not through assert.throws, so a regression here fails this test loudly.
  // It only checks that '404' appears somewhere in the region, and the transposition moved
  // that digit string onto the origin-status mention rather than removing it — precisely the
  // class of defect this check cannot detect.
  assertProxyRejectionSectionStatesObservedFailure(transposedSection);

  // 3. Both status values still independently appear in the transposed text, proving the
  // fixture is one a substring-presence predicate cannot discriminate.
  assert.ok(
    transposedSection.includes(String(observedStatus)),
    `${observedStatus} must still independently appear in the transposed section`,
  );
  assert.ok(
    transposedSection.includes(String(originStatus)),
    `${originStatus} must still independently appear in the transposed section`,
  );
});

test('the proxy-rejection check fails loudly when the section carries no parseable claimed status', async () => {
  const { response } = await observeProxyRejection();
  const observedStatus = response.statusCode;
  const observedHeaderNames = Object.keys(response.headers);
  const section = regionUnderHeading(specText, PROXY_REJECTION_HEADING);

  // Slice the region to end before the line carrying the claimed status — a heading-present,
  // claim-absent fixture, distinct from an absent-heading fixture (mirrors the zero-row
  // catalogue fixture's own construction above).
  const claimLineStart = section.indexOf('A client dialing this deployment with a bad');
  assert.ok(claimLineStart !== -1, 'expected to find the claim sentence in the proxy-rejection region');
  const vacuousSection = section.slice(0, claimLineStart);
  assert.notEqual(vacuousSection, section, 'sanity: the mutation must have actually removed the claim');

  assert.throws(
    () => assertProxyRejectionMatchesObserved(vacuousSection, { observedStatus, observedHeaderNames }),
    'assertProxyRejectionMatchesObserved must throw when the section carries no parseable claimed status',
  );
});

// =====================================================================================
// 08-02-PLAN.md Task 2 (TEST-06): retire the "no test can reach this half" claim under
// the operator reverse-proxy subsection and pin its replacement region-scoped — names the
// proof (this file) and names the fidelity limit (not Tailscale Serve), and keeps all four
// original operator bullets. Mirrors assertProxyRejectionSectionStatesObservedFailure's
// shape: a pure function taking section text as a parameter, never closing over specText.
// =====================================================================================

const OPERATOR_PROXY_HEADING = "### What the operator's reverse-proxy configuration must honour";
const OPERATOR_PROXY_PROOF_FILE = 'test/api-spec-contract.test.js';
const OPERATOR_PROXY_FIDELITY_LIMIT_CLAIM = 'it is not Tailscale Serve';

function assertOperatorProxySectionNamesItsProof(section) {
  assert.ok(
    section.includes(OPERATOR_PROXY_PROOF_FILE),
    `the operator reverse-proxy subsection must name ${OPERATOR_PROXY_PROOF_FILE} as its automated proof`,
  );
  assert.ok(
    section.includes(OPERATOR_PROXY_FIDELITY_LIMIT_CLAIM),
    'the operator reverse-proxy subsection must state that the stub is not Tailscale Serve',
  );
  assert.ok(
    section.includes('Not enable compression on the turn endpoint'),
    'the operator reverse-proxy subsection must keep its no-compression bullet',
  );
  assert.ok(
    section.includes('Not issue redirects in front of it'),
    'the operator reverse-proxy subsection must keep its no-redirects bullet',
  );
  assert.ok(
    section.includes('Not rewrite, re-buffer, or otherwise transform the response body'),
    'the operator reverse-proxy subsection must keep its no-rewrite/re-buffer/transform bullet',
  );
  assert.ok(
    section.includes('Pass through every `X-Voice-*` header and the `X-API-Version` header unmodified'),
    'the operator reverse-proxy subsection must keep its header-passthrough bullet',
  );
}

test('the operator reverse-proxy subsection names the test file that verifies it and names the stub fidelity limit', () => {
  const section = regionUnderHeading(specText, OPERATOR_PROXY_HEADING);
  assertOperatorProxySectionNamesItsProof(section);

  // Negative-case proof, driven through the identical assertion path: removing the
  // proof-file name must make the check throw, otherwise this test only restates the
  // claim's presence rather than proving the check can catch its absence.
  const mutated = section.replace(OPERATOR_PROXY_PROOF_FILE, '');
  assert.notEqual(mutated, section, 'sanity: the mutation must have actually removed the proof-file name');
  assert.throws(
    () => assertOperatorProxySectionNamesItsProof(mutated),
    'the check must throw once the proof-file name is removed from the section',
  );
});

test('docs/API.md no longer claims that no test in this repository can reach the proxy half', () => {
  // This literal is hand-typed deliberately: it is a value that must never appear in the
  // document again, not a catalogue being duplicated, so there is nothing to import — same
  // rationale as the file's existing deleted-surface guard (the removed /api/turn endpoint
  // and the removed singular security.token config key).
  assert.ok(
    !specText.includes('No test in this repository can reach this half'),
    'docs/API.md must not resurrect the claim that no test in this repository can reach the proxy half — this phase\'s stub-proxy tests made that claim false',
  );
});
