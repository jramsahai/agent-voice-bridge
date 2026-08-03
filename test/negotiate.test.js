// FMT-01/FMT-02, D-03: the complete, direction-aware /v1/turn header negotiation
// contract. Pure unit coverage, no socket, no server — matches test/format-registry.test.js's
// style (plain node:test + node:assert/strict, direct assertions on returned plain objects).
// 03-01 proved only the happy path; this file proves every absent, empty, malformed,
// oversized, mis-cased and out-of-direction header value resolves to one defined outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  negotiate,
  INPUT_FORMAT_HEADER,
  OUTPUT_FORMAT_HEADER,
  WANT_AUDIO_HEADER,
  WANT_AUDIO_DISABLED_TOKEN,
  defaultOutputFormatId,
  listReplyFormats,
} from '../packages/shared/transport/negotiate.js';
import { AUDIO_FORMATS, listSupportedFormats } from '../packages/shared/audio/format-registry.js';
import { unsupportedFormatError } from '../packages/shared/errors/error-response.js';
import { prepareClientOutput } from '../packages/shared/audio/convert.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

const inputHeader = INPUT_FORMAT_HEADER.toLowerCase();
const outputHeader = OUTPUT_FORMAT_HEADER.toLowerCase();
const wantAudioHeader = WANT_AUDIO_HEADER.toLowerCase();

function headersWith(overrides = {}) {
  return { [inputHeader]: 'pcm16', ...overrides };
}

// --- Task 1: input-format and want-audio edges ---

test('negotiate({}) rejects an absent input format with the same envelope unsupportedFormatError(undefined) produces', () => {
  const result = negotiate({});
  const expected = unsupportedFormatError(undefined);

  assert.ok(result.error);
  assert.equal(result.error.status, 415);
  assert.equal(result.error.headers['X-Error-Code'], 'FMT_UNSUPPORTED');
  assert.deepEqual(result.error, expected);
});

test('an empty-string input format header rejects with the same envelope unsupportedFormatError("") produces', () => {
  const result = negotiate({ [inputHeader]: '' });
  const expected = unsupportedFormatError('');

  assert.ok(result.error);
  assert.equal(result.error.status, 415);
  assert.equal(result.error.headers['X-Error-Code'], 'FMT_UNSUPPORTED');
  assert.deepEqual(result.error, expected);
});

test('an unregistered input format id rejects with body.error.supportedFormats equal to the registry\'s own sorted list', () => {
  const result = negotiate({ [inputHeader]: 'mp3' });

  assert.ok(result.error);
  assert.equal(result.error.status, 415);
  assert.deepEqual(result.error.body.error.supportedFormats, listSupportedFormats());
});

test('a 5000-character input format id returns a message shorter than 1000 characters', () => {
  const longId = 'x'.repeat(5000);
  const result = negotiate({ [inputHeader]: longId });

  assert.ok(result.error);
  assert.ok(result.error.body.error.message.length < 1000, 'message must be bounded, not a full reflection');
});

test('an input format id matching a registered id except for case, or with surrounding whitespace, is rejected — the exact registered id is not', () => {
  const uppercased = negotiate({ [inputHeader]: 'PCM16' });
  const padded = negotiate({ [inputHeader]: ' pcm16 ' });
  const exact = negotiate({ [inputHeader]: 'pcm16' });

  assert.ok(uppercased.error, 'uppercased id must be rejected — no case folding');
  assert.ok(padded.error, 'padded id must be rejected — no trimming');
  assert.equal(exact.error, undefined, 'exact registered id must not be rejected');
});

test('a repeated input-format header (Node\'s comma-joined duplicate form) is rejected, not silently split', () => {
  const result = negotiate({ [inputHeader]: 'pcm16, pcm16' });
  assert.ok(result.error);
});

test('an absent want-audio header resolves wantAudio true', () => {
  const result = negotiate(headersWith());
  assert.equal(result.error, undefined);
  assert.equal(result.wantAudio, true);
});

test('a want-audio header equal to the disabled token resolves wantAudio false', () => {
  const result = negotiate(headersWith({ [wantAudioHeader]: WANT_AUDIO_DISABLED_TOKEN }));
  assert.equal(result.error, undefined);
  assert.equal(result.wantAudio, false);
});

test('a want-audio header set to any other value, including a longer word or an empty string, resolves wantAudio true', () => {
  for (const value of ['false', '', '00']) {
    const result = negotiate(headersWith({ [wantAudioHeader]: value }));
    assert.equal(result.error, undefined, `value '${value}' must not itself be a format rejection`);
    assert.equal(result.wantAudio, true, `value '${value}' must resolve wantAudio true`);
  }
});

test('negotiate({}) resolves an object rather than throwing; a call with no headers argument at all throws', () => {
  assert.doesNotThrow(() => negotiate({}));
  assert.throws(() => negotiate());
});

// --- Task 2: direction-aware output-format availability ---

test('listReplyFormats() deep-equals the registry rows filtered by headerless, sorted', () => {
  const expected = Object.entries(AUDIO_FORMATS)
    .filter(([, row]) => row.headerless)
    .map(([id]) => id)
    .sort();
  assert.deepEqual(listReplyFormats(), expected);
});

test('an output format header of "wav" rejects with supportedFormats equal to listReplyFormats(), and does not include "wav"', () => {
  const result = negotiate(headersWith({ [outputHeader]: 'wav' }));

  assert.ok(result.error);
  assert.equal(result.error.status, 415);
  assert.deepEqual(result.error.body.error.supportedFormats, listReplyFormats());
  assert.ok(!result.error.body.error.supportedFormats.includes('wav'));
});

test('an unregistered output format id rejects, naming only reply-direction formats', () => {
  const result = negotiate(headersWith({ [outputHeader]: 'flac' }));

  assert.ok(result.error);
  assert.equal(result.error.status, 415);
  assert.deepEqual(result.error.body.error.supportedFormats, listReplyFormats());
});

test('no output format header resolves outputFormatId to defaultOutputFormatId(), a member of listReplyFormats()', () => {
  const result = negotiate(headersWith());

  assert.equal(result.error, undefined);
  assert.equal(result.outputFormatId, defaultOutputFormatId());
  assert.ok(listReplyFormats().includes(result.outputFormatId));
});

test('every id in listReplyFormats() resolves without an error as the requested output format', () => {
  for (const id of listReplyFormats()) {
    const result = negotiate(headersWith({ [outputHeader]: id }));
    assert.equal(result.error, undefined, `id '${id}' must resolve without an error`);
    assert.equal(result.outputFormatId, id);
  }
});

test('prepareClientOutput(canonicalWav, "wav") still resolves the Phase 1 415 backstop, unchanged', async () => {
  const wav = makeCanonicalWav({ pcm: makePcm16() });
  const result = await prepareClientOutput(wav, 'wav');

  assert.ok(result.error);
  assert.equal(result.error.status, 415);
  assert.equal(result.error.headers['X-Error-Code'], 'FMT_UNSUPPORTED');
});
