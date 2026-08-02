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
  // chunk list it emits; reading an arbitrary WAV (e.g. afconvert output) needs the
  // RIFF chunk walker below instead.
  return Buffer.concat([header, pcmBuffer]);
}

// Cap the walk well beyond any real WAV so a crafted buffer cannot force a long-running loop.
const MAX_CHUNKS = 256;

function malformedError(message) {
  const err = new Error(message);
  err.code = AUDIO_MALFORMED_CODE;
  return err;
}

// Walks every RIFF chunk once, collecting the offset/size of 'fmt ' and 'data' (the two
// chunks a valid WAV always has). findDataChunk() and readWavFormat() share this single
// pass so the hostile-input guards live in one place, not two.
function walkChunks(wavBuffer) {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 12) {
    throw malformedError('WAV buffer is too short to contain a RIFF/WAVE header');
  }
  if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw malformedError('Buffer is not a RIFF/WAVE container');
  }

  const chunks = new Map();
  let offset = 12; // past 'RIFF' + size(4) + 'WAVE'
  let iterations = 0;

  while (offset + 8 <= wavBuffer.length) {
    if (iterations++ >= MAX_CHUNKS) {
      throw malformedError('RIFF chunk walk exceeded the maximum supported chunk count');
    }
    const id = wavBuffer.toString('ascii', offset, offset + 4);
    const size = wavBuffer.readUInt32LE(offset + 4); // unsigned; never wraps negative
    const payloadOffset = offset + 8;
    if (payloadOffset + size > wavBuffer.length) {
      throw malformedError(`Chunk '${id}' declares a size beyond the buffer end`);
    }
    if (!chunks.has(id)) {
      chunks.set(id, { offset: payloadOffset, size });
    }
    if (chunks.has('fmt ') && chunks.has('data')) {
      break;
    }
    const nextOffset = payloadOffset + size + (size % 2); // word-aligned
    if (nextOffset <= offset) {
      throw malformedError(`Chunk '${id}' failed to advance the RIFF walk offset`);
    }
    offset = nextOffset;
  }

  return chunks;
}

export function findDataChunk(wavBuffer) {
  const chunks = walkChunks(wavBuffer);
  if (!chunks.has('fmt ')) {
    throw malformedError('WAV buffer has no fmt chunk');
  }
  const data = chunks.get('data');
  if (!data) {
    throw malformedError('WAV buffer has no data chunk');
  }
  return { offset: data.offset, size: data.size };
}

export function wavToPcm(wavBuffer) {
  const { offset, size } = findDataChunk(wavBuffer);
  return wavBuffer.subarray(offset, offset + size);
}

export function readWavFormat(wavBuffer) {
  const chunks = walkChunks(wavBuffer);
  const fmt = chunks.get('fmt ');
  if (!fmt) {
    throw malformedError('WAV buffer has no fmt chunk');
  }
  return {
    sampleRate: wavBuffer.readUInt32LE(fmt.offset + 4),
    channels: wavBuffer.readUInt16LE(fmt.offset + 2),
    bitDepth: wavBuffer.readUInt16LE(fmt.offset + 14),
  };
}
