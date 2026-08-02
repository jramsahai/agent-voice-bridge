import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const voiceSessionStateDir = path.join(os.tmpdir(), 'openclaw-voice-bridge-session-state');

function extractReply(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    return parsed?.result?.payloads?.[0]?.text || parsed?.reply || parsed?.message || parsed?.text || trimmed;
  } catch {
    return trimmed;
  }
}

function cleanTextForSpeech(text) {
  let cleaned = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^-+\s+/gm, ' ')
    .replace(/^\d+\.\s+/gm, ' ')
    .replace(/^\[\s*[xX]\s*\]\s+/gm, ' ')
    .replace(/^\[\s*\]\s+/gm, ' ')
    .replace(/[→\-•✓✔]/g, ' ')
    .replace(/:\s*$/gm, ' ')
    .replace(/:\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();

  return cleaned;
}

function getVoiceInstructions(openclawConfig) {
  return (
    openclawConfig.voiceInstructions ||
    'This session is for voice conversations. Respond briefly, conversationally, and in plain spoken sentences. Avoid markdown, headings, bullets, numbered lists, and code-style formatting unless the user explicitly asks for them.'
  );
}

function getSessionStatePath(sessionId) {
  return path.join(voiceSessionStateDir, `${sessionId}.json`);
}

function hasSessionBeenPrimed(sessionId) {
  if (!sessionId) return false;
  try {
    return fs.existsSync(getSessionStatePath(sessionId));
  } catch {
    return false;
  }
}

function markSessionPrimed(sessionId) {
  if (!sessionId) return;
  fs.mkdirSync(voiceSessionStateDir, { recursive: true });
  fs.writeFileSync(getSessionStatePath(sessionId), JSON.stringify({ primedAt: new Date().toISOString() }), 'utf8');
}

async function runOpenClawAgent(message, openclawConfig) {
  const args = ['agent', '--message', message, '--json'];

  if (openclawConfig.sessionId) {
    args.push('--session-id', openclawConfig.sessionId);
  } else if (openclawConfig.to) {
    args.push('--to', openclawConfig.to);
  }

  if (openclawConfig.thinking) {
    args.push('--thinking', openclawConfig.thinking);
  }

  const { stdout, stderr } = await execFileAsync('/opt/homebrew/bin/openclaw', args, {
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024
  });

  return {
    rawReply: extractReply(stdout),
    stderr: stderr?.trim() || '',
    args
  };
}

async function primeVoiceSession(openclawConfig) {
  if (!openclawConfig.sessionId || hasSessionBeenPrimed(openclawConfig.sessionId)) {
    return null;
  }

  const primingMessage = `Voice conversation mode instructions: ${getVoiceInstructions(openclawConfig)}`;
  const result = await runOpenClawAgent(primingMessage, openclawConfig);
  markSessionPrimed(openclawConfig.sessionId);
  return result;
}

export async function sendTurnToOpenClaw(text, openclawConfig) {
  if (!text || !text.trim()) {
    throw new Error('OpenClaw handoff requires non-empty text');
  }

  await primeVoiceSession(openclawConfig);

  const result = await runOpenClawAgent(text.trim(), openclawConfig);
  const cleanedReply = cleanTextForSpeech(result.rawReply);

  return {
    text: cleanedReply,
    rawText: result.rawReply,
    meta: {
      stderr: result.stderr,
      args: result.args
    }
  };
}
