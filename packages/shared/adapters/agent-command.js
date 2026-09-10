// Generic agent adapter: run any command that takes a prompt and prints a reply. The
// escape hatch for an agent CLI this project has no dedicated adapter for.
//
//   agent.command   the executable (absolute path, or a bare name resolved on PATH)
//   agent.args      optional argv; every "{text}" inside an argument is replaced by the
//                   transcript. When no argument carries the placeholder the transcript is
//                   written to the child's stdin instead, terminated by a newline.
//
// Stateless by design: nothing is primed and no session is resumed. The command itself
// owns any conversation memory it wants (a wrapper script can pass a fixed session flag).
// agent.sessionId is still required by the pipeline — it keys the per-session turn lock.

import { execFile } from 'node:child_process';

import { AGENT_TIMEOUT_MS } from './stage-timeouts.js';
import { cleanTextForSpeech } from './speech-clean.js';

export const TEXT_PLACEHOLDER = '{text}';

export function buildCommandArgs(text, agentConfig = {}) {
  const template = Array.isArray(agentConfig.args) ? agentConfig.args : [];
  const args = template.map((arg) => (typeof arg === 'string' ? arg.split(TEXT_PLACEHOLDER).join(text) : String(arg)));
  const usedPlaceholder = template.some((arg) => typeof arg === 'string' && arg.includes(TEXT_PLACEHOLDER));
  return { args, stdin: usedPlaceholder ? null : `${text}\n` };
}

function runCommand(command, args, stdin, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { timeout: AGENT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        if (error) {
          if (error.code === 'ENOENT') {
            reject(new Error(`Agent command not found at "${command}". Set agent.command in config/config.local.json to an absolute path.`));
            return;
          }
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (stdin != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

export async function sendTurnToCommand(text, agentConfig = {}, { signal } = {}) {
  if (!text || !text.trim()) {
    throw new Error('Agent command handoff requires non-empty text');
  }
  const command = agentConfig.command;
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('agent.command must be a non-empty string when agent.provider is command');
  }

  const { args, stdin } = buildCommandArgs(text.trim(), agentConfig);
  const { stdout, stderr } = await runCommand(command, args, stdin, { signal });
  const rawReply = stdout.trim();

  return {
    text: cleanTextForSpeech(rawReply),
    rawText: rawReply,
    meta: { stderr: stderr?.trim() || '', command, args },
  };
}
