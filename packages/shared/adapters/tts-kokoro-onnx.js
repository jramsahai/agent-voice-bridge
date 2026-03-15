import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function speakWithKokoroOnnx(text, ttsConfig) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-kokoro-'));
  const wavPath = path.join(tmpDir, 'reply.wav');
  const m4aPath = path.join(tmpDir, 'reply.m4a');
  const command = ttsConfig.command || '/Users/you/bin/tts-kokoro';
  const voice = ttsConfig.voice || 'af_heart';

  await execFileAsync(command, [text, wavPath, voice], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  await execFileAsync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', wavPath, m4aPath], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  const audioBuffer = fs.readFileSync(m4aPath);

  return {
    audioBuffer,
    mimeType: 'audio/mp4',
    meta: { voice, command }
  };
}
