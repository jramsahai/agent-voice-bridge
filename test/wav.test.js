// Codec-free WAV framing: RIFF chunk walker, headerless PCM extraction, fmt chunk reader.
// Every assertion here targets pure buffer math — no subprocess, no filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

test('findDataChunk finds data regardless of an odd-sized unrecognised chunk (word-alignment pad)', () => {
  const pcm = makePcm16({ samples: 100 });
  const wav = makeWavWithFillerChunk({ pcm, fillerBytes: 4043 });
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
