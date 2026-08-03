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

// Grace window for a lock directory that exists but has no (or an unreadable) holder.json
// yet. Distinguishes two cases that look identical at a glance: a process that crashed
// between mkdirSync and the metadata write (reclaimable) versus a concurrent acquirer that
// created the directory a moment ago and has not reached its own write yet (not reclaimable
// — a benign race). Short, because the write that follows mkdirSync in acquireTurnLock is
// synchronous and immediate; a legitimate acquirer never leaves this window open long.
const MISSING_HOLDER_GRACE_MS = 2000;

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

// A heuristic, not a guarantee: process ids are recycled, so a crashed holder's id can
// later belong to something unrelated, which would make this report "alive" about a
// process that has nothing to do with the lock. That is exactly why the age ceiling
// (STALE_LOCK_MAX_AGE_MS) exists as a second, independent signal below — a recycled id
// delays a reclaim rather than preventing one forever.
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: definitely gone. Any other outcome (EPERM, etc.) is treated as alive.
    return err.code !== 'ESRCH';
  }
}

// Every read here is wrapped so a failure collapses to the safe "no metadata" answer rather
// than propagating — the same posture openclaw-cli.js's hasSessionBeenPrimed applies to its
// own read path.
function readHolderMetadata(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(lockPath, 'holder.json'), 'utf8'));
    if (typeof parsed?.pid !== 'number' || typeof parsed?.acquiredAt !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    // Missing file, unreadable, or malformed JSON all collapse to "no metadata" — handled
    // as a race below, not a crash.
    return null;
  }
}

// Exported so the reclaim fixtures in test/turn-lock.test.js can assert staleness directly
// against hand-built holder.json fixtures, without going through a full acquire/release
// cycle. Every filesystem read on this path is wrapped so a failure collapses to a safe
// answer — this function runs on the acquisition path and must never itself be why a
// legitimate acquisition throws.
export function isTurnLockStale(sessionId) {
  assertValidSessionId(sessionId);
  const lockPath = turnLockPathFor(sessionId);

  const holder = readHolderMetadata(lockPath);
  if (holder !== null) {
    // Primary signal: holder liveness. Backstop: the age ceiling, for the case where a
    // recycled pid makes the liveness probe falsely report alive.
    if (!isProcessAlive(holder.pid)) {
      return true;
    }
    const acquiredAtMs = Date.parse(holder.acquiredAt);
    if (Number.isNaN(acquiredAtMs)) {
      return true;
    }
    return Date.now() - acquiredAtMs > STALE_LOCK_MAX_AGE_MS;
  }

  // No holder metadata: either a crash landed between mkdirSync and the metadata write, or
  // a benign race with a concurrent acquirer that has not written yet. Distinguish by the
  // lock directory's own modification time rather than assuming either case, and reclaim
  // only once the directory is old enough to rule out the benign race.
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > MISSING_HOLDER_GRACE_MS;
  } catch {
    // The directory vanished under us (a racing release, e.g.) — nothing to reclaim here;
    // the caller's own mkdirSync decides what happens next.
    return false;
  }
}

// A contended acquisition returns false on the first attempt: no retry, no polling, no
// wait. A retry loop of any length reintroduces queueing under another name and destroys
// the determinism plan 02-02's concurrency test depends on. Reclaim, when the contended
// lock is stale, is itself a single attempt — if that attempt loses to another process that
// reclaimed first, this reports busy rather than trying again (RQ-2).
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
    if (err.code !== 'EEXIST') {
      throw err;
    }
    if (!isTurnLockStale(sessionId)) {
      return false;
    }
    // Single reclaim attempt: remove the stale artifact and recreate it. If this loses to
    // another process that reclaimed first, report busy — no retry, no poll.
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
      fs.mkdirSync(lockPath);
    } catch {
      return false;
    }
  }

  // Written after the directory create succeeds, so a crash between the two leaves a lock
  // directory with no holder.json — the case isTurnLockStale reasons about above (treated
  // as reclaimable once old enough, not as held).
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
