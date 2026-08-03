// End-to-end codec-free contract slice: pcm16 in, pcm16 out, unknown format id rejected.
// Every assertion here is written before the modules under test exist (TDD RED), then the
// four library modules are implemented until this file goes green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

import { ERROR_CODES, isKnownErrorCode } from '../packages/shared/errors/error-codes.js';
import { buildError, unsupportedFormatError } from '../packages/shared/errors/error-response.js';
import { TurnBusyError, TurnAbortedError, assertTurnCodeRegistered } from '../packages/shared/errors/turn-errors.js';
import {
  AUDIO_FORMATS,
  listSupportedFormats,
  lookupFormat,
  isSupportedFormat,
} from '../packages/shared/audio/format-registry.js';
import { MAX_PCM_BYTES, pcmToWav } from '../packages/shared/audio/wav.js';
import { prepareTranscriptionInput, prepareClientOutput, toErrorEnvelope } from '../packages/shared/audio/convert.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

// Read convert.js's own temp-directory prefix from its source text (regex, not a new
// export), same pattern test/convert.test.js already uses. Asserting that no such temp
// directory was created is a reliable "no subprocess spawned" signal regardless of when the
// module was imported — unlike mock.method(childProcess, 'execFile', ...), which cannot
// intercept convert.js's own promisify(execFile), captured once at module-load time, no
// matter when the mock is installed (see REVIEW.md WR-06).
const CONVERT_SOURCE_URL = new URL('../packages/shared/audio/convert.js', import.meta.url);
const CONVERT_SOURCE = fs.readFileSync(CONVERT_SOURCE_URL, 'utf8');

function readTempDirPrefix() {
  const match = CONVERT_SOURCE.match(/TEMP_DIR_PREFIX\s*=\s*'([^']+)'/);
  assert.ok(match, 'convert.js must declare a documented TEMP_DIR_PREFIX constant');
  return match[1];
}

function listMatchingTempEntries(prefix) {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix));
}

// --- Registry ---

test('lookupFormat(pcm16) returns the expected row', () => {
  const entry = lookupFormat('pcm16');
  assert.equal(entry.headerless, true);
  assert.equal(entry.sampleRate, 16000);
  assert.equal(entry.channels, 1);
  assert.equal(entry.bitDepth, 16);
});

test('lookupFormat returns undefined for an unregistered id', () => {
  assert.equal(lookupFormat('definitely-not-a-format'), undefined);
});

test('listSupportedFormats returns a sorted, fresh array containing pcm16', () => {
  const a = listSupportedFormats();
  const b = listSupportedFormats();
  assert.ok(a.includes('pcm16'));
  assert.deepEqual(a, [...a].sort());
  assert.notEqual(a, b);
  a.push('mutated-by-caller');
  assert.ok(!listSupportedFormats().includes('mutated-by-caller'));
});

test('lookupFormat and isSupportedFormat are prototype-safe', () => {
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(lookupFormat(key), undefined, `lookupFormat(${key})`);
    assert.equal(isSupportedFormat(key), false, `isSupportedFormat(${key})`);
  }
  for (const bad of [42, {}, Symbol('x')]) {
    assert.equal(lookupFormat(bad), undefined);
  }
});

test('AUDIO_FORMATS is frozen against mutation', () => {
  const before = Object.keys(AUDIO_FORMATS).length;
  assert.throws(() => {
    AUDIO_FORMATS.injected = {};
  });
  assert.equal(Object.keys(AUDIO_FORMATS).length, before);
});

// --- Error contract ---

test('buildError sets X-Error-Code header equal to body.error.code', () => {
  const { headers, body } = buildError('FMT_UNSUPPORTED', 'anything');
  assert.equal(headers['X-Error-Code'], body.error.code);
  assert.equal(body.error.code, 'FMT_UNSUPPORTED');
});

test('buildError throws for a code absent from ERROR_CODES', () => {
  assert.throws(() => buildError('NOT_A_REAL_CODE', 'x'));
});

test('unsupportedFormatError names every supported format', () => {
  const supported = listSupportedFormats();
  const { status, body } = unsupportedFormatError('mp3');
  assert.equal(status, 415);
  assert.equal(body.error.code, 'FMT_UNSUPPORTED');
  for (const id of supported) {
    assert.ok(body.error.message.includes(id), `message should mention '${id}'`);
  }
  assert.deepEqual(body.error.supportedFormats, supported);
});

test('every ERROR_CODES entry round-trips through buildError with matching header/body code', () => {
  for (const code of Object.keys(ERROR_CODES)) {
    const { headers, body } = buildError(code, 'x');
    assert.equal(headers['X-Error-Code'], body.error.code);
    assert.equal(body.error.code, code);
  }
});

test('ERROR_CODES holds exactly the six codes phases 1 and 2 can produce', () => {
  assert.deepEqual(
    Object.keys(ERROR_CODES).sort(),
    [
      'AUDIO_CONVERSION_FAILED',
      'AUDIO_MALFORMED',
      'AUDIO_TOO_LARGE',
      'FMT_UNSUPPORTED',
      'TURN_ABORTED',
      'TURN_BUSY',
    ].sort(),
  );
  assert.equal(ERROR_CODES.FMT_UNSUPPORTED.status, 415);
  assert.equal(ERROR_CODES.AUDIO_MALFORMED.status, 400);
  assert.equal(ERROR_CODES.AUDIO_TOO_LARGE.status, 413);
  assert.equal(ERROR_CODES.AUDIO_CONVERSION_FAILED.status, 500);
  assert.equal(ERROR_CODES.TURN_BUSY.status, 409);
  assert.equal(ERROR_CODES.TURN_ABORTED.status, 499);
});

test('TurnBusyError and TurnAbortedError construct with a registered catalogue code and a message with no path-like or numeric-identifier content', () => {
  for (const ErrorClass of [TurnBusyError, TurnAbortedError]) {
    const err = new ErrorClass();
    assert.equal(isKnownErrorCode(err.code), true);
    assert.equal(err.name, ErrorClass.name);
    assert.ok(!/\d{2,}/.test(err.message), `${ErrorClass.name} message must carry no numeric-identifier content`);
    assert.ok(!err.message.includes('/'), `${ErrorClass.name} message must carry no path-like content`);
  }
});

test('assertTurnCodeRegistered throws for a code absent from the catalogue and passes through a registered one', () => {
  assert.throws(() => assertTurnCodeRegistered('NOT_A_REAL_TURN_CODE'));
  assert.doesNotThrow(() => assertTurnCodeRegistered('TURN_BUSY'));
  assert.equal(assertTurnCodeRegistered('TURN_ABORTED'), 'TURN_ABORTED');
});

test('isKnownErrorCode reflects the catalogue', () => {
  assert.equal(isKnownErrorCode('FMT_UNSUPPORTED'), true);
  assert.equal(isKnownErrorCode('NOT_A_REAL_CODE'), false);
});

test('extra.body cannot overwrite code or message', () => {
  const { body } = buildError('FMT_UNSUPPORTED', 'real message', {
    body: { code: 'HIJACKED', message: 'hijacked message', supportedFormats: ['x'] },
  });
  assert.equal(body.error.code, 'FMT_UNSUPPORTED');
  assert.equal(body.error.message, 'real message');
  assert.deepEqual(body.error.supportedFormats, ['x']);
});

// --- wav.js size guard ---

test('pcmToWav throws AUDIO_TOO_LARGE above MAX_PCM_BYTES', () => {
  assert.throws(
    () => pcmToWav(Buffer.alloc(MAX_PCM_BYTES + 2)),
    (err) => err.code === 'AUDIO_TOO_LARGE',
  );
});

// --- Codec-free round trip (the tracer's whole point) ---

test('prepareTranscriptionInput(pcm16) produces a byte-identical WAV with no subprocess spawned', async () => {
  const pcm = makePcm16({ samples: 16000 });
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const { wavBuffer, meta } = await prepareTranscriptionInput(pcm, 'pcm16');
  assert.deepEqual(wavBuffer, makeCanonicalWav({ pcm }));
  assert.equal(meta.converted, false);
  assert.equal(meta.spawned, false);
  assert.deepEqual(
    listMatchingTempEntries(prefix).sort(),
    before.sort(),
    'no convert.js temp directory was created — the codec-free path never reached execFileAsync',
  );
});

test('prepareClientOutput(pcm16) extracts byte-identical PCM with no subprocess spawned', async () => {
  const pcm = makePcm16({ samples: 16000 });
  const wav = makeCanonicalWav({ pcm });
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const { buffer, mimeType, meta } = await prepareClientOutput(wav, 'pcm16');
  assert.deepEqual(buffer, pcm);
  assert.equal(mimeType, lookupFormat('pcm16').mimeType);
  assert.equal(meta.spawned, false);
  assert.deepEqual(
    listMatchingTempEntries(prefix).sort(),
    before.sort(),
    'no convert.js temp directory was created — the codec-free path never reached execFileAsync',
  );
});

// --- Rejection path ---

test('prepareTranscriptionInput resolves (does not reject) with an envelope for an unknown format', async () => {
  const pcm = makePcm16({ samples: 16000 });
  const result = await prepareTranscriptionInput(pcm, 'ogg-opus');
  assert.ok(result.error, 'expected a resolved error envelope, not a thrown error');
  assert.equal(result.error.status, 415);
  assert.deepEqual(result.error.body.error.supportedFormats, listSupportedFormats());
});

// --- Documented throw-vs-resolve contract (WR-01) ---

test('toErrorEnvelope converts a thrown AUDIO_MALFORMED/AUDIO_TOO_LARGE-coded error into the same envelope shape buildError produces', () => {
  const malformed = new Error('bad wav');
  malformed.code = 'AUDIO_MALFORMED';
  const envelope = toErrorEnvelope(malformed);
  assert.equal(envelope.status, 400);
  assert.equal(envelope.body.error.code, 'AUDIO_MALFORMED');

  const tooLarge = new Error('too big');
  tooLarge.code = 'AUDIO_TOO_LARGE';
  const envelope2 = toErrorEnvelope(tooLarge);
  assert.equal(envelope2.status, 413);
  assert.equal(envelope2.body.error.code, 'AUDIO_TOO_LARGE');
});

test('toErrorEnvelope rethrows an error whose code is not a registered ERROR_CODES entry', () => {
  const unrelated = new Error('not an audio error');
  unrelated.code = 'ENOENT';
  assert.throws(() => toErrorEnvelope(unrelated), (err) => err === unrelated);
});

test('prepareTranscriptionInput throws (per the documented contract) for a malformed source buffer, and toErrorEnvelope maps that throw to AUDIO_MALFORMED', async () => {
  await assert.rejects(
    () => prepareTranscriptionInput(makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }).subarray(0, 2), 'wav'),
    (err) => {
      assert.equal(toErrorEnvelope(err).body.error.code, 'AUDIO_MALFORMED');
      return true;
    },
  );
});

test('prepareClientOutput resolves (does not reject) with a 415 envelope for a registered container-format reply request', async () => {
  const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 100 }) });
  const result = await prepareClientOutput(wav, 'wav');
  assert.ok(result.error, 'expected a resolved error envelope, not a thrown error');
  assert.equal(result.error.status, 415);
  assert.equal(result.error.body.error.code, 'FMT_UNSUPPORTED');
});
