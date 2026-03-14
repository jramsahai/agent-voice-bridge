import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function extractReply(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    return parsed.reply || parsed.message || parsed.text || trimmed;
  } catch {
    return trimmed;
  }
}

export async function sendTurnToOpenClaw(text, openclawConfig) {
  const args = ['agent', '--message', text, '--json'];
  if (openclawConfig.sessionId) {
    args.push('--session-id', openclawConfig.sessionId);
  } else if (openclawConfig.to) {
    args.push('--to', openclawConfig.to);
  }
  if (openclawConfig.thinking) {
    args.push('--thinking', openclawConfig.thinking);
  }

  const { stdout, stderr } = await execFileAsync('openclaw', args, { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  return {
    text: extractReply(stdout),
    meta: {
      stderr: stderr?.trim() || '',
      args
    }
  };
}
