import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function transcribeWithWhisperLocal(audioPath, sttConfig, { signal } = {}) {
  const command = sttConfig.command;
  const args = [audioPath];
  // Array-form argv, no shell: forwarding signal here means aborting the caller's controller
  // terminates this child directly. A shell-spawned child's own children would not be killed
  // by the same signal — no call in this codebase uses shell: true today, and this comment is
  // where a future change introducing one would be reviewed.
  const { stdout, stderr } = await execFileAsync(command, args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024, signal });
  const text = stdout.trim();
  return {
    text,
    meta: {
      command,
      stderr: stderr?.trim() || ''
    }
  };
}
