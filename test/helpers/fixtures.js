// In-process audio fixture generators. No committed binaries, no model files,
// no dependency on the code under test — these are the oracle other tests are
// checked against.

export function makePcm16({ samples = 16000, sampleRate = 16000 } = {}) {
  void sampleRate; // metadata only — does not change the byte count
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 10000), i * 2);
  }
  return pcm;
}

export function makeCanonicalWav({ pcm, sampleRate = 16000, channels = 1, bitDepth = 16 } = {}) {
  const blockAlign = channels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
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
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function makeWavWithFillerChunk({ pcm, fillerBytes = 4044, fillerId = 'FLLR', sampleRate = 16000, channels = 1, bitDepth = 16 } = {}) {
  const blockAlign = channels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;

  const fmtChunk = Buffer.alloc(8 + 16);
  fmtChunk.write('fmt ', 0, 'ascii');
  fmtChunk.writeUInt32LE(16, 4);
  fmtChunk.writeUInt16LE(1, 8);
  fmtChunk.writeUInt16LE(channels, 10);
  fmtChunk.writeUInt32LE(sampleRate, 12);
  fmtChunk.writeUInt32LE(byteRate, 16);
  fmtChunk.writeUInt16LE(blockAlign, 20);
  fmtChunk.writeUInt16LE(bitDepth, 22);

  const fillerChunk = Buffer.alloc(8 + fillerBytes);
  fillerChunk.write(fillerId, 0, 'ascii');
  fillerChunk.writeUInt32LE(fillerBytes, 4);

  const dataChunk = Buffer.alloc(8 + pcm.length);
  dataChunk.write('data', 0, 'ascii');
  dataChunk.writeUInt32LE(pcm.length, 4);
  pcm.copy(dataChunk, 8);

  const body = Buffer.concat([fmtChunk, fillerChunk, dataChunk]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WAVE', 8, 'ascii');

  return Buffer.concat([header, body]);
}

export function makeStereoWav({ pcm, sampleRate = 44100 } = {}) {
  return makeCanonicalWav({ pcm, sampleRate, channels: 2, bitDepth: 16 });
}

export function makeMalformedWav(kind) {
  switch (kind) {
    case 'no-data-chunk': {
      const fmtChunk = Buffer.alloc(8 + 16);
      fmtChunk.write('fmt ', 0, 'ascii');
      fmtChunk.writeUInt32LE(16, 4);
      fmtChunk.writeUInt16LE(1, 8);
      fmtChunk.writeUInt16LE(1, 10);
      fmtChunk.writeUInt32LE(16000, 12);
      fmtChunk.writeUInt32LE(32000, 16);
      fmtChunk.writeUInt16LE(2, 20);
      fmtChunk.writeUInt16LE(16, 22);
      const header = Buffer.alloc(12);
      header.write('RIFF', 0, 'ascii');
      header.writeUInt32LE(4 + fmtChunk.length, 4);
      header.write('WAVE', 8, 'ascii');
      return Buffer.concat([header, fmtChunk]);
    }
    case 'truncated-header': {
      // Fewer than 12 bytes — not even a complete RIFF/WAVE preamble.
      return Buffer.from('RIFF\x00\x00', 'binary');
    }
    case 'zero-size-chunk': {
      const dataChunk = Buffer.alloc(8);
      dataChunk.write('data', 0, 'ascii');
      dataChunk.writeUInt32LE(0, 4);
      const header = Buffer.alloc(12);
      header.write('RIFF', 0, 'ascii');
      header.writeUInt32LE(4 + dataChunk.length, 4);
      header.write('WAVE', 8, 'ascii');
      return Buffer.concat([header, dataChunk]);
    }
    case 'size-beyond-buffer': {
      const dataChunk = Buffer.alloc(8);
      dataChunk.write('data', 0, 'ascii');
      dataChunk.writeUInt32LE(999999, 4); // claims far more bytes than actually follow
      const header = Buffer.alloc(12);
      header.write('RIFF', 0, 'ascii');
      header.writeUInt32LE(4 + dataChunk.length, 4);
      header.write('WAVE', 8, 'ascii');
      return Buffer.concat([header, dataChunk]);
    }
    default:
      throw new Error(`makeMalformedWav: unknown kind '${kind}'`);
  }
}
