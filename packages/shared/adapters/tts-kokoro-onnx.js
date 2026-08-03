import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withTempDir } from '../lifecycle/tempfiles.js';

const execFileAsync = promisify(execFile);

function getKokoroServiceUrl(ttsConfig = {}) {
  return ttsConfig.serviceUrl || process.env.KOKORO_TTS_URL || 'http://127.0.0.1:4319';
}

// Composes any number of possibly-undefined AbortSignals into one that aborts when any of
// them does, using the standard library's own composition rather than hand-rolled listener
// bookkeeping. A caller's signal must never simply replace an existing timeout-derived
// signal here — dropping the timeout would turn a downed speech backend from a fast failure
// into a hang, the fixed per-turn penalty OPS-05 exists to remove in Phase 3. Exported so the
// abort-threading test can verify composed behavior directly, without a live network call.
export function composeAbortSignals(...signals) {
  const present = signals.filter(Boolean);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/**
 * Check if the Kokoro FastAPI service is available.
 */
async function isFastApiAvailable(serviceUrl, { signal } = {}) {
  try {
    const res = await fetch(`${serviceUrl}/health`, {
      signal: composeAbortSignals(signal, AbortSignal.timeout(2000)),
    });
    return res.ok;
  } catch (err) {
    // A genuinely-down service and the 2-second health timeout both collapse to "not
    // available" — the caller falls through to the heavier spawn path either way. The
    // caller's own turn-level abort is different: it must propagate so speakWithKokoroFast's
    // caller (runStage in turn-pipeline.js) can normalize it to TurnAbortedError, instead of
    // this probe silently reporting "down" and speakWithKokoroFast spawning a whole new
    // temp directory and child process for a caller that has already vanished.
    if (signal?.aborted) throw err;
    return false;
  }
}

/**
 * Generate speech via the persistent Kokoro FastAPI service.
 */
async function speakWithFastApi(text, ttsConfig, { signal } = {}) {
  const voice = ttsConfig.voice || 'af_heart';
  const speed = ttsConfig.speed || 1.0;
  const serviceUrl = getKokoroServiceUrl(ttsConfig);

  const res = await fetch(`${serviceUrl}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed, lang: 'en-us' }),
    signal: composeAbortSignals(signal, AbortSignal.timeout(120000)),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kokoro FastAPI error ${res.status}: ${err}`);
  }

  const wavBuffer = Buffer.from(await res.arrayBuffer());

  // Convert WAV to M4A for smaller payload. Wrapped in withTempDir so this directory is
  // guaranteed removed on success, on a non-zero afconvert exit, on a timeout, and on an
  // abort — previously created via a bare mkdtempSync with no cleanup path at all.
  return withTempDir('voice-bridge-kokoro-', async (tmpDir) => {
    const wavPath = path.join(tmpDir, 'reply.wav');
    const m4aPath = path.join(tmpDir, 'reply.m4a');
    fs.writeFileSync(wavPath, wavBuffer);
    // Array-form argv, no shell — same caveat as every other execFileAsync call site in this
    // codebase: forwarding signal terminates this child directly on abort.
    await execFileAsync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', wavPath, m4aPath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    const audioBuffer = fs.readFileSync(m4aPath);

    return {
      audioBuffer,
      mimeType: 'audio/mp4',
      meta: { voice, speed, method: 'fastapi', serviceUrl },
    };
  });
}

/**
 * Fallback: spawn Python process (original behavior).
 */
async function speakWithKokoroOnnx(text, ttsConfig, { signal } = {}) {
  const command = ttsConfig.command || 'tts-kokoro';
  const voice = ttsConfig.voice || 'af_heart';

  // Wrapped in withTempDir so this directory is guaranteed removed on success, on either
  // child's non-zero exit, on a timeout, and on an abort.
  return withTempDir('voice-bridge-kokoro-', async (tmpDir) => {
    const wavPath = path.join(tmpDir, 'reply.wav');
    const m4aPath = path.join(tmpDir, 'reply.m4a');

    // Array-form argv, no shell — same caveat as every other execFileAsync call site in this
    // codebase: forwarding signal terminates this child directly on abort.
    await execFileAsync(command, [text, wavPath, voice], { timeout: 120000, maxBuffer: 10 * 1024 * 1024, signal });
    await execFileAsync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', wavPath, m4aPath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    const audioBuffer = fs.readFileSync(m4aPath);

    return {
      audioBuffer,
      mimeType: 'audio/mp4',
      meta: { voice, command, method: 'spawn' },
    };
  });
}

export async function speakWithKokoroFast(text, ttsConfig, { signal } = {}) {
  // Prefer FastAPI if available, fall back to spawn
  const serviceUrl = getKokoroServiceUrl(ttsConfig);
  const fastApiUp = await isFastApiAvailable(serviceUrl, { signal });
  if (fastApiUp) {
    return speakWithFastApi(text, ttsConfig, { signal });
  }
  return speakWithKokoroOnnx(text, ttsConfig, { signal });
}
