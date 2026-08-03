// Pure, I/O-free HTTP header negotiation for the /v1/turn wire contract (D-03: header
// names carry the registry's short wire ids, never MIME types). This module never
// re-derives format validity itself — it delegates to format-registry.js's lookupFormat()
// and error-response.js's unsupportedFormatError(), the same two modules convert.js already
// consumes, so a format's validity is defined in exactly one place. Resolve-never-throw,
// mirroring error-response.js's own posture: bad or absent input resolves to { error },
// never a thrown exception.

import { AUDIO_FORMATS, lookupFormat } from '../audio/format-registry.js';
import { unsupportedFormatError } from '../errors/error-response.js';

export const INPUT_FORMAT_HEADER = 'X-Voice-Input-Format';
export const OUTPUT_FORMAT_HEADER = 'X-Voice-Output-Format';
export const WANT_AUDIO_HEADER = 'X-Voice-Want-Audio';

// The registry's single headerless row is, by construction (format-registry.js), the
// default output format for a client that declares no preference — found structurally,
// the same way convert.js's resolveDefaultHeaderlessFormat() finds it, so this module never
// hardcodes a registered wire id and FMT-07's one-row-change property survives here too.
export function defaultOutputFormatId() {
  const entry = Object.entries(AUDIO_FORMATS).find(([, row]) => row.headerless);
  if (!entry) {
    throw new Error('negotiate.js: no registry row is headerless; cannot derive a default output format');
  }
  return entry[0];
}

function readHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Reads the lowercase forms of the header-name constants above off a plain Node req.headers
// object and resolves to { inputFormatId, outputFormatId, wantAudio } or, following
// error-response.js's resolve-never-throw posture, to { error } built by
// unsupportedFormatError() from the existing registry. This plan (03-01) only needs the
// happy path proven end to end — a present, registered input format id; an absent output
// format falling back to defaultOutputFormatId(); wantAudio true. Plan 03-02 owns every
// remaining edge (missing/unsupported ids, an explicit want-audio opt-out, etc.).
export function negotiate(headers) {
  const inputFormatId = readHeader(headers, INPUT_FORMAT_HEADER);
  if (!lookupFormat(inputFormatId)) {
    return { error: unsupportedFormatError(inputFormatId) };
  }

  const requestedOutputFormatId = readHeader(headers, OUTPUT_FORMAT_HEADER);
  const outputFormatId = requestedOutputFormatId ?? defaultOutputFormatId();
  if (!lookupFormat(outputFormatId)) {
    return { error: unsupportedFormatError(outputFormatId) };
  }

  const wantAudioHeader = readHeader(headers, WANT_AUDIO_HEADER);
  const wantAudio = wantAudioHeader === undefined ? true : wantAudioHeader !== '0';

  return { inputFormatId, outputFormatId, wantAudio };
}
