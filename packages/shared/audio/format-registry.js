// The single place every supported audio format is defined. Adding a format is one
// key added here (FMT-07) — convert.js and error-response.js branch on this row's
// data, never on the wire identifier string itself.

const AUDIO_FORMATS = Object.freeze({
  __proto__: null,
  pcm16: Object.freeze({
    mimeType: 'audio/l16;rate=16000;channels=1',
    extension: 'pcm',
    headerless: true,
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    // Seam for plan 01-04's container format row — filled without moving this shape.
    afconvertFileFormat: null,
    afconvertDataFormat: null,
  }),
});

export { AUDIO_FORMATS };

export function listSupportedFormats() {
  return Object.keys(AUDIO_FORMATS).sort();
}

export function lookupFormat(wireId) {
  if (typeof wireId !== 'string') {
    return undefined;
  }
  if (!Object.hasOwn(AUDIO_FORMATS, wireId)) {
    return undefined;
  }
  return AUDIO_FORMATS[wireId];
}

export function isSupportedFormat(wireId) {
  return lookupFormat(wireId) !== undefined;
}
