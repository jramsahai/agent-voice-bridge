import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig, getRootDir } from '../../packages/shared/config/load-config.js';
import { transcribeWithWhisperLocal } from '../../packages/shared/adapters/stt-whisper-local.js';
import { speakWithMacosSay } from '../../packages/shared/adapters/tts-macos-say.js';
import { sendTurnToOpenClaw } from '../../packages/shared/adapters/openclaw-cli.js';

const { config, configPath } = loadConfig();
const rootDir = getRootDir();
const webDir = path.join(rootDir, 'apps', 'voice-web');

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath, contentType) {
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, { 'content-type': contentType });
  stream.pipe(res);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handleTurn(req, res) {
  try {
    const body = await readJsonBody(req);
    const { audioBase64, mimeType } = body;
    if (!audioBase64) return sendJson(res, 400, { error: 'audioBase64 is required' });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-turn-'));
    const inputExt = mimeType === 'audio/wav' ? 'wav' : mimeType === 'audio/webm' ? 'webm' : mimeType === 'audio/mp4' || mimeType === 'audio/aac' ? 'm4a' : 'bin';
    const inputPath = path.join(tmpDir, `turn-${randomUUID()}.${inputExt}`);
    fs.writeFileSync(inputPath, Buffer.from(audioBase64, 'base64'));

    const transcript = await transcribeWithWhisperLocal(inputPath, config.stt);
    if (!transcript.text || !transcript.text.trim()) {
      return sendJson(res, 422, {
        error: 'transcription returned empty text',
        meta: {
          configPath,
          stt: transcript.meta
        }
      });
    }
    const reply = await sendTurnToOpenClaw(transcript.text, config.openclaw);
    const speech = await speakWithMacosSay(reply.text, config.tts);

    sendJson(res, 200, {
      transcript: transcript.text,
      reply: reply.text,
      audioBase64: speech.audioBuffer.toString('base64'),
      audioMimeType: speech.mimeType,
      meta: {
        configPath,
        stt: transcript.meta,
        reply: reply.meta,
        tts: speech.meta
      }
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message, stack: error.stack });
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
