import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withTempDir } from '../lifecycle/tempfiles.js';
import { composeAbortSignals } from '../lifecycle/abort-signals.js';
import { getBackendStatus, BACKEND_UP } from '../health/backend-health-cache.js';
import { probeHttpService } from '../health/probes.js';

// WR-02: re-exported so existing callers/tests that import composeAbortSignals from this
// module keep working unchanged — the real implementation now lives in
// ../lifecycle/abort-signals.js, which imports nothing, so probes.js and this module no
// longer import from each other.
export { composeAbortSignals };

const execFileAsync = promisify(execFile);

// WR-06: the one source of truth for this precedence chain
// (ttsConfig.serviceUrl -> KOKORO_TTS_URL env -> the fixed local default). Exported so
// request-handler.js's health route and preflight.js's startup probe can import it instead
// of each hand-maintaining their own copy — three independent copies meant a future change
// to this precedence only had to be forgotten in one of them for health/preflight to
// silently disagree with what this adapter actually calls.
//
// WR-03: mirrors resolveKokoroSpeed's refuse-or-honour contract below — only `undefined`
// means "not configured" and falls through to the env var / default. A configured
// `serviceUrl` of '' (or any other non-string) is refused by name rather than silently
// discarded through a truthiness fallback, the same silent-misconfiguration class DEBT-04
// closed for tts.speed.
export function getKokoroServiceUrl(ttsConfig = {}) {
  const configured = ttsConfig.serviceUrl;
  if (configured === undefined) {
    return process.env.KOKORO_TTS_URL || 'http://127.0.0.1:4319';
  }
  if (typeof configured === 'string' && configured !== '') {
    return configured;
  }
  throw new Error(`tts.serviceUrl must be a non-empty string when configured; got ${JSON.stringify(configured)}`);
}

// DEBT-04: a configured speed is either honoured unchanged or refused by name — never
// silently coerced through a truthiness fallback, which let a configured 0 become 1.0 with
// no diagnostic. This resolver is exported beside getKokoroServiceUrl and
// composeAbortSignals — already exported for the same reason — so tests can drive it
// directly without a live network call. The truncation below follows the bounded-echo
// discipline error-response.js's renderRequestedFormatLabel established for a
// caller-supplied identifier: the value here is operator-supplied config rather than
// request-supplied, but an unbounded configured string interpolated into a message that
// reaches a log is the same reflector hazard.
const MAX_ECHOED_SPEED_LENGTH = 200;

export const DEFAULT_KOKORO_SPEED = 1.0;

function renderRejectedSpeed(value) {
  const text = String(value);
  if (text.length > MAX_ECHOED_SPEED_LENGTH) {
    return `${text.slice(0, MAX_ECHOED_SPEED_LENGTH)}...`;
  }
  return text;
}

export function resolveKokoroSpeed(ttsConfig) {
  const speed = ttsConfig?.speed;
  if (speed === undefined) {
    return DEFAULT_KOKORO_SPEED;
  }
  if (typeof speed === 'number' && Number.isFinite(speed) && speed > 0) {
    return speed;
  }
  throw new Error(`tts.speed must be a finite number greater than 0; got ${renderRejectedSpeed(speed)}`);
}

/**
 * Generate speech via the persistent Kokoro FastAPI service.
 */
async function speakWithFastApi(text, ttsConfig, { signal } = {}) {
  const voice = ttsConfig.voice || 'af_heart';
  const speed = resolveKokoroSpeed(ttsConfig);
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

  // The service's own response body is already a WAV — returned as-is (FMT-02). No temp
  // directory, no afconvert subprocess: this is now a net removal of a child process from
  // the warm speech path, since the m4a conversion this used to do here is gone entirely.
  const wavBuffer = Buffer.from(await res.arrayBuffer());

  return {
    audioBuffer: wavBuffer,
    mimeType: 'audio/wav',
    meta: { voice, speed, method: 'fastapi', serviceUrl },
  };
}

/**
 * Fallback: spawn Python process (original behavior).
 */
async function speakWithKokoroOnnx(text, ttsConfig, { signal } = {}) {
  const command = ttsConfig.command || 'tts-kokoro';
  const voice = ttsConfig.voice || 'af_heart';

  // WR-04: the spawn fallback's CLI argv (below) has no speed slot at all, so a configured
  // tts.speed is silently dropped whenever this path is taken — unlike speakWithFastApi,
  // which honours it. This is the only diagnostic an operator gets when that happens.
  if (ttsConfig.speed !== undefined && ttsConfig.speed !== DEFAULT_KOKORO_SPEED) {
    console.error(
      '[voice-bridge] tts.speed is configured but the spawn-based Kokoro fallback does not support it; ignoring',
    );
  }

  // Wrapped in withTempDir so this directory is guaranteed removed on success, on the
  // command's non-zero exit, on a timeout, and on an abort. This is now the only reply path
  // in this module that creates a temp directory at all — the FastAPI path above needs none.
  return withTempDir('voice-bridge-kokoro-', async (tmpDir) => {
    const wavPath = path.join(tmpDir, 'reply.wav');

    // Array-form argv, no shell — same caveat as every other execFileAsync call site in this
    // codebase: forwarding signal terminates this child directly on abort. The command
    // already writes a WAV to wavPath (FMT-02) — no conversion needed.
    await execFileAsync(command, [text, wavPath, voice], { timeout: 120000, maxBuffer: 10 * 1024 * 1024, signal });
    const audioBuffer = fs.readFileSync(wavPath);

    return {
      audioBuffer,
      mimeType: 'audio/wav',
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
  // DEBT-04: refused here, before the health probe writes a verdict into the shared cache
  // window and before the spawn fallback (which ignores speed entirely) could be reached —
  // making the refusal path-independent regardless of which reply path this turn would
  // otherwise have taken. Placed after the first abort check above so an already-aborted
  // caller still wins over a misconfigured speed.
  resolveKokoroSpeed(ttsConfig);
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
