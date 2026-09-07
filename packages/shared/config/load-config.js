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
  const config = JSON.parse(raw);
  return { config, configPath };
}
