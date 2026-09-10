// OpenClaw agent adapter: one `openclaw agent --json` invocation per turn against a
// dedicated session, primed once with voice-mode instructions.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AGENT_TIMEOUT_MS } from './stage-timeouts.js';
import { primeSessionOnce, resetPrimedSessionCache } from './agent-session.js';
import { cleanTextForSpeech } from './speech-clean.js';

// Re-exported for callers and tests that reached these through this module historically.
export { cleanTextForSpeech, resetPrimedSessionCache };

const execFileAsync = promisify(execFile);
const LABEL = 'openclaw-cli';

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

export function getOpenClawCommand(agentConfig = {}) {
  return agentConfig.command || process.env.OPENCLAW_BIN || 'openclaw';
}

async function runOpenClawAgent(message, agentConfig, { signal } = {}) {
  const command = getOpenClawCommand(agentConfig);
  const args = ['agent', '--message', message, '--json'];

  if (agentConfig.sessionId) {
    args.push('--session-id', agentConfig.sessionId);
  } else if (agentConfig.to) {
    args.push('--to', agentConfig.to);
  }

  if (agentConfig.thinking) {
    args.push('--thinking', agentConfig.thinking);
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
        `OpenClaw CLI not found at "${command}". Set agent.command in config/config.local.json to an absolute path, or set OPENCLAW_BIN.`
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

export async function sendTurnToOpenClaw(text, agentConfig, { signal } = {}) {
  if (!text || !text.trim()) {
    throw new Error('OpenClaw handoff requires non-empty text');
  }

  await primeSessionOnce(agentConfig, (message) => runOpenClawAgent(message, agentConfig, { signal }), LABEL);

  const result = await runOpenClawAgent(text.trim(), agentConfig, { signal });

  return {
    text: cleanTextForSpeech(result.rawReply),
    rawText: result.rawReply,
    meta: {
      stderr: result.stderr,
      command: result.command,
      args: result.args
    }
  };
}
