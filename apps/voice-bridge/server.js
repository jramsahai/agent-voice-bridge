import http from 'node:http';
import path from 'node:path';
import { loadConfig, getRootDir } from '../../packages/shared/config/load-config.js';
import { transcribeWithWhisperLocal } from '../../packages/shared/adapters/stt-whisper-local.js';
import { speakText } from '../../packages/shared/adapters/tts.js';
import { sendTurnToOpenClaw } from '../../packages/shared/adapters/openclaw-cli.js';
import { createRequestHandler } from './request-handler.js';

const { config, configPath } = loadConfig();
const rootDir = getRootDir();
const webDir = path.join(rootDir, 'apps', 'voice-web');

const adapters = {
  transcribe: transcribeWithWhisperLocal,
  agent: sendTurnToOpenClaw,
  speak: speakText,
};

const server = http.createServer(createRequestHandler({ config, adapters, webDir }));

server.listen(config.server.port, config.server.host, () => {
  console.log(`voice bridge listening on http://${config.server.host}:${config.server.port}`);
  console.log(`using config ${configPath}`);
});
