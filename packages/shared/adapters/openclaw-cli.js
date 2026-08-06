import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { AGENT_TIMEOUT_MS } from './stage-timeouts.js';

const execFileAsync = promisify(execFile);
const voiceSessionStateDir = path.join(os.tmpdir(), 'openclaw-voice-bridge-session-state');

function extractReply(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    // IN-01 (06-REVIEW.md): explicit != null checks, not ||, so a genuinely empty string in
    // the primary field is preserved rather than treated the same as an absent field and
    // falling through to the next candidate.
    const candidates = [parsed?.result?.payloads?.[0]?.text, parsed?.reply, parsed?.message, parsed?.text];
    for (const candidate of candidates) {
      if (candidate != null) return candidate;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

function cleanTextForSpeech(text) {
  let cleaned = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^-+\s+/gm, ' ')
    .replace(/^\d+\.\s+/gm, ' ')
    .replace(/^\[\s*[xX]\s*\]\s+/gm, ' ')
    .replace(/^\[\s*\]\s+/gm, ' ')
    .replace(/[→\-•✓✔]/g, ' ')
    .replace(/:\s*$/gm, ' ')
    .replace(/:\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();

  return cleaned;
}

function getVoiceInstructions(openclawConfig) {
  return (
    openclawConfig.voiceInstructions ||
    'This session is for voice conversations. Respond briefly, conversationally, and in plain spoken sentences. Avoid markdown, headings, bullets, numbered lists, and code-style formatting unless the user explicitly asks for them.'
  );
}

// Today the sole caller in the call graph (turn-pipeline.js's runTurn, via
// sendTurnToOpenClaw) already validates the identical openclawConfig.sessionId value (no
// path separators, not '.'/'..') before this module is ever reached. That upstream guard is
// not load-bearing at the point where these functions actually touch the filesystem — a
// future caller that reaches sendTurnToOpenClaw directly (a script, a different transport)
// would otherwise be able to pass a sessionId like '../../../../tmp/pwned' straight into a
// real fs write. Validating independently here, the same way turn-lock.js's
// assertValidSessionId does, makes that safe regardless of what any caller already checked
// (WR-02).
function assertValidSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('openclaw-cli: sessionId must be a non-empty string');
  }
  if (sessionId.includes(path.sep) || sessionId.includes('/')) {
    throw new Error('openclaw-cli: sessionId must not contain a path separator');
  }
  if (sessionId === '.' || sessionId === '..') {
    throw new Error('openclaw-cli: sessionId must not be "." or ".."');
  }
}

function getSessionStatePath(sessionId) {
  assertValidSessionId(sessionId);
  return path.join(voiceSessionStateDir, `${sessionId}.json`);
}

function hasSessionBeenPrimed(sessionId) {
  if (!sessionId) return false;
  try {
    return fs.existsSync(getSessionStatePath(sessionId));
  } catch {
    return false;
  }
}

function markSessionPrimed(sessionId) {
  if (!sessionId) return;
  fs.mkdirSync(voiceSessionStateDir, { recursive: true });
  fs.writeFileSync(getSessionStatePath(sessionId), JSON.stringify({ primedAt: new Date().toISOString() }), 'utf8');
}

function getOpenClawCommand(openclawConfig) {
  return openclawConfig.command || process.env.OPENCLAW_BIN || 'openclaw';
}

async function runOpenClawAgent(message, openclawConfig, { signal } = {}) {
  const command = getOpenClawCommand(openclawConfig);
  const args = ['agent', '--message', message, '--json'];

  if (openclawConfig.sessionId) {
    args.push('--session-id', openclawConfig.sessionId);
  } else if (openclawConfig.to) {
    args.push('--to', openclawConfig.to);
  }

  if (openclawConfig.thinking) {
    args.push('--thinking', openclawConfig.thinking);
  }

  let stdout;
  let stderr;
  try {
    // Array-form argv, no shell: forwarding signal here means aborting the caller's
    // controller terminates this child directly. A shell-spawned child's own children would
    // not be killed by the same signal — no call in this codebase uses shell: true today.
    ({ stdout, stderr } = await execFileAsync(command, args, {
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    }));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `OpenClaw CLI not found at "${command}". Set openclaw.command in config/config.local.json to an absolute path, or set OPENCLAW_BIN.`
      );
    }
    throw error;
  }

  return {
    rawReply: extractReply(stdout),
    stderr: stderr?.trim() || '',
    command,
    args
  };
}

async function primeVoiceSession(openclawConfig, { signal } = {}) {
  if (!openclawConfig.sessionId || hasSessionBeenPrimed(openclawConfig.sessionId)) {
    return null;
  }

  const primingMessage = `Voice conversation mode instructions: ${getVoiceInstructions(openclawConfig)}`;
  const result = await runOpenClawAgent(primingMessage, openclawConfig, { signal });
  markSessionPrimed(openclawConfig.sessionId);
  return result;
}

export async function sendTurnToOpenClaw(text, openclawConfig, { signal } = {}) {
  if (!text || !text.trim()) {
    throw new Error('OpenClaw handoff requires non-empty text');
  }

  await primeVoiceSession(openclawConfig, { signal });

  const result = await runOpenClawAgent(text.trim(), openclawConfig, { signal });
  const cleanedReply = cleanTextForSpeech(result.rawReply);

  return {
    text: cleanedReply,
    rawText: result.rawReply,
    meta: {
      stderr: result.stderr,
      command: result.command,
      args: result.args
    }
  };
}
