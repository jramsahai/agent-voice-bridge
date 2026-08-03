// Codec-free WAV framing: RIFF chunk walker, headerless PCM extraction, fmt chunk reader.
// Every assertion here targets pure buffer math — no subprocess, no filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ERROR_CODES } from '../packages/shared/errors/error-codes.js';
import { findDataChunk, wavToPcm, readWavFormat, pcmToWav, MAX_PCM_BYTES } from '../packages/shared/audio/wav.js';
import {
  makePcm16,
  makeCanonicalWav,
  makeWavWithFillerChunk,
  makeStereoWav,
  makeMalformedWav,
} from './helpers/fixtures.js';

// --- Walker correctness ---

test('findDataChunk locates data at offset 44 in a canonical WAV', () => {
  const pcm = makePcm16({ samples: 100 });
  const wav = makeCanonicalWav({ pcm });
  const { offset, size } = findDataChunk(wav);
  assert.equal(offset, 44);
  assert.equal(size, pcm.length);
});

test('findDataChunk locates data at offset 4096 past a 4044-byte filler chunk', () => {
  const pcm = makePcm16({ samples: 100 });
  const wav = makeWavWithFillerChunk({ pcm, fillerBytes: 4044 });
  const { offset, size } = findDataChunk(wav);
  assert.equal(offset, 4096);
  assert.equal(size, pcm.length);
});

test('findDataChunk finds data past an odd-sized unrecognised chunk, honoring its word-alignment pad byte', () => {
  // Built directly (not via makeWavWithFillerChunk, which only exercises even filler sizes)
  // so the pad byte a real odd-sized RIFF chunk requires is present in this fixture.
  const pcm = makePcm16({ samples: 10 });
  const fmtChunk = Buffer.alloc(8 + 16);
  fmtChunk.write('fmt ', 0, 'ascii');
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(1, 8);
  fmtChunk.writeUInt16LE(1, 10);
  fmtChunk.writeUInt32LE(16000, 12);
  fmtChunk.writeUInt32LE(32000, 16);
  fmtChunk.writeUInt16LE(2, 20);
  fmtChunk.writeUInt16LE(16, 22);

  const oddPayload = Buffer.alloc(5, 0xaa); // odd size -> requires one word-alignment pad byte
  const oddChunk = Buffer.concat([Buffer.from('ODDX'), Buffer.from([5, 0, 0, 0]), oddPayload, Buffer.from([0])]);

  const dataChunk = Buffer.alloc(8 + pcm.length);
  dataChunk.write('data', 0, 'ascii');
  dataChunk.writeUInt32LE(pcm.length, 4);
  pcm.copy(dataChunk, 8);

  const body = Buffer.concat([fmtChunk, oddChunk, dataChunk]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'ascii');
  const wav = Buffer.concat([header, body]);

  const { offset, size } = findDataChunk(wav);
  assert.equal(size, pcm.length);
  assert.deepEqual(wav.subarray(offset, offset + size), pcm);
});

// --- Extraction correctness ---

test('wavToPcm extracts the exact pcm payload from a canonical WAV', () => {
  const pcm = makePcm16({ samples: 100 });
  assert.deepEqual(wavToPcm(makeCanonicalWav({ pcm })), pcm);
});

test('wavToPcm extracts the exact pcm payload past a filler chunk (byte-44 regression guard)', () => {
  const pcm = makePcm16({ samples: 100 });
  assert.deepEqual(wavToPcm(makeWavWithFillerChunk({ pcm })), pcm);
});

for (const samples of [0, 1, 16000]) {
  test(`wavToPcm(pcmToWav(pcm)) round-trips for ${samples} samples`, () => {
    const pcm = samples === 0 ? Buffer.alloc(0) : makePcm16({ samples });
    assert.deepEqual(wavToPcm(pcmToWav(pcm)), pcm);
  });
}

// --- Format reading ---

test('readWavFormat reports sampleRate/channels/bitDepth from a canonical WAV', () => {
  const pcm = makePcm16({ samples: 100 });
  const wav = makeCanonicalWav({ pcm, sampleRate: 16000, channels: 1, bitDepth: 16 });
  assert.deepEqual(readWavFormat(wav), { sampleRate: 16000, channels: 1, bitDepth: 16 });
});

test('readWavFormat reports 2 channels for a stereo fixture', () => {
  const pcm = makePcm16({ samples: 100 });
  const wav = makeStereoWav({ pcm, sampleRate: 44100 });
  const format = readWavFormat(wav);
  assert.equal(format.channels, 2);
  assert.equal(format.sampleRate, 44100);
});

test('readWavFormat finds fmt by walking, not by reading offset 20, past a filler chunk', () => {
  const pcm = makePcm16({ samples: 100 });
  const wav = makeWavWithFillerChunk({ pcm, sampleRate: 16000, channels: 1, bitDepth: 16 });
  assert.deepEqual(readWavFormat(wav), { sampleRate: 16000, channels: 1, bitDepth: 16 });
});

// --- Hostile and malformed input ---

test('findDataChunk throws AUDIO_MALFORMED for a WAV with no data chunk', () => {
  assert.throws(
    () => findDataChunk(makeMalformedWav('no-data-chunk')),
    (err) => err.code === 'AUDIO_MALFORMED',
  );
});

test('findDataChunk throws AUDIO_MALFORMED for a truncated header', () => {
  assert.throws(
    () => findDataChunk(makeMalformedWav('truncated-header')),
    (err) => err.code === 'AUDIO_MALFORMED',
  );
});

test('findDataChunk throws AUDIO_MALFORMED for a zero-size chunk, in under 100ms', () => {
  const start = Date.now();
  assert.throws(
    () => findDataChunk(makeMalformedWav('zero-size-chunk')),
    (err) => err.code === 'AUDIO_MALFORMED',
  );
  assert.ok(Date.now() - start < 100, 'must not hang or loop');
});

test('findDataChunk throws AUDIO_MALFORMED for a data chunk declaring a size beyond the buffer', () => {
  assert.throws(
    () => findDataChunk(makeMalformedWav('size-beyond-buffer')),
    (err) => err.code === 'AUDIO_MALFORMED',
  );
});

test('findDataChunk throws AUDIO_MALFORMED for an empty buffer', () => {
  assert.throws(
    () => findDataChunk(Buffer.alloc(0)),
    (err) => err.code === 'AUDIO_MALFORMED',
  );
});

test('findDataChunk throws AUDIO_MALFORMED for a buffer that is just the ascii bytes "RIFF"', () => {
  assert.throws(
    () => findDataChunk(Buffer.from('RIFF')),
    (err) => err.code === 'AUDIO_MALFORMED',
  );
});

test('AUDIO_MALFORMED is a real code in the catalogue', () => {
  assert.ok('AUDIO_MALFORMED' in ERROR_CODES);
});

test('readWavFormat throws AUDIO_MALFORMED (not a RangeError) for a fmt chunk declaring fewer than 16 bytes', () => {
  assert.throws(
    () => readWavFormat(makeMalformedWav('undersized-fmt-chunk')),
    (err) => err.code === 'AUDIO_MALFORMED',
  );
});

// --- Writer boundaries (extending the tracer's coverage) ---

test('pcmToWav throws above MAX_PCM_BYTES', () => {
  assert.throws(
    () => pcmToWav(Buffer.alloc(MAX_PCM_BYTES + 2)),
    (err) => err.code === 'AUDIO_TOO_LARGE',
  );
});

test('pcmToWav throws for a buffer that is not a whole number of 16-bit mono frames', () => {
  assert.throws(
    () => pcmToWav(Buffer.alloc(3)),
    (err) => err.code === 'AUDIO_MALFORMED',
  );
});

test('pcmToWav succeeds for an empty buffer, producing a 44-byte WAV with data size 0', () => {
  const wav = pcmToWav(Buffer.alloc(0));
  assert.equal(wav.length, 44);
  assert.equal(wav.readUInt32LE(40), 0);
});

// --- Passthrough fidelity: nothing is silently altered ---
//
// wav.js is pure buffer math (see the file-level comment above) and never imports
// node:child_process at all, so a mock.method(childProcess, 'execFile', ...) guard here
// would protect nothing real even if it worked — and post-import mock.method patches can't
// intercept a promisify(execFile) captured at module-load time regardless (see REVIEW.md
// WR-06). The source-scan test below is a reliable, timing-independent proof that this
// module structurally cannot spawn a subprocess.

test('wav.js source never imports child_process or references execFile/spawn', () => {
  const wavSourceUrl = new URL('../packages/shared/audio/wav.js', import.meta.url);
  const source = fs.readFileSync(wavSourceUrl, 'utf8');
  assert.ok(!source.includes('child_process'), 'wav.js must not import child_process');
  assert.ok(!source.includes('execFile'), 'wav.js must not reference execFile');
  assert.ok(!source.includes('spawn'), 'wav.js must not reference spawn');
});

test('codec-free path is byte-faithful in both directions', () => {
  // Bitwise fidelity across empty, minimal, and realistic pcm byte lengths.
  const byteLengths = [0, 2, 4, 1000, 32000];
  for (const length of byteLengths) {
    const pcm = length === 0 ? Buffer.alloc(0) : makePcm16({ samples: length / 2 });
    const roundTripped = wavToPcm(pcmToWav(pcm));
    assert.deepEqual(roundTripped, pcm, `round trip mismatch at ${length} pcm bytes`);
  }

  // Deliberately negative first sample, positive last sample: a sign-handling defect
  // (e.g. writing/reading as unsigned) would corrupt one or both.
  const pcm = Buffer.alloc(4);
  pcm.writeInt16LE(-12345, 0);
  pcm.writeInt16LE(6789, 2);
  const roundTripped = wavToPcm(pcmToWav(pcm));
  assert.equal(roundTripped.readInt16LE(0), -12345);
  assert.equal(roundTripped.readInt16LE(2), 6789);

  // Neither direction mutates its input.
  const original = makePcm16({ samples: 100 });
  const originalCopy = Buffer.from(original);
  pcmToWav(original);
  assert.deepEqual(original, originalCopy, 'pcmToWav must not mutate its input');

  const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 100 }) });
  const wavCopy = Buffer.from(wav);
  wavToPcm(wav);
  assert.deepEqual(wav, wavCopy, 'wavToPcm must not mutate its input');

  // Header honesty: the writer records what the caller declared, not whisper defaults.
  const declaredPcm = makePcm16({ samples: 1000 });
  const declaredWav = pcmToWav(declaredPcm, { sampleRate: 8000, channels: 2, bitDepth: 16 });
  assert.deepEqual(readWavFormat(declaredWav), { sampleRate: 8000, channels: 2, bitDepth: 16 });

  // Size fields are exact for every length tested above, not merely "close enough".
  for (const length of byteLengths) {
    const testPcm = length === 0 ? Buffer.alloc(0) : makePcm16({ samples: length / 2 });
    const testWav = pcmToWav(testPcm);
    assert.equal(testWav.readUInt32LE(40), testPcm.length, `data size field at ${length} pcm bytes`);
    assert.equal(testWav.readUInt32LE(4), 36 + testPcm.length, `RIFF size field at ${length} pcm bytes`);
  }
});
