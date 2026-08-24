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
    afconvertChannels: null,
  }),
  // The browser recording format the current client actually sends (blobToWav()
  // decodes MediaRecorder output client-side via Web Audio API before every request).
  // Sample metadata is null — a container's parameters come from its own fmt chunk,
  // not an assumption here. afconvertChannels is a separate field, not folded into
  // afconvertDataFormat, because RESEARCH.md Pitfall 3 verified afconvert's -c flag
  // must be passed explicitly (LEI16@16000 alone leaves a stereo source stereo) — a
  // future consumer builds the argv array from this row's fields alone.
  //
  // webm/opus is deliberately NOT registered here (checkpoint decision, option-a):
  // afconvert has no WebM container support on this host at all (absent from -hf,
  // decode probe rejected with "Couldn't open input file"), and its Ogg container
  // write is broken for every codec tried. FMT-05's "webm/opus" wording is narrowed
  // to the format the browser client actually transmits today (WAV). Adding a webm
  // row later is exactly the one-row change this file's design promises.
  wav: Object.freeze({
    mimeType: 'audio/wav',
    extension: 'wav',
    headerless: false,
    sampleRate: null,
    channels: null,
    bitDepth: null,
    afconvertFileFormat: 'WAVE',
    afconvertDataFormat: 'LEI16@16000',
    afconvertChannels: 1,
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

// IN-01: the one place "the default headerless row" is decided. Previously convert.js's
// resolveDefaultHeaderlessFormat() and negotiate.js's defaultOutputFormatId() each
// independently scanned AUDIO_FORMATS for the first headerless row — the same first-match
// tie-break rule encoded twice, only agreeing today because both iterate the same
// Object.entries order. Both now call this one function instead. Accepts an injectable
// registry (defaulting to AUDIO_FORMATS) purely so a caller's own tests can drive the
// ambiguous/absent-row branches without mutating the real registry, mirroring
// resolveWhisperConversionRecipe()'s existing injectable-registry convention.
export function resolveDefaultHeaderlessFormat(registry = AUDIO_FORMATS) {
  const entry = Object.entries(registry).find(([, row]) => row.headerless);
  if (!entry) {
    throw new Error('format-registry.js: no registry row is headerless; cannot derive a default output format');
  }
  return entry;
}
