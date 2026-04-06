import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { loadConfig, getRootDir } from '../../packages/shared/config/load-config.js';
import { transcribeWithWhisperLocal } from '../../packages/shared/adapters/stt-whisper-local.js';
import { speakText } from '../../packages/shared/adapters/tts.js';
import { sendTurnToOpenClaw } from '../../packages/shared/adapters/openclaw-cli.js';

const { config, configPath } = loadConfig();
const rootDir = getRootDir();
const webDir = path.join(rootDir, 'apps', 'voice-web');
const MAX_JSON_BYTES = config.security?.maxJsonBytes ?? 2_000_000;
const RATE_LIMIT_WINDOW_MS = config.security?.rateLimitWindowMs ?? 15_000;
const RATE_LIMIT_MAX_REQUESTS = config.security?.rateLimitMaxRequests ?? 6;
const allowedOrigins = new Set(config.security?.allowedOrigins ?? []);
const expectedHost = config.security?.expectedHost ?? null;
const requireToken = config.security?.token ?? '';
const rateLimitBuckets = new Map();

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath, contentType) {
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, { 'content-type': contentType });
  stream.pipe(res);
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function isAuthorizedToken(receivedToken) {
  if (!requireToken) return true;
  if (!receivedToken) return false;
  const left = Buffer.from(receivedToken);
  const right = Buffer.from(requireToken);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function checkRateLimit(req) {
  const key = clientIp(req);
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key) ?? [];
  const fresh = bucket.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  rateLimitBuckets.set(key, fresh);
  return true;
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) {
      throw new Error('payload too large');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function validateRequest(req, res) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (expectedHost && host !== expectedHost) {
    sendJson(res, 403, { error: 'host not allowed' });
    return false;
  }
  if (allowedOrigins.size && origin && !allowedOrigins.has(origin)) {
    sendJson(res, 403, { error: 'origin not allowed' });
    return false;
  }
  if (!isAuthorizedToken(bearerToken)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  if (!checkRateLimit(req)) {
    sendJson(res, 429, { error: 'too many requests' });
    return false;
  }
  return true;
}

async function handleTurn(req, res) {
  try {
    if (!validateRequest(req, res)) return;

    const body = await readJsonBody(req);
    const { audioBase64, mimeType } = body;
    if (!audioBase64) return sendJson(res, 400, { error: 'audioBase64 is required' });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-turn-'));
    const inputExt = mimeType === 'audio/wav' ? 'wav' : mimeType === 'audio/webm' ? 'webm' : mimeType === 'audio/mp4' || mimeType === 'audio/aac' ? 'm4a' : 'bin';
    const inputPath = path.join(tmpDir, `turn-${randomUUID()}.${inputExt}`);
    fs.writeFileSync(inputPath, Buffer.from(audioBase64, 'base64'));

    const transcript = await transcribeWithWhisperLocal(inputPath, config.stt);
    if (!transcript.text || !transcript.text.trim()) {
      return sendJson(res, 422, { error: 'transcription returned empty text' });
    }

    const reply = await sendTurnToOpenClaw(transcript.text, config.openclaw);
    const speech = await speakText(reply.text, config.tts);

    sendJson(res, 200, {
      transcript: transcript.text,
      reply: reply.rawText || reply.text,
      speechText: reply.text,
      audioBase64: speech.audioBuffer.toString('base64'),
      audioMimeType: speech.mimeType
    });
  } catch (error) {
    if (error.message === 'payload too large') {
      return sendJson(res, 413, { error: 'payload too large' });
    }
    console.error('[voice-bridge] request failed', error);
    sendJson(res, 500, { error: 'internal server error' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    return sendFile(res, path.join(webDir, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && req.url === '/app.js') {
    return sendFile(res, path.join(webDir, 'app.js'), 'application/javascript; charset=utf-8');
  }
  if (req.method === 'POST' && req.url === '/api/turn') {
    return handleTurn(req, res);
  }
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, configPath });
  }
  sendJson(res, 404, { error: 'not found' });
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`voice bridge listening on http://${config.server.host}:${config.server.port}`);
  console.log(`using config ${configPath}`);
});
