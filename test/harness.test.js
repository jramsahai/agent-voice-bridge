import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makePcm16,
  makeCanonicalWav,
  makeWavWithFillerChunk,
  makeStereoWav,
  makeMalformedWav,
} from './helpers/fixtures.js';

test('makePcm16 returns samples * 2 bytes', () => {
  const pcm = makePcm16({ samples: 16000 });
  assert.equal(pcm.length, 32000);
  const short = makePcm16({ samples: 1 });
  assert.equal(short.length, 2);
});

test('makePcm16 is deterministic across calls with identical arguments', () => {
  const a = makePcm16({ samples: 4000, sampleRate: 16000 });
  const b = makePcm16({ samples: 4000, sampleRate: 16000 });
  assert.deepEqual(a, b);
});

test('makeCanonicalWav emits RIFF/WAVE/fmt /data tags at canonical offsets', () => {
  const pcm = makePcm16({ samples: 100 });
  const wav = makeCanonicalWav({ pcm });
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, 44 + pcm.length);
});

test('makeCanonicalWav is deterministic across calls with identical arguments', () => {
  const pcm = makePcm16({ samples: 100 });
  const a = makeCanonicalWav({ pcm });
  const b = makeCanonicalWav({ pcm });
  assert.deepEqual(a, b);
});

test('makeWavWithFillerChunk places data payload after 44 + fillerBytes + 8, not at 44', () => {
  const pcm = makePcm16({ samples: 50 });
  const fillerBytes = 4044;
  const wav = makeWavWithFillerChunk({ pcm, fillerBytes });
  const expectedDataTagOffset = 12 + (8 + 16) + (8 + fillerBytes);
  assert.equal(wav.toString('ascii', expectedDataTagOffset, expectedDataTagOffset + 4), 'data');
  assert.notEqual(wav.toString('ascii', 44, 48), 'data');
  const payloadOffset = expectedDataTagOffset + 8;
  assert.deepEqual(wav.subarray(payloadOffset, payloadOffset + pcm.length), pcm);
});

test('makeStereoWav produces a 2-channel canonical WAV', () => {
  const pcm = makePcm16({ samples: 100 });
  const wav = makeStereoWav({ pcm });
  assert.equal(wav.readUInt16LE(22), 2);
});

test('makeMalformedWav returns a distinct buffer for each kind', () => {
  const kinds = ['no-data-chunk', 'truncated-header', 'zero-size-chunk', 'size-beyond-buffer'];
  const buffers = kinds.map((kind) => makeMalformedWav(kind));
  for (let i = 0; i < buffers.length; i++) {
    for (let j = i + 1; j < buffers.length; j++) {
      assert.notDeepEqual(buffers[i], buffers[j], `${kinds[i]} vs ${kinds[j]} should differ`);
    }
  }
});
