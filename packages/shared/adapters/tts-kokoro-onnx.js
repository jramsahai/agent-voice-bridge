import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function getKokoroServiceUrl(ttsConfig = {}) {
  return ttsConfig.serviceUrl || process.env.KOKORO_TTS_URL || 'http://127.0.0.1:4319';
}

/**
 * Check if the Kokoro FastAPI service is available.
 */
async function isFastApiAvailable(serviceUrl) {
  try {
    const res = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Generate speech via the persistent Kokoro FastAPI service.
 */
async function speakWithFastApi(text, ttsConfig) {
  const voice = ttsConfig.voice || 'af_heart';
  const speed = ttsConfig.speed || 1.0;
  const serviceUrl = getKokoroServiceUrl(ttsConfig);

  const res = await fetch(`${serviceUrl}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed, lang: 'en-us' }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kokoro FastAPI error ${res.status}: ${err}`);
  }

  const wavBuffer = Buffer.from(await res.arrayBuffer());

  // Convert WAV to M4A for smaller payload
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-kokoro-'));
  const wavPath = path.join(tmpDir, 'reply.wav');
  const m4aPath = path.join(tmpDir, 'reply.m4a');
  fs.writeFileSync(wavPath, wavBuffer);
  await execFileAsync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', wavPath, m4aPath], {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const audioBuffer = fs.readFileSync(m4aPath);

  return {
    audioBuffer,
    mimeType: 'audio/mp4',
    meta: { voice, speed, method: 'fastapi', serviceUrl },
  };
}

/**
 * Fallback: spawn Python process (original behavior).
 */
async function speakWithKokoroOnnx(text, ttsConfig) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-kokoro-'));
  const wavPath = path.join(tmpDir, 'reply.wav');
  const m4aPath = path.join(tmpDir, 'reply.m4a');
  const command = ttsConfig.command || 'tts-kokoro';
  const voice = ttsConfig.voice || 'af_heart';

  await execFileAsync(command, [text, wavPath, voice], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  await execFileAsync('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', wavPath, m4aPath], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  const audioBuffer = fs.readFileSync(m4aPath);

  return {
    audioBuffer,
    mimeType: 'audio/mp4',
    meta: { voice, command, method: 'spawn' },
  };
}

export async function speakWithKokoroFast(text, ttsConfig) {
  // Prefer FastAPI if available, fall back to spawn
  const serviceUrl = getKokoroServiceUrl(ttsConfig);
  const fastApiUp = await isFastApiAvailable(serviceUrl);
  if (fastApiUp) {
    return speakWithFastApi(text, ttsConfig);
  }
  return speakWithKokoroOnnx(text, ttsConfig);
}
