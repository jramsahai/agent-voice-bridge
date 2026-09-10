import http from 'node:http';
import path from 'node:path';
import { loadConfig, getRootDir } from '../../packages/shared/config/load-config.js';
import { validateConfig } from '../../packages/shared/config/validate-config.js';
import { runPreflightChecks } from '../../packages/shared/lifecycle/preflight.js';
import { installShutdownHandlers } from '../../packages/shared/lifecycle/shutdown.js';
import { transcribeWithWhisperLocal } from '../../packages/shared/adapters/stt-whisper-local.js';
import { speakText } from '../../packages/shared/adapters/tts.js';
import { sendTurnToAgent } from '../../packages/shared/adapters/agent.js';
import { createRequestHandler } from './request-handler.js';

const { config, configPath, warnings: configWarnings } = loadConfig();
for (const warning of configWarnings) {
  console.warn(`[voice-bridge] ${warning}`);
}
const rootDir = getRootDir();
const webDir = path.join(rootDir, 'apps', 'voice-web');

let configErrors;
try {
  configErrors = validateConfig(config);
} catch (err) {
  console.error(`[voice-bridge] invalid configuration at ${configPath}:`);
  console.error(`[voice-bridge]   - ${err.message}`);
  process.exit(1);
}
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
  agent: sendTurnToAgent,
  speak: speakText,
};

const inFlightControllers = new Set();

const server = http.createServer(createRequestHandler({ config, adapters, webDir, inFlightControllers }));

const { shutdown } = installShutdownHandlers({ server, inFlightControllers });

// WR-01: this listener stays registered for the server object's entire lifetime, not just
// during listen() — http.Server's 'error' event can fire after a successful start too (e.g.
// EMFILE under file-descriptor exhaustion). Before the server has ever started listening
// there is nothing to drain, so exit immediately; after that, route through the same
// shutdown() the signal handlers use so in-flight turns get the same abort/drain treatment
// instead of a bare process.exit(1).
let startedListening = false;
server.on('error', (err) => {
  if (!startedListening) {
    console.error(`[voice-bridge] failed to start server: ${err.message}`);
    process.exit(1);
    return;
  }
  console.error(`[voice-bridge] server error: ${err.message}`);
  shutdown('SERVER_ERROR');
});

server.listen(config.server.port, config.server.host, () => {
  startedListening = true;
  console.log(`voice bridge listening on http://${config.server.host}:${config.server.port}`);
  console.log(`using config ${configPath}`);
});
