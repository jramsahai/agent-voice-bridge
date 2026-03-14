import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function transcribeWithWhisperLocal(audioPath, sttConfig) {
  const command = sttConfig.command;
  const args = [audioPath];
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  const text = stdout.trim();
  return {
    text,
    meta: {
      command,
      stderr: stderr?.trim() || ''
    }
  };
}
