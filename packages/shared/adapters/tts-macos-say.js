import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function speakWithMacosSay(text, ttsConfig) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-tts-'));
  const aiffPath = path.join(tmpDir, 'reply.aiff');
  const m4aPath = path.join(tmpDir, 'reply.m4a');
  const voice = ttsConfig.voice || 'Samantha';

  await execFileAsync('/usr/bin/say', ['-v', voice, '-o', aiffPath, text], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  await execFileAsync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', aiffPath, m4aPath], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  const audioBuffer = fs.readFileSync(m4aPath);

  return {
    audioBuffer,
    mimeType: 'audio/mp4',
    meta: { voice }
  };
}
