// Session state shared by every agent adapter that keeps a persistent conversation: the
// one-time voice-mode priming marker and the validation that keeps a configured sessionId
// from ever becoming a path component. Lives here rather than in one adapter so a second
// CLI-backed agent gets the identical guard and the identical priming behaviour for free.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Also the turn lock's root (packages/shared/session/turn-lock.js) — one directory holds
// every per-session artifact this service writes.
export const SESSION_STATE_DIR = path.join(os.tmpdir(), 'agent-voice-bridge-session-state');

export const DEFAULT_VOICE_INSTRUCTIONS =
  'This session is for voice conversations. Respond briefly, conversationally, and in plain spoken sentences. Avoid markdown, headings, bullets, numbered lists, and code-style formatting unless the user explicitly asks for them.';

// turn-pipeline.js validates the same value before an adapter is reached, but that guard is
// not load-bearing at the point where these helpers touch the filesystem — a caller that
// reaches an adapter directly (a script, another transport) could otherwise hand a sessionId
// like '../../../../tmp/pwned' straight into a real fs write (WR-02).
export function assertValidSessionId(sessionId, label = 'agent') {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`${label}: sessionId must be a non-empty string`);
  }
  if (sessionId.includes(path.sep) || sessionId.includes('/')) {
    throw new Error(`${label}: sessionId must not contain a path separator`);
  }
  if (sessionId === '.' || sessionId === '..') {
    throw new Error(`${label}: sessionId must not be "." or ".."`);
  }
}

export function getSessionStatePath(sessionId, label) {
  assertValidSessionId(sessionId, label);
  return path.join(SESSION_STATE_DIR, `${sessionId}.json`);
}

// Memoized so a hot session doesn't pay an fs.existsSync stat on every turn — once a
// sessionId is observed primed (on disk or just marked), later turns skip the stat entirely.
const primedSessionCache = new Set();

export function hasSessionBeenPrimed(sessionId, label) {
  if (!sessionId) return false;
  if (primedSessionCache.has(sessionId)) return true;
  try {
    const primed = fs.existsSync(getSessionStatePath(sessionId, label));
    if (primed) primedSessionCache.add(sessionId);
    return primed;
  } catch {
    return false;
  }
}

export function markSessionPrimed(sessionId, label) {
  if (!sessionId) return;
  fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
  fs.writeFileSync(getSessionStatePath(sessionId, label), JSON.stringify({ primedAt: new Date().toISOString() }), 'utf8');
  primedSessionCache.add(sessionId);
}

// Test-only: lets a test suite that reuses the same sessionId across cases clear the
// in-process memoization without needing a fresh process.
export function resetPrimedSessionCache() {
  primedSessionCache.clear();
}

export function getVoiceInstructions(agentConfig = {}) {
  return agentConfig.voiceInstructions || DEFAULT_VOICE_INSTRUCTIONS;
}

// Sends the voice-mode instructions to the configured session exactly once, through the
// adapter's own `run(message)` function, and records that it happened. A session-less
// configuration is stateless by definition and is never primed.
export async function primeSessionOnce(agentConfig, run, label) {
  const sessionId = agentConfig?.sessionId;
  if (!sessionId) return null;
  assertValidSessionId(sessionId, label);
  if (hasSessionBeenPrimed(sessionId, label)) return null;
  const result = await run(`Voice conversation mode instructions: ${getVoiceInstructions(agentConfig)}`);
  markSessionPrimed(sessionId, label);
  return result;
}
