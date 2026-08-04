import http from 'node:http';
import path from 'node:path';
import { loadConfig, getRootDir } from '../../packages/shared/config/load-config.js';
import { validateConfig } from '../../packages/shared/config/validate-config.js';
import { runPreflightChecks } from '../../packages/shared/lifecycle/preflight.js';
import { transcribeWithWhisperLocal } from '../../packages/shared/adapters/stt-whisper-local.js';
import { speakText } from '../../packages/shared/adapters/tts.js';
import { sendTurnToOpenClaw } from '../../packages/shared/adapters/openclaw-cli.js';
import { createRequestHandler } from './request-handler.js';

const { config, configPath } = loadConfig();
const rootDir = getRootDir();
const webDir = path.join(rootDir, 'apps', 'voice-web');

const configErrors = validateConfig(config);
if (configErrors.length > 0) {
  console.error(`[voice-bridge] invalid configuration at ${configPath}:`);
  for (const message of configErrors) {
    console.error(`[voice-bridge]   - ${message}`);
  }
  process.exit(1);
}

const { errors: preflightErrors, warnings: preflightWarnings } = await runPreflightChecks({ config });
for (const warning of preflightWarnings) {
  console.warn(`[voice-bridge] ${warning}`);
}
if (preflightErrors.length > 0) {
  console.error('[voice-bridge] startup preflight failed:');
  for (const message of preflightErrors) {
    console.error(`[voice-bridge]   - ${message}`);
  }
  process.exit(1);
}

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
