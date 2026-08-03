// Two-layer single-flight turn lock: an in-process holder over a mkdirSync lock directory
// that is the cross-process source of truth. `fs.mkdirSync` is atomic and fails with EEXIST
// under contention, which is the whole primitive (checkpoint decision, plan 02-01 Task 1,
// option-a).
//
// Every filesystem call in this module is synchronous. Nothing here may `await`, because
// `runTurn` calls acquireTurnLock before its own first `await` and that ordering is what
// makes two racing turns deterministic.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The same directory packages/shared/adapters/openclaw-cli.js already writes its
// {sessionId}.json session-state file into — the lock sits at the same level of reality as
// the resource it protects.
const LOCK_ROOT = path.join(os.tmpdir(), 'openclaw-voice-bridge-session-state');

// Distinct from the session-state file's own naming (`{sessionId}.json`) so the lock
// artifact can never collide with it.
const LOCK_SUFFIX = '.turnlock';

// Consumed by plan 02-02's reclaim check (PID-liveness first, this ceiling as the backstop
// for PID reuse and for the crash-between-mkdir-and-write case); not read here — this task
// only writes the holder metadata so that check has evidence to read. Sized from the
// adapters' real configured timeouts rather than a round number: transcription (120000ms)
// + the agent CLI (180000ms) + speech (120000ms) = 420000ms for a worst-case legitimate
// turn. Fifteen minutes clears that with better than 2x margin, where 02-RESEARCH.md's
// provisional five minutes sits below the sum and could reclaim a lock a legitimately slow
// turn still holds.
const STALE_LOCK_MAX_AGE_MS = 900000;

// Which session id, if any, this process currently believes it holds — never a bare
// boolean, so the module can never conflate two different sessions' turns.
let heldSessionId = null;

function assertValidSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('turn-lock: sessionId must be a non-empty string');
  }
  if (sessionId.includes(path.sep) || sessionId.includes('/')) {
    throw new Error('turn-lock: sessionId must not contain a path separator');
  }
  if (sessionId === '.' || sessionId === '..') {
    throw new Error('turn-lock: sessionId must not be "." or ".."');
  }
}

// A pure path-computation helper — it does not validate and it does not touch the
// filesystem, so tests and later plans can inspect the would-be artifact path for any
// input, including the malformed ids acquireTurnLock/releaseTurnLock reject, without
// throwing. Neither of those two functions derives a real filesystem path from untrusted
// input without validating it first (via assertValidSessionId) — this function is never the
// thing standing between attacker-controlled input and an actual fs write.
export function turnLockPathFor(sessionId) {
  return path.join(LOCK_ROOT, `${String(sessionId)}${LOCK_SUFFIX}`);
}

// A contended acquisition returns false on the first attempt: no retry, no polling, no
// wait. A retry loop of any length reintroduces queueing under another name and destroys
// the determinism plan 02-02's concurrency test depends on. Stale-lock reclaim (reading
// holder.json, checking PID liveness, falling back to STALE_LOCK_MAX_AGE_MS) is plan
// 02-02's — left out of this task by design.
export function acquireTurnLock(sessionId) {
  assertValidSessionId(sessionId);

  // Acquisition while any session is held returns false immediately with zero filesystem
  // I/O — this project has exactly one shared conversation, so a second in-flight turn is
  // rejected outright rather than queued or partitioned per caller.
  if (heldSessionId !== null) {
    return false;
  }

  const lockPath = turnLockPathFor(sessionId);
  fs.mkdirSync(LOCK_ROOT, { recursive: true });

  try {
    fs.mkdirSync(lockPath);
  } catch (err) {
    if (err.code === 'EEXIST') {
      return false;
    }
    throw err;
  }

  // Written after the directory create succeeds, so a crash between the two leaves a
  // lock directory with no holder.json — a real case plan 02-02's reclaim check must
  // reason about (treated as reclaimable, not as held).
  fs.writeFileSync(
    path.join(lockPath, 'holder.json'),
    JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), sessionId }),
    'utf8',
  );

  heldSessionId = sessionId;
  return true;
}

// Release clears the in-process holder first, then removes the artifact inside a
// try/catch that swallows — this runs in runTurn's outer finally and must never be the
// thing that throws.
export function releaseTurnLock(sessionId) {
  assertValidSessionId(sessionId);
  heldSessionId = null;
  try {
    fs.rmSync(turnLockPathFor(sessionId), { recursive: true, force: true });
  } catch {
    // Swallow — release must never throw.
  }
}
