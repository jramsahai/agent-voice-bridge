// The two concrete reachability probes this project has: a filesystem-resolvability check
// for external CLI commands (whisper, openclaw) and an HTTP health check for the Kokoro
// FastAPI service. Both are zero-argument-friendly factories suitable to hand to
// getBackendStatus as its probeFn.

import fs from 'node:fs';
import path from 'node:path';

import { getRootDir } from '../config/load-config.js';
import { composeAbortSignals } from '../lifecycle/abort-signals.js';

// Same ceiling isFastApiAvailable already used — carried forward unchanged, not
// re-tuned, so this move is a pure relocation rather than a behavior change.
const HTTP_PROBE_TIMEOUT_MS = 2000;

// Resolvability check only — this must never execute the configured binary. Probing the
// agent backend by actually running the OpenClaw CLI would start real work nobody asked for
// (T-3-12). A command containing a path separator is resolved against the repository root
// via getRootDir() when relative, then checked directly; a bare command name is searched
// across every entry in process.env.PATH the same way. Resolves when runnable, rejects
// otherwise.
export async function probeExecutable(command) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('probeExecutable: command must be a non-empty string');
  }

  const hasPathSeparator = command.includes(path.sep) || command.includes('/');

  if (hasPathSeparator) {
    const resolvedPath = path.isAbsolute(command) ? command : path.join(getRootDir(), command);
    await fs.promises.access(resolvedPath, fs.constants.X_OK);
    return;
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = path.join(dir, command);
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return;
    } catch {
      // Not on this PATH entry — keep searching the rest.
    }
  }
  throw new Error(`probeExecutable: '${command}' not found on PATH`);
}

// Resolves when a GET of the service's own /health path returns an ok response, rejects
// otherwise — a non-ok status, a network failure, a timeout, and an aborted caller signal
// all reject here unconditionally rather than being swallowed to a boolean. This is
// deliberate: getBackendStatus is the layer with a documented contract to collapse every
// probe rejection to BACKEND_DOWN, so this function never needs its own swallow-to-false
// branch the way the isFastApiAvailable it replaces did. Reuses composeAbortSignals rather
// than re-implementing signal composition, and keeps the existing 2000ms per-probe ceiling.
export async function probeHttpService(serviceUrl, { signal } = {}) {
  const res = await fetch(`${serviceUrl}/health`, {
    signal: composeAbortSignals(signal, AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS)),
  });
  if (!res.ok) {
    throw new Error(`probeHttpService: ${serviceUrl}/health responded ${res.status}`);
  }
}
