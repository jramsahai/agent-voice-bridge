// Hermes Agent (Nous Research) adapter: one non-interactive `hermes chat` invocation per
// turn. Written from the published CLI reference, not against a running install — see the
// README's agent-provider table for what has and has not been exercised.
//
// The argument shape: `chat -Q --oneshot -q <text>` answers the query and exits with the
// banner, spinner and tool previews suppressed, so stdout is the reply. When a sessionId is
// configured it is passed as `--resume <sessionId>`, which Hermes resolves by id or title;
// that session must already exist. `agent.args` replaces the fixed prefix (everything before
// `-q`) for a Hermes version whose flags differ.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AGENT_TIMEOUT_MS } from './stage-timeouts.js';
import { primeSessionOnce } from './agent-session.js';
import { cleanTextForSpeech } from './speech-clean.js';

const execFileAsync = promisify(execFile);
const LABEL = 'hermes-cli';

export const DEFAULT_HERMES_ARGS = ['chat', '-Q', '--oneshot'];

export function getHermesCommand(agentConfig = {}) {
  return agentConfig.command || process.env.HERMES_BIN || 'hermes';
}

export function buildHermesArgs(message, agentConfig = {}) {
  const prefix = Array.isArray(agentConfig.args) ? agentConfig.args : DEFAULT_HERMES_ARGS;
  const args = [...prefix, '-q', message];
  if (agentConfig.sessionId) {
    args.push('--resume', agentConfig.sessionId);
  }
  return args;
}

async function runHermesAgent(message, agentConfig, { signal } = {}) {
  const command = getHermesCommand(agentConfig);
  const args = buildHermesArgs(message, agentConfig);

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(command, args, {
      timeout: AGENT_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    }));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Hermes CLI not found at "${command}". Set agent.command in config/config.local.json to an absolute path, or set HERMES_BIN.`
      );
    }
    throw error;
  }

  return { rawReply: stdout.trim(), stderr: stderr?.trim() || '', command, args };
}

export async function sendTurnToHermes(text, agentConfig, { signal } = {}) {
  if (!text || !text.trim()) {
    throw new Error('Hermes handoff requires non-empty text');
  }

  await primeSessionOnce(agentConfig, (message) => runHermesAgent(message, agentConfig, { signal }), LABEL);

  const result = await runHermesAgent(text.trim(), agentConfig, { signal });

  return {
    text: cleanTextForSpeech(result.rawReply),
    rawText: result.rawReply,
    meta: { stderr: result.stderr, command: result.command, args: result.args },
  };
}
