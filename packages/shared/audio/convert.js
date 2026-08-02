// Format-aware entry points both directions. This is the one call site that turns a
// wire format id into a decision — every other module answers to the registry row's
// data (headerless, sampleRate, channels, bitDepth, mimeType), never to the id string
// itself. That distinction is what keeps FMT-07 a one-row registry change.

import { lookupFormat } from './format-registry.js';
import { unsupportedFormatError } from '../errors/error-response.js';
import { pcmToWav } from './wav.js';

export const WHISPER_INPUT = Object.freeze({ sampleRate: 16000, channels: 1, bitDepth: 16 });

// Injectable per D-08 so plan 01-05 has the seam and no exported signature moves.
export const DEFAULT_AFCONVERT_BIN = '/usr/bin/afconvert';

export async function prepareTranscriptionInput(audioBuffer, declaredFormatId, options = {}) {
  void options;
  const entry = lookupFormat(declaredFormatId);
  if (!entry) {
    return { error: unsupportedFormatError(declaredFormatId) };
  }
  if (entry.headerless) {
    const wavBuffer = pcmToWav(audioBuffer, entry);
    return {
      wavBuffer,
      meta: { formatId: declaredFormatId, converted: false, spawned: false },
    };
  }
  // Container formats (WAV resample via afconvert) are plan 01-05's addition — this
  // branch exists now so no signature here changes when that plan fills it in.
  throw new Error(
    `prepareTranscriptionInput: container format '${declaredFormatId}' conversion is not yet implemented (see plan 01-05)`,
  );
}

export async function prepareClientOutput(replyWavBuffer, requestedFormatId, options = {}) {
  void options;
  const entry = lookupFormat(requestedFormatId);
  if (!entry) {
    return { error: unsupportedFormatError(requestedFormatId) };
  }
  if (entry.headerless) {
    // Canonical 44-byte offset only — this path is fed by the service's own
    // pcmToWav() output. A chunk-walking reader for arbitrary WAVs is plan 01-02's job.
    const buffer = replyWavBuffer.subarray(44);
    return {
      buffer,
      mimeType: entry.mimeType,
      meta: { formatId: requestedFormatId, converted: false, spawned: false },
    };
  }
  throw new Error(
    `prepareClientOutput: container format '${requestedFormatId}' conversion is not yet implemented (see plan 01-05)`,
  );
}
