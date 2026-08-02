// Codec-free PCM/WAV framing. This module never shells out — it is pure buffer math.

import { ERROR_CODES } from '../errors/error-codes.js';

const AUDIO_TOO_LARGE_CODE = 'AUDIO_TOO_LARGE';
const AUDIO_MALFORMED_CODE = 'AUDIO_MALFORMED';

// Fail loudly at load time if the catalogue and this module ever drift apart, rather
// than throwing a code the catalogue doesn't recognize.
if (!(AUDIO_TOO_LARGE_CODE in ERROR_CODES) || !(AUDIO_MALFORMED_CODE in ERROR_CODES)) {
  throw new Error('wav.js: expected error code missing from the catalogue');
}

export const MAX_PCM_BYTES = 16000 * 2 * 300; // 5 minutes of 16 kHz mono s16le

export function pcmToWav(pcmBuffer, { sampleRate = 16000, channels = 1, bitDepth = 16 } = {}) {
  if (pcmBuffer.length > MAX_PCM_BYTES) {
    const err = new Error('PCM buffer exceeds the maximum allowed size');
    err.code = AUDIO_TOO_LARGE_CODE;
    throw err;
  }
  const blockAlign = channels * (bitDepth / 8);
  if (pcmBuffer.length % blockAlign !== 0) {
    const err = new Error('PCM buffer length is not a whole multiple of the frame size');
    err.code = AUDIO_MALFORMED_CODE;
    throw err;
  }
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmBuffer.length, 40);
  // This fixed 44-byte layout is safe only because this writer controls the exact
  // chunk list it emits; reading an arbitrary WAV (e.g. afconvert output) needs a
  // RIFF chunk walker instead — that walker is plan 01-02's job, not this one's.
  return Buffer.concat([header, pcmBuffer]);
}
