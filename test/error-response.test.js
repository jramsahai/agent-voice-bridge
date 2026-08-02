// API-07 contract-hardening suite for the error envelope: exact-match adjacency,
// empty/absent input, deterministic ordering, merge safety, catalogue shape invariants,
// leak-freedom under hostile input, and code/status stability as a published contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';

import { ERROR_CODES, isKnownErrorCode } from '../packages/shared/errors/error-codes.js';
import { buildError, unsupportedFormatError } from '../packages/shared/errors/error-response.js';
import {
  listSupportedFormats,
  isSupportedFormat,
  lookupFormat,
} from '../packages/shared/audio/format-registry.js';
import { prepareTranscriptionInput } from '../packages/shared/audio/convert.js';
import { makePcm16 } from './helpers/fixtures.js';

const ERROR_RESPONSE_SOURCE_URL = new URL('../packages/shared/errors/error-response.js', import.meta.url);
const ERROR_RESPONSE_SOURCE = readFileSync(ERROR_RESPONSE_SOURCE_URL, 'utf8');
const FORMAT_REGISTRY_URL = new URL('../packages/shared/audio/format-registry.js', import.meta.url);

// Read the truncation limit from the implementation itself so the two can never drift.
function readDocumentedTruncationLimit() {
  const match = ERROR_RESPONSE_SOURCE.match(/MAX_ECHOED_IDENTIFIER_LENGTH\s*=\s*(\d+)/);
  assert.ok(match, 'error-response.js must declare a documented MAX_ECHOED_IDENTIFIER_LENGTH constant');
  return Number(match[1]);
}

// --- Adjacency: the accept/reject boundary is exact, never fuzzy ---

test('every registered format id is accepted exactly and does not produce FMT_UNSUPPORTED', async () => {
  for (const id of listSupportedFormats()) {
    assert.equal(isSupportedFormat(id), true, `isSupportedFormat(${id})`);
    const result = await prepareTranscriptionInput(makePcm16({ samples: 10 }), id);
    assert.ok(!result.error, `${id} must not produce an FMT_UNSUPPORTED envelope`);
  }
});

test('an uppercased variant of each registered id is rejected as unsupported', () => {
  for (const id of listSupportedFormats()) {
    const variant = id.toUpperCase();
    if (variant === id) continue; // no case-bearing characters to mutate
    assert.equal(isSupportedFormat(variant), false, `${variant} must not resolve`);
    assert.equal(lookupFormat(variant), undefined);
  }
});

test('a leading- or trailing-space variant of each registered id is rejected as unsupported', () => {
  for (const id of listSupportedFormats()) {
    assert.equal(isSupportedFormat(` ${id}`), false, `leading space on ${id}`);
    assert.equal(isSupportedFormat(`${id} `), false, `trailing space on ${id}`);
  }
});

test('a one-character-longer variant of each registered id is rejected as unsupported', () => {
  for (const id of listSupportedFormats()) {
    assert.equal(isSupportedFormat(`${id}x`), false, `${id}x must not resolve`);
  }
});

test('an identifier naming an inherited Object.prototype member is rejected end to end through the conversion entry point', async () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const result = await prepareTranscriptionInput(makePcm16({ samples: 10 }), key);
    assert.ok(result.error, `${key} must produce an error envelope, not resolve to an inherited property`);
    assert.equal(result.error.body.error.code, 'FMT_UNSUPPORTED');
    assert.equal(result.error.headers['X-Error-Code'], 'FMT_UNSUPPORTED');
  }
});

// --- Empty and absent input ---

test('unsupportedFormatError("") returns a well-formed envelope with a readable empty-value placeholder', () => {
  const { status, headers, body } = unsupportedFormatError('');
  assert.equal(status, 415);
  assert.equal(headers['X-Error-Code'], 'FMT_UNSUPPORTED');
  assert.equal(body.error.code, 'FMT_UNSUPPORTED');
  assert.ok(body.error.message.length > 0);
  assert.ok(!body.error.message.includes("''"), 'message must not contain an empty gap between quotes');
  assert.deepEqual(body.error.supportedFormats, listSupportedFormats());
});

test('unsupportedFormatError(null) and unsupportedFormatError(undefined) return well-formed envelopes without interpolating the bare primitive name', () => {
  for (const value of [null, undefined]) {
    const { status, body } = unsupportedFormatError(value);
    assert.equal(status, 415);
    assert.equal(body.error.code, 'FMT_UNSUPPORTED');
    assert.ok(!body.error.message.includes('null'), `message for ${value} must not contain the literal 'null'`);
    assert.ok(!body.error.message.includes('undefined'), `message for ${value} must not contain the literal 'undefined'`);
    assert.deepEqual(body.error.supportedFormats, listSupportedFormats());
  }
});

test("buildError('FMT_UNSUPPORTED', '') returns a non-empty message", () => {
  const { body } = buildError('FMT_UNSUPPORTED', '');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
});

// --- Ordering and stability ---

test('supportedFormats is emitted in lexicographic order', () => {
  const { body } = unsupportedFormatError('x');
  assert.deepEqual(body.error.supportedFormats, [...body.error.supportedFormats].sort());
});

test('two consecutive calls return deep-equal but not identity-equal arrays, and caller mutation does not leak', () => {
  const first = unsupportedFormatError('x').body.error.supportedFormats;
  const second = unsupportedFormatError('x').body.error.supportedFormats;
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  first.push('mutated-by-caller');
  assert.ok(!unsupportedFormatError('x').body.error.supportedFormats.includes('mutated-by-caller'));
});

test('the supported-format order does not depend on object key enumeration order in a fresh process', () => {
  const inProcess = listSupportedFormats();
  const script = `import { listSupportedFormats } from ${JSON.stringify(FORMAT_REGISTRY_URL.href)}; console.log(JSON.stringify(listSupportedFormats()));`;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(stdout.trim()), inProcess);
});

// --- Merge safety ---

test('extra.body extras merge onto body.error alongside code and message', () => {
  const { body } = buildError('FMT_UNSUPPORTED', 'm', { body: { supportedFormats: ['a'], detailUrl: 'x' } });
  assert.deepEqual(body.error.supportedFormats, ['a']);
  assert.equal(body.error.detailUrl, 'x');
  assert.equal(body.error.code, 'FMT_UNSUPPORTED');
  assert.equal(body.error.message, 'm');
});

test('extra.body cannot overwrite code or message even when it tries to spoof both', () => {
  const { body } = buildError('FMT_UNSUPPORTED', 'm', { body: { code: 'SPOOFED', message: 'spoofed' } });
  assert.equal(body.error.code, 'FMT_UNSUPPORTED');
  assert.equal(body.error.message, 'm');
});

// --- Catalogue invariants ---

test('every ERROR_CODES entry has an integer status in 400..599 and a non-empty title', () => {
  for (const [key, value] of Object.entries(ERROR_CODES)) {
    assert.ok(Number.isInteger(value.status), `${key}.status must be an integer`);
    assert.ok(value.status >= 400 && value.status <= 599, `${key}.status must be in 400..599`);
    assert.equal(typeof value.title, 'string', `${key}.title must be a string`);
    assert.ok(value.title.length > 0, `${key}.title must be non-empty`);
  }
});

test('every ERROR_CODES key matches the uppercase-with-underscores pattern', () => {
  for (const key of Object.keys(ERROR_CODES)) {
    assert.match(key, /^[A-Z][A-Z0-9_]*$/);
  }
});

test('ERROR_CODES and each entry are frozen against mutation', () => {
  assert.ok(Object.isFrozen(ERROR_CODES));
  for (const value of Object.values(ERROR_CODES)) {
    assert.ok(Object.isFrozen(value));
  }
  assert.throws(() => {
    ERROR_CODES.INJECTED = { status: 400, title: 'x' };
  });
});

test('isKnownErrorCode reflects the frozen catalogue', () => {
  assert.equal(isKnownErrorCode('FMT_UNSUPPORTED'), true);
  assert.equal(isKnownErrorCode('NOT_A_REAL_CODE'), false);
});

// --- Leak-freedom under hostile input ---

test('hostile identifiers (absolute path, tilde path, embedded newline, 4KB) still yield a well-formed single-header envelope', () => {
  const hostileInputs = [
    '/etc/passwd',
    '~/secrets/token',
    'evil\nX-Injected-Header: true',
    'x'.repeat(4096),
  ];
  for (const input of hostileInputs) {
    const { body, headers } = unsupportedFormatError(input);
    assert.equal(body.error.code, 'FMT_UNSUPPORTED');
    assert.deepEqual(Object.keys(headers), ['X-Error-Code']);
    assert.equal(headers['X-Error-Code'], body.error.code);
  }
});

test('an over-long identifier is truncated in the message with a visible ellipsis at the documented limit', () => {
  const limit = readDocumentedTruncationLimit();
  const longId = 'x'.repeat(limit + 500);
  const { body } = unsupportedFormatError(longId);
  assert.ok(!body.error.message.includes(longId), 'the full identifier must not be echoed whole');
  assert.ok(body.error.message.includes('...'), 'the message must contain a visible ellipsis');
  assert.ok(body.error.message.includes('x'.repeat(limit)), 'the message must contain the truncated prefix');
});

test('a serialised envelope for every code contains no host path, home directory, afconvert path, or stack frame', () => {
  // planner-discipline-allow: process.cwd
  // planner-discipline-allow: process.env
  // Derived at test time so this assertion works on any machine — error-response.js
  // itself must never call either (asserted separately by a source grep in Task 1's
  // acceptance criteria).
  const cwd = process.cwd();
  const home = os.homedir();
  for (const code of Object.keys(ERROR_CODES)) {
    const serialised = JSON.stringify(buildError(code, ERROR_CODES[code].title));
    assert.ok(!serialised.includes(cwd), `${code} envelope must not leak process.cwd()`);
    assert.ok(!serialised.includes(home), `${code} envelope must not leak os.homedir()`);
    assert.ok(!serialised.includes('/usr/bin/afconvert'), `${code} envelope must not leak the afconvert path`);
    assert.ok(!serialised.includes('at Object.'), `${code} envelope must not leak a stack frame`);
  }
});

// --- Code stability: the mechanical form of the "never redefine a published code" prohibition ---

test('the published error code list is exactly the pinned literal', () => {
  // A failure here means a published contract is changing — confirm the change is an
  // addition or retirement, never a silent redefinition, before updating this literal.
  const PUBLISHED_CODES = ['AUDIO_CONVERSION_FAILED', 'AUDIO_MALFORMED', 'AUDIO_TOO_LARGE', 'FMT_UNSUPPORTED'];
  assert.deepEqual(Object.keys(ERROR_CODES).sort(), PUBLISHED_CODES.sort());
});

test('the published error code -> status mapping is exactly the pinned literal', () => {
  // A status change for an already-published code is a contract change and must be a
  // deliberate edit in two places (error-codes.js and this literal), never silent drift.
  const PUBLISHED_STATUS = {
    FMT_UNSUPPORTED: 415,
    AUDIO_MALFORMED: 400,
    AUDIO_TOO_LARGE: 413,
    AUDIO_CONVERSION_FAILED: 500,
  };
  const actual = Object.fromEntries(Object.entries(ERROR_CODES).map(([key, value]) => [key, value.status]));
  assert.deepEqual(Object.entries(actual).sort(), Object.entries(PUBLISHED_STATUS).sort());
});

test('no two ERROR_CODES entries share a title', () => {
  const titles = Object.values(ERROR_CODES).map((value) => value.title);
  assert.equal(new Set(titles).size, titles.length);
});

// --- Header parity under stress ---

test('every code produces exactly one header key, X-Error-Code, regardless of extra', () => {
  for (const code of Object.keys(ERROR_CODES)) {
    const { headers } = buildError(code, 'x', { body: { supportedFormats: ['a'], detailUrl: 'y' } });
    assert.deepEqual(Object.keys(headers), ['X-Error-Code']);
  }
});
