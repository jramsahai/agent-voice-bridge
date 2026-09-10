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
import { randomUUID } from 'node:crypto';

// The same directory packages/shared/adapters/agent-session.js already writes its
// {sessionId}.json session-state file into — the lock sits at the same level of reality as
// the resource it protects.
const LOCK_ROOT = path.join(os.tmpdir(), 'agent-voice-bridge-session-state');

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

// The opaque token this process wrote into holder.json when it acquired heldSessionId.
// releaseTurnLock reads holder.json back and only removes the on-disk artifact when this
// token still matches — proving the artifact on disk is still the one this process created,
// not one a later reclaimer or a fresh acquirer has since replaced it with (CR-02).
let heldToken = null;

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
// than propagating — the same posture agent-session.js's hasSessionBeenPrimed applies to its
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

// The (device, inode, birth time) triple identifying whatever directory sits at `dirPath` at
// this instant, or null when nothing does. A reclaim binds itself to this rather than to the
// path, because the path is precisely the thing another process can recreate underneath this
// one. bigint stats are used so a 64-bit inode number survives the comparison intact instead
// of being rounded through a double, and birth time is folded in as an independent second
// signal because a filesystem is free to hand a recycled inode number straight back out to the
// directory that replaces this one. Wrapped like every other read in this module: a failure
// collapses to the safe "no identity" answer, which every caller treats as a lost race.
function lockDirectoryIdentity(dirPath) {
  try {
    const stat = fs.statSync(dirPath, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
  } catch {
    return null;
  }
}

// Deliberately false when either side is null: an identity that could not be read is never
// evidence that two directories are the same directory.
function isSameDirectory(a, b) {
  if (a === null || b === null) {
    return false;
  }
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
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
//
// The reclaim step (CR-01) does not `rmSync` the existing directory in place — two
// processes independently observing the same stale lock could both win that sequence, since
// `rmSync`+`mkdirSync` are two unrelated syscalls with nothing atomic between them. Instead
// the reclaimer *steals* the stale directory with a single `fs.renameSync(lockPath,
// scratchPath)`, where `scratchPath` is unique to this attempt.
//
// That rename is atomic with respect to the *path* and to nothing more, and the distinction is
// the whole of CR-01b. Exactly one process can rename a given path at a given instant, but a
// path is a name, not the directory it names: winning the rename proves *that* this process
// won, never *what* it won. If a faster reclaimer already completed this entire sequence, the
// name now points at that reclaimer's brand-new, live lock — and a second rename of the same
// name succeeds just as happily, handing the loser a live lock it has no right to and leaving
// two processes each believing they hold the turn. Staleness was checked against one directory
// and the steal took another; the earlier version of this comment asserted the losing rename
// would throw ENOENT, which is true only if nothing recreates the name in between, and a
// winning reclaimer's own final create is exactly something that does.
//
// So the steal is bound to identity rather than to the name. The directory's (device, inode,
// birth time) triple is captured *before* the staleness verdict is formed, and the directory
// the rename actually produced is compared against it afterwards. Equal means the verdict and
// the steal concern the same directory, and the reclaim is real. Unequal means this process
// lost the race and is holding somebody else's live lock: it puts that directory straight back
// and reports busy — a single attempt, no retry, and nothing destroyed.
//
// The steal is followed immediately by one further create of the lock path, ahead of the
// comparison and ahead of discarding anything, so the path is never observably free for longer
// than a single syscall gap. That placeholder does double duty: a fresh acquirer racing the gap
// meets EEXIST rather than an open door, and — because the placeholder is empty — a restore is
// one atomic rename over it rather than a remove-then-move that would open a second window of
// its own. Losing even that one-syscall gap to a third, unrelated fresh acquirer is reported as
// busy exactly like any other contention.
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
    // Captured before the staleness verdict, never after. The verdict reads the directory
    // through this same path, so anything that replaces the directory between these two steps
    // leaves `observed` a strictly older observation than the evidence the verdict was formed
    // from, and the comparison after the steal then refuses. Capturing it after the verdict
    // would invert exactly that: a verdict formed about one directory would go on to authorise
    // stealing its replacement, which is the defect this ordering exists to prevent.
    const observed = lockDirectoryIdentity(lockPath);
    if (observed === null || !isTurnLockStale(sessionId)) {
      return false;
    }

    // Single reclaim attempt: steal the directory via rename (see the block comment above),
    // re-occupy the path at once, then prove the steal took the directory the verdict was about.
    // Any step losing — the rename because the path went away, the identity check because a
    // faster reclaimer got there first, the re-occupation because a third acquirer claimed the
    // path in the gap — reports busy. No retry, no poll, no second attempt at any step.
    const scratchPath = `${lockPath}.reclaim-${randomUUID()}`;
    try {
      fs.renameSync(lockPath, scratchPath);
    } catch {
      return false;
    }

    // The very next syscall, ahead of the comparison and ahead of discarding anything, so the
    // steal leaves no open door behind it. A concurrent acquirer arriving now meets EEXIST and
    // then reads this placeholder as "no holder metadata, modified moments ago", which
    // MISSING_HOLDER_GRACE_MS already classifies as not reclaimable — so it refuses rather than
    // reclaiming a directory this process has not finished deciding about.
    let pathReoccupied = true;
    try {
      fs.mkdirSync(lockPath);
    } catch {
      pathReoccupied = false;
    }

    if (!isSameDirectory(lockDirectoryIdentity(scratchPath), observed)) {
      // The rename won the name but took a different directory than the one judged stale:
      // another reclaimer finished first, and what this process is holding is that reclaimer's
      // live lock. Put it back — one rename over the empty placeholder above, so the path is
      // never free at any point in between — and report busy. If the placeholder was lost and
      // something non-empty now holds the path, the restore cannot land; discard the directory
      // rather than leak it into the lock root forever, and let the rightful holder's own token
      // check (see releaseTurnLock) keep it from removing whatever stands there instead.
      try {
        fs.renameSync(scratchPath, lockPath);
      } catch {
        fs.rmSync(scratchPath, { recursive: true, force: true });
      }
      return false;
    }

    fs.rmSync(scratchPath, { recursive: true, force: true });

    if (!pathReoccupied) {
      // The steal was legitimate, but a third, unrelated fresh acquirer claimed the path in the
      // one-syscall gap above. Reported as busy exactly like any other contention.
      return false;
    }
  }

  // Written after the directory create succeeds, so a crash between the two leaves a lock
  // directory with no holder.json — the case isTurnLockStale reasons about above (treated
  // as reclaimable once old enough, not as held). token is this process's own proof of
  // ownership, checked back by releaseTurnLock (CR-02) so a release can never remove a lock
  // a later acquirer has since replaced.
  const token = randomUUID();
  try {
    fs.writeFileSync(
      path.join(lockPath, 'holder.json'),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), sessionId, token }),
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (err) {
    // An exclusive create, because the directory this write lands in was created empty moments
    // ago by whichever of the two creates above succeeded. An existing holder.json can therefore
    // only mean the path stopped being this process's between that create and this write — a
    // reclaimer restoring a live lock it should never have taken, replacing this brand-new
    // directory with the rightful holder's. ENOENT means the directory was removed outright.
    // Both are contention and are reported as busy; without this guard the write would instead
    // land inside the restored holder's directory and overwrite its metadata, which is the same
    // mutual-exclusion break by a longer route. Anything else is a real I/O failure and throws.
    if (err.code === 'EEXIST' || err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }

  heldSessionId = sessionId;
  heldToken = token;
  return true;
}

// Release only ever acts on the lock this process itself believes it holds (CR-02). A call
// naming a different sessionId than heldSessionId is a documented no-op — it touches neither
// the in-process holder nor any filesystem artifact, so it can never clear the in-process
// fast path for whatever this process actually holds and can never remove a different,
// currently-live session's lock. Even when sessionId matches, the on-disk holder.json is
// read back and compared by token before anything is removed: if it no longer matches (this
// process's own lock was reclaimed as stale by someone else while a slow turn was still
// in-flight, or has already been released), the artifact on disk now belongs to a different
// acquirer and must not be touched. The in-process state is cleared either way, because this
// process's own belief that it holds sessionId ends here regardless of what disk agrees
// with. Every filesystem operation runs inside a try/catch that swallows — this executes
// from runTurn's outer finally and must never be the thing that throws.
export function releaseTurnLock(sessionId) {
  assertValidSessionId(sessionId);

  if (sessionId !== heldSessionId || heldToken === null) {
    return;
  }

  const lockPath = turnLockPathFor(sessionId);
  const onDiskHolder = readHolderMetadata(lockPath);
  const stillOwnedByUs = onDiskHolder !== null && onDiskHolder.token === heldToken;

  heldSessionId = null;
  heldToken = null;

  if (!stillOwnedByUs) {
    return;
  }

  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // Swallow — release must never throw.
  }
}
