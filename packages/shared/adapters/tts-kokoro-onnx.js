import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withTempDir } from '../lifecycle/tempfiles.js';
import { getBackendStatus, BACKEND_UP } from '../health/backend-health-cache.js';
import { probeHttpService } from '../health/probes.js';

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

// Reasserted here because getBackendStatus resolves rather than rejects by contract — it
// swallows every probe failure, including one caused by this call's own signal, into
// BACKEND_DOWN. A caller that has already vanished must not be reported as a down backend
// and then charged for a fallback spawn (WR-03), so this check runs both immediately before
// the cache call (an aborted caller must never write a bogus down verdict into a window
// every other caller shares) and again immediately after (covering a signal that fires
// mid-probe).
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error('The turn was aborted before it could complete.');
  err.name = 'AbortError';
  throw err;
}

export async function speakWithKokoroFast(text, ttsConfig, { signal } = {}) {
  const serviceUrl = getKokoroServiceUrl(ttsConfig);

  throwIfAborted(signal);
  // The single reachability-probe path in the codebase, cached: a downed backend now costs
  // one probe per PROBE_TTL_MS window shared across every caller, not one per turn (OPS-05).
  // A verdict cached from a probe that was cut short by a mid-flight abort self-heals at the
  // end of its own window — the next caller inside a fresh window re-probes for real, so no
  // special case is needed here beyond the recheck below.
  const verdict = await getBackendStatus('speech', () => probeHttpService(serviceUrl, { signal }));
  throwIfAborted(signal);

  if (verdict === BACKEND_UP) {
    return speakWithFastApi(text, ttsConfig, { signal });
  }
  return speakWithKokoroOnnx(text, ttsConfig, { signal });
}
