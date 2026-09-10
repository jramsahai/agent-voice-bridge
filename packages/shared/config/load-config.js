import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function getRootDir() {
  return rootDir;
}

export function loadConfig() {
  const localPath = path.join(rootDir, 'config', 'config.local.json');
  const examplePath = path.join(rootDir, 'config', 'config.example.json');
  const configPath = fs.existsSync(localPath) ? localPath : examplePath;
  const raw = fs.readFileSync(configPath, 'utf8');
  const { config, warnings } = normalizeConfig(JSON.parse(raw));
  return { config, configPath, warnings };
}

// The conversation stage was configured under `openclaw` before the agent became a
// provider. A config still using that key is migrated in memory to `agent` with
// provider "openclaw" so an existing deployment keeps booting; the warning names the
// rename so the file gets updated. A config carrying both keys is left alone for
// validateConfig to reject — silently preferring one would hide a real mistake.
export function normalizeConfig(config) {
  const warnings = [];
  if (config && typeof config === 'object' && config.openclaw !== undefined && config.agent === undefined) {
    const { openclaw, ...rest } = config;
    warnings.push('config key "openclaw" was renamed to "agent" (with "provider": "openclaw"); update config/config.local.json');
    return { config: { ...rest, agent: { provider: 'openclaw', ...openclaw } }, warnings };
  }
  return { config, warnings };
}
