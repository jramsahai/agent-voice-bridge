// TTL-windowed reachability cache: a probe is invoked at most once per backend name per
// window, no matter how many callers ask for that backend's status inside the window. Same
// shape as packages/shared/session/turn-lock.js — a module-level Map plus exported plain
// functions, no class wrapper. This module performs no I/O of its own; it only calls the
// probeFn a caller hands it, so it stays unit-testable with a counting fake and never needs
// a network client, a filesystem call, or a child process of its own.

// Tunable default drawn from 03-RESEARCH.md Assumptions Log A3 — a commonly cited
// liveness-caching window (5-10s), not a figure measured against this project's own turn
// cadence. Change this one line to change the window everywhere it is consumed.
export const PROBE_TTL_MS = 10000;

// Exported so no caller ever writes the verdict strings as literals.
export const BACKEND_UP = 'up';
export const BACKEND_DOWN = 'down';

// name -> { verdict, checkedAt }. One entry per distinct name — a repeated call for the same
// name always overwrites the same Map key, so the entry count can never grow past one per
// name no matter how many times a caller asks.
const cache = new Map();

// Resolves BACKEND_UP or BACKEND_DOWN, never rejects. Freshness is `now - checkedAt < ttlMs`,
// strictly less than, so the boundary instant itself (now === checkedAt + ttlMs) counts as
// expired and re-probes — this is the exact edge a boundary test pins.
//
// `options.ttlMs` defaults to PROBE_TTL_MS and `options.now` defaults to Date.now so a test
// can drive the boundary with an injected clock instead of sleeping for a real TTL, which
// nobody would run.
//
// One TTL applies to both verdicts, deliberately (03-RESEARCH.md Assumptions Log A4): a down
// backend is re-probed on the same schedule an up one is, at the cost of detecting a recovery
// up to one window late. Two callers racing an already-expired entry each run their own probe
// and each receive a verdict; the entry left in the cache afterward is whichever probe's
// `cache.set` runs last, never an earlier stale one, because a Map.set always overwrites the
// existing key rather than merging with it.
export async function getBackendStatus(name, probeFn, options = {}) {
  const ttlMs = options.ttlMs ?? PROBE_TTL_MS;
  const nowFn = options.now ?? Date.now;
  const checkedAt = nowFn();

  const entry = cache.get(name);
  if (entry && checkedAt - entry.checkedAt < ttlMs) {
    return entry.verdict;
  }

  let verdict;
  try {
    await probeFn();
    verdict = BACKEND_UP;
  } catch {
    // A probe that rejects yields a cached down verdict rather than an unhandled rejection
    // escaping to the caller — getBackendStatus never rejects.
    verdict = BACKEND_DOWN;
  }
  cache.set(name, { verdict, checkedAt });
  return verdict;
}

// Test-only: empties every entry so the next call for a previously cached name re-probes.
export function resetBackendHealthCache() {
  cache.clear();
}
