import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withTempDir } from '../lifecycle/tempfiles.js';

const execFileAsync = promisify(execFile);

export async function speakWithMacosSay(text, ttsConfig, { signal } = {}) {
  const voice = ttsConfig.voice || 'Samantha';

  // Wrapped in withTempDir so this directory is guaranteed removed on success, on a
  // non-zero exit from either child, on a timeout, and on an abort — previously created via
  // a bare mkdtempSync with no cleanup path at all (carried-in debt PROJECT.md records).
  return withTempDir('voice-bridge-tts-', async (tmpDir) => {
    const aiffPath = path.join(tmpDir, 'reply.aiff');
    const m4aPath = path.join(tmpDir, 'reply.m4a');

    // Array-form argv, no shell: forwarding signal here means aborting the caller's
    // controller terminates this child directly. A shell-spawned child's own children would
    // not be killed by the same signal — no call in this codebase uses shell: true today.
    await execFileAsync('/usr/bin/say', ['-v', voice, '-o', aiffPath, text], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    // Same array-form/shell caveat as the /usr/bin/say call above.
    await execFileAsync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', aiffPath, m4aPath], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    const audioBuffer = fs.readFileSync(m4aPath);

    return {
      audioBuffer,
      mimeType: 'audio/mp4',
      meta: { voice }
    };
  });
}
