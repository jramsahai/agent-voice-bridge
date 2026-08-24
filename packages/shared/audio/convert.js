// Format-aware entry points both directions. This is the one call site that turns a
// wire format id into a decision — every other module answers to the registry row's
// data (headerless, sampleRate, channels, bitDepth, mimeType), never to the id string
// itself. That distinction is what keeps FMT-07 a one-row registry change.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AUDIO_FORMATS, lookupFormat } from './format-registry.js';
import { buildError, unsupportedFormatError } from '../errors/error-response.js';
import { ERROR_CODES } from '../errors/error-codes.js';
import { pcmToWav, wavToPcm, readWavFormat, assertContainerInputSize } from './wav.js';

const execFileAsync = promisify(execFile);

// The one registry row that is headerless is, by construction (see format-registry.js),
// the shape whisper transcription is done against — found structurally, the same way
// resolveWhisperConversionRecipe() below finds the container row, so this constant can
// never drift from the registry's own numbers and this file never contains a registered
// format id as a quoted literal (test/format-registry.test.js's one-row-change scan).
function resolveDefaultHeaderlessFormat() {
  const row = Object.values(AUDIO_FORMATS).find((entry) => entry.headerless);
  if (!row) {
    throw new Error('convert.js: no registry row is headerless; cannot derive WHISPER_INPUT');
  }
  return row;
}

const defaultHeaderlessFormat = resolveDefaultHeaderlessFormat();
export const WHISPER_INPUT = Object.freeze({
  sampleRate: defaultHeaderlessFormat.sampleRate,
  channels: defaultHeaderlessFormat.channels,
  bitDepth: defaultHeaderlessFormat.bitDepth,
});

// Injectable per D-08 so plan 01-05 has the seam and no exported signature moves.
export const DEFAULT_AFCONVERT_BIN = '/usr/bin/afconvert';

// Stable prefix for every temp directory this module creates. Read by test/convert.test.js
// via a source-text regex (not exported) so the hygiene assertions there can never drift
// from the real value — same pattern test/error-response.test.js uses for
// MAX_ECHOED_IDENTIFIER_LENGTH.
const TEMP_DIR_PREFIX = 'voice-bridge-convert-';

// Matches the timeout/maxBuffer values already established for afconvert calls elsewhere
// in this codebase (packages/shared/adapters/tts-kokoro-onnx.js), overridable per call so
// tests can drive the failure paths without waiting out a two-minute timeout.
const DEFAULT_AFCONVERT_TIMEOUT_MS = 120000;
const DEFAULT_AFCONVERT_MAX_BUFFER = 10 * 1024 * 1024;

function resolveAfconvertBin(options = {}) {
  return options.afconvertBin || process.env.AFCONVERT_BIN || DEFAULT_AFCONVERT_BIN;
}

// The one registry row that carries non-null afconvert tokens is, by construction (see
// format-registry.js), the recipe for turning an arbitrary WAV into whisper-ready audio.
// Found structurally rather than by a hardcoded wire id — this file must never contain a
// registered format id as a quoted literal (test/format-registry.test.js's one-row-change
// scan enforces that). DEBT-06: adding a second afconvert-carrying row now stops this lookup
// with a named error rather than silently taking the first — a maintainer adding such a row
// must decide explicitly which row is the whisper recipe. `registry` defaults to AUDIO_FORMATS
// and is the only seam that makes the ambiguous case reachable from a test against a frozen
// registry.
export function resolveWhisperConversionRecipe(registry = AUDIO_FORMATS) {
  const matches = Object.entries(registry).filter(([, entry]) => entry.afconvertDataFormat != null);
  if (matches.length === 0) {
    throw new Error(
      'convert.js: no registry row supplies the afconvert tokens needed to reach whisper-ready audio',
    );
  }
  if (matches.length > 1) {
    const ids = matches.map(([id]) => id).join(', ');
    throw new Error(
      `convert.js: registry supplies more than one afconvert recipe (${ids}) — a maintainer must decide which row is the whisper recipe`,
    );
  }
  return matches[0][1];
}

function matchesTarget(sourceFormat, target) {
  return (
    sourceFormat.sampleRate === target.sampleRate &&
    sourceFormat.channels === target.channels &&
    sourceFormat.bitDepth === target.bitDepth
  );
}

// This module's throw-vs-resolve split is a documented, load-bearing contract, not an
// accident: an unrecognized format id resolves to `{ error }` (buildError/
// unsupportedFormatError), because the wire id itself is untrusted input this module is
// meant to validate. A malformed or oversized *buffer* (AUDIO_MALFORMED/AUDIO_TOO_LARGE,
// thrown by wav.js) is left to propagate as a raw Error instead — callers that already
// `try/catch` around the whole turn (the server's request handler) see it there. Every
// future caller that needs the same `{ error }` shape for a caught wav.js error should
// route it through this helper rather than re-deriving the code -> envelope mapping.
export function toErrorEnvelope(err) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  if (code && code in ERROR_CODES) {
    return buildError(code, ERROR_CODES[code].title);
  }
  throw err;
}

// Shared by both directions: resamples an arbitrary WAV buffer down to a target shape (16
// kHz mono 16-bit by default — WHISPER_INPUT) via a real afconvert subprocess. Every temp
// path this function creates is removed before it returns, on success, on a non-zero exit,
// on a timeout, and on a throw from anywhere in between — it owns cleanup of its own
// directory only.
//
// `options.target` lets a caller resample to a shape other than WHISPER_INPUT — e.g.
// prepareClientOutput() below passes the *requested* headerless format's own shape, so a
// future second headerless row with a different rate/channels/bitDepth than WHISPER_INPUT
// is resampled correctly instead of silently reusing whisper's target (see REVIEW.md
// WR-02). The afconvert `-d`/`-c` tokens are built from `target`, not from the recipe row's
// own fixed tokens, so this stays correct for any registered shape.
export async function convertWavToWhisperWav(wavBuffer, options = {}) {
  const recipe = resolveWhisperConversionRecipe();
  const target = options.target ?? WHISPER_INPUT;
  const bin = resolveAfconvertBin(options);
  const timeout = options.timeoutMs ?? DEFAULT_AFCONVERT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_AFCONVERT_MAX_BUFFER;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  try {
    const stem = randomUUID();
    const inputPath = path.join(tmpDir, `${stem}-in.${recipe.extension}`);
    const outputPath = path.join(tmpDir, `${stem}-out.${recipe.extension}`);
    fs.writeFileSync(inputPath, wavBuffer);

    // Array-form execFile only — never a shell string. The file-format flag comes from the
    // registry row; the data-format/channel flags are derived from `target` (registry-driven
    // on every real call site) rather than the recipe's own fixed tokens — never from
    // request data either way.
    const argv = [
      '-f',
      recipe.afconvertFileFormat,
      '-d',
      `LEI${target.bitDepth}@${target.sampleRate}`,
      '-c',
      String(target.channels),
      inputPath,
      outputPath,
    ];

    try {
      await execFileAsync(bin, argv, { timeout, maxBuffer });
      const wavOut = fs.readFileSync(outputPath);
      return { wavBuffer: wavOut };
    } catch (err) {
      // The caught error's message, stderr, stdout, the binary path, and the temp path
      // must never reach the client — only the catalogue's fixed title does. They are,
      // however, logged server-side (stderr, per this codebase's console.error convention)
      // so a non-zero exit, a missing binary, a timeout, and an unrelated fs error are
      // distinguishable to an operator instead of all collapsing into the same silent
      // outcome.
      console.error('[voice-bridge] afconvert conversion failed', err);
      return {
        error: buildError('AUDIO_CONVERSION_FAILED', ERROR_CODES.AUDIO_CONVERSION_FAILED.title),
      };
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Throw-vs-resolve contract (see toErrorEnvelope above): an unsupported declaredFormatId
// resolves to `{ error }`. A malformed or oversized audioBuffer throws a raw Error with a
// `.code` of AUDIO_MALFORMED/AUDIO_TOO_LARGE instead — callers must either await this from
// within a try/catch, or pass the caught error through toErrorEnvelope() themselves.
export async function prepareTranscriptionInput(audioBuffer, declaredFormatId, options = {}) {
  const entry = lookupFormat(declaredFormatId);
  if (!entry) {
    return { error: unsupportedFormatError(declaredFormatId) };
  }
  if (entry.headerless) {
    // DEBT-01: a non-Buffer audioBuffer is refused inside pcmToWav() with an AUDIO_MALFORMED
    // Error shape-identical to the container branch's readWavFormat() rejection below — not a
    // raw TypeError — so no caller of this branch can bypass the guard.
    const wavBuffer = pcmToWav(audioBuffer, entry);
    return {
      wavBuffer,
      meta: { formatId: declaredFormatId, converted: false, spawned: false },
    };
  }

  // Container format: DEBT-05 — the size ceiling is checked before the fmt chunk is read and
  // before any temp directory is created, so an oversize buffer never reaches readWavFormat at
  // all. Then read the source's own fmt chunk (throws AUDIO_MALFORMED for a buffer that isn't
  // a valid WAV at all — still before any temp directory is ever created) and only pay for the
  // afconvert subprocess if the source doesn't already match what transcription needs.
  assertContainerInputSize(audioBuffer);
  const sourceFormat = readWavFormat(audioBuffer);
  if (matchesTarget(sourceFormat, WHISPER_INPUT)) {
    return {
      wavBuffer: audioBuffer,
      meta: { formatId: declaredFormatId, converted: false, spawned: false },
    };
  }

  const result = await convertWavToWhisperWav(audioBuffer, options);
  if (result.error) {
    return result;
  }
  return {
    wavBuffer: result.wavBuffer,
    meta: { formatId: declaredFormatId, converted: true, spawned: true },
  };
}

// Same throw-vs-resolve contract as prepareTranscriptionInput above: an unsupported
// requestedFormatId resolves to `{ error }` — as does a *registered* but container-format
// requestedFormatId, which is out of scope for this direction (see WR-04) — while a
// malformed replyWavBuffer throws.
export async function prepareClientOutput(replyWavBuffer, requestedFormatId, options = {}) {
  const entry = lookupFormat(requestedFormatId);
  if (!entry) {
    return { error: unsupportedFormatError(requestedFormatId) };
  }
  if (entry.headerless) {
    // The requested headerless format's own declared shape is the target — for pcm16 this
    // is numerically the same as WHISPER_INPUT, but the comparison stays registry-driven
    // (entry.sampleRate/channels/bitDepth) rather than hardcoded to that constant.
    const target = { sampleRate: entry.sampleRate, channels: entry.channels, bitDepth: entry.bitDepth };
    const sourceFormat = readWavFormat(replyWavBuffer);

    let wavToStrip = replyWavBuffer;
    let converted = false;
    let spawned = false;

    if (!matchesTarget(sourceFormat, target)) {
      // Pass `target` explicitly — this branch resamples to the *requested* headerless
      // format's own shape, not implicitly to WHISPER_INPUT (see WR-02: the two are only
      // numerically equal today because pcm16 is the sole registered headerless row).
      const result = await convertWavToWhisperWav(replyWavBuffer, { ...options, target });
      if (result.error) {
        return result;
      }
      wavToStrip = result.wavBuffer;
      converted = true;
      spawned = true;
    }

    // Chunk-walking strip, never a fixed offset — the source may be this service's own
    // canonical WAV, or afconvert output with a filler chunk ahead of 'data'. wavToPcm()
    // returns a view over wavToStrip's own memory, not a copy (see its doc comment in
    // wav.js) — callers of prepareClientOutput must not mutate this buffer in place.
    const buffer = wavToPcm(wavToStrip);
    return {
      buffer,
      mimeType: entry.mimeType,
      meta: { formatId: requestedFormatId, converted, spawned },
    };
  }

  // Container-format output requests (returning a WAV rather than headerless PCM) are not
  // exercised by any client this milestone ships — the codec-free promise is the only
  // output path this phase's requirements (FMT-04) cover. `requestedFormatId` is a
  // *registered* id here (it passed lookupFormat above), so this is out-of-scope-for-this-
  // direction input, not a programmer error — resolved the same way every other rejection
  // path in this module is, rather than thrown (see WR-04).
  return {
    error: buildError(
      'FMT_UNSUPPORTED',
      `Requested reply format '${requestedFormatId}' is not available as a reply format.`,
    ),
  };
}
