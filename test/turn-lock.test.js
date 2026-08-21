// Refusal semantics, idempotent release, and stale-lock reclaim for the mkdirSync-based
// single-flight turn lock. Every test uses a session id unique to itself and cleans up in a
// finally, because `node --test` runs test files in parallel child processes and the lock is
// a real filesystem artifact they all share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  acquireTurnLock,
  releaseTurnLock,
  turnLockPathFor,
  isTurnLockStale,
} from '../packages/shared/session/turn-lock.js';

// Read turn-lock.js's own STALE_LOCK_MAX_AGE_MS from its source text (regex, not a new
// export) so the backdated fixture below can never drift from the real ceiling — same
// pattern test/turn-pipeline.test.js uses for TEMP_DIR_PREFIX.
const TURN_LOCK_SOURCE_URL = new URL('../packages/shared/session/turn-lock.js', import.meta.url);
const TURN_LOCK_SOURCE = fs.readFileSync(TURN_LOCK_SOURCE_URL, 'utf8');

function readStaleLockMaxAgeMs() {
  const match = TURN_LOCK_SOURCE.match(/STALE_LOCK_MAX_AGE_MS\s*=\s*(\d+)/);
  assert.ok(match, 'turn-lock.js must declare a documented STALE_LOCK_MAX_AGE_MS constant');
  return Number(match[1]);
}

function uniqueSessionId(label) {
  return `vbtest-lock-${label}-${randomUUID()}`;
}

function writeHolderFile(lockPath, holder) {
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'holder.json'), JSON.stringify(holder), 'utf8');
}

// --- Refusal semantics ---

test('a first acquisition returns true and leaves parseable holder metadata naming process.pid', () => {
  const sessionId = uniqueSessionId('first-acquire');
  try {
    assert.equal(acquireTurnLock(sessionId), true);
    const holderPath = path.join(turnLockPathFor(sessionId), 'holder.json');
    const holder = JSON.parse(fs.readFileSync(holderPath, 'utf8'));
    assert.equal(holder.pid, process.pid);
    assert.equal(holder.sessionId, sessionId);
    assert.equal(typeof holder.acquiredAt, 'string');
  } finally {
    releaseTurnLock(sessionId);
  }
});

test('a second acquisition while the first is held returns false, with no await between the two calls', () => {
  const sessionId = uniqueSessionId('second-refused');
  try {
    const first = acquireTurnLock(sessionId);
    const second = acquireTurnLock(sessionId); // no await between these two synchronous calls
    assert.equal(first, true);
    assert.equal(second, false);
  } finally {
    releaseTurnLock(sessionId);
  }
});

test('release then acquire again succeeds', () => {
  const sessionId = uniqueSessionId('release-then-acquire');
  try {
    assert.equal(acquireTurnLock(sessionId), true);
    releaseTurnLock(sessionId);
    assert.equal(acquireTurnLock(sessionId), true);
  } finally {
    releaseTurnLock(sessionId);
  }
});

test('release of a session that holds nothing does not throw, and a second release is a no-op', () => {
  const sessionId = uniqueSessionId('release-unheld');
  assert.doesNotThrow(() => releaseTurnLock(sessionId));
  assert.equal(acquireTurnLock(sessionId), true);
  releaseTurnLock(sessionId);
  assert.doesNotThrow(() => releaseTurnLock(sessionId));
});

test('release of a different session id does not free the one actually held', () => {
  const heldId = uniqueSessionId('held');
  const otherId = uniqueSessionId('other');
  try {
    assert.equal(acquireTurnLock(heldId), true);
    releaseTurnLock(otherId);
    assert.equal(fs.existsSync(turnLockPathFor(heldId)), true, 'the held lock must still exist');
    assert.equal(acquireTurnLock(heldId), false, 'the held lock must still be refused');
  } finally {
    releaseTurnLock(heldId);
  }
});

// CR-02/WR-05: the test above only proves the final answer (false) is unchanged — it cannot
// distinguish a correct in-process guard from the pre-fix bug, where releaseTurnLock(otherId)
// unconditionally cleared heldSessionId and acquireTurnLock(heldId) then fell through to the
// filesystem layer (mkdirSync EEXIST + a live, non-stale holder) and reached the *same*
// answer by an unintended mechanism. This test proves the in-process guard directly: a third,
// never-before-seen session id, immediately after an unrelated release, must be refused with
// zero filesystem I/O — something only possible if heldSessionId still names heldId. A
// filesystem fallback for a session id whose lock artifact does not exist at all would
// instead succeed (mkdirSync has nothing to collide with), so this assertion fails outright
// under the pre-fix behavior rather than merely reaching the same boolean by accident.
test('an unrelated release does not clear the in-process guard: a brand-new session id is still refused instantly while the real lock is held', () => {
  const heldId = uniqueSessionId('held-guard');
  const otherId = uniqueSessionId('other-guard');
  const neverSeenId = uniqueSessionId('never-seen-guard');
  try {
    assert.equal(acquireTurnLock(heldId), true);
    releaseTurnLock(otherId); // never acquired by this process — must be a documented no-op
    assert.equal(
      acquireTurnLock(neverSeenId),
      false,
      'a session id with no lock artifact on disk at all must still be refused, proving the ' +
        'refusal came from the in-process guard (heldSessionId) rather than a filesystem EEXIST',
    );
    assert.equal(fs.existsSync(turnLockPathFor(neverSeenId)), false, 'no artifact was created for the refused id');
  } finally {
    releaseTurnLock(heldId);
  }
});

// CR-02: a process must never remove a lock artifact that has since become someone else's —
// e.g. this process's own lock was reclaimed as stale by another acquirer while a legitimately
// slow turn was still finishing, and this process's outer finally then calls releaseTurnLock
// for the session id it originally acquired. Simulated here by acquiring normally and then
// overwriting holder.json's token exactly as a different, successful reclaimer would (its pid
// and acquiredAt are also rewritten, since a real reclaimer's mkdirSync+write is indistinguishable
// from this at the metadata level).
test('releaseTurnLock does not remove a lock artifact whose on-disk token no longer matches what this process acquired', () => {
  const sessionId = uniqueSessionId('stolen-by-reclaim');
  const lockPath = turnLockPathFor(sessionId);
  try {
    assert.equal(acquireTurnLock(sessionId), true);

    // Simulate a different process reclaiming this same lock: a fresh pid, a fresh
    // acquiredAt, and — the detail this process's own release must catch — a different
    // token.
    fs.writeFileSync(
      path.join(lockPath, 'holder.json'),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), sessionId, token: 'not-our-token' }),
      'utf8',
    );

    assert.doesNotThrow(() => releaseTurnLock(sessionId));
    assert.equal(fs.existsSync(lockPath), true, 'the artifact belonging to the new (simulated) holder must survive');

    // The in-process guard must still clear regardless — this process is done believing it
    // holds sessionId either way, per CR-02's fix note that both pieces of state are only
    // ever changed together.
    const probeId = uniqueSessionId('probe-after-stolen-release');
    try {
      assert.equal(
        acquireTurnLock(probeId),
        true,
        'the in-process guard must be clear after release, even though the filesystem removal was skipped',
      );
    } finally {
      releaseTurnLock(probeId);
    }
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

// --- Reclaim ---

test('an artifact whose holder pid belongs to a genuinely exited process is stale and reclaimed by the next acquisition', () => {
  const sessionId = uniqueSessionId('dead-pid');
  const lockPath = turnLockPathFor(sessionId);
  try {
    // Spawn a real short-lived process synchronously and use its now-dead pid honestly —
    // an invented number could belong to a live, unrelated process and would make this
    // test assert the opposite of what it claims.
    const finished = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.ok(finished.pid > 0, 'expected the short-lived process to report a real pid');
    writeHolderFile(lockPath, { pid: finished.pid, acquiredAt: new Date().toISOString(), sessionId });

    assert.equal(isTurnLockStale(sessionId), true);
    assert.equal(acquireTurnLock(sessionId), true);
  } finally {
    releaseTurnLock(sessionId);
  }
});

test('an artifact whose holder pid is live and whose timestamp is recent refuses acquisition', () => {
  const sessionId = uniqueSessionId('live-recent');
  const lockPath = turnLockPathFor(sessionId);
  writeHolderFile(lockPath, { pid: process.pid, acquiredAt: new Date().toISOString(), sessionId });
  try {
    assert.equal(isTurnLockStale(sessionId), false);
    assert.equal(acquireTurnLock(sessionId), false);
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

test('an artifact whose holder pid is live but whose timestamp is backdated past the age ceiling is reclaimed', () => {
  const sessionId = uniqueSessionId('live-backdated');
  const lockPath = turnLockPathFor(sessionId);
  const maxAgeMs = readStaleLockMaxAgeMs();
  const backdated = new Date(Date.now() - maxAgeMs - 5000).toISOString();
  writeHolderFile(lockPath, { pid: process.pid, acquiredAt: backdated, sessionId });
  try {
    assert.equal(isTurnLockStale(sessionId), true);
    assert.equal(acquireTurnLock(sessionId), true);
  } finally {
    releaseTurnLock(sessionId);
  }
});

test('an artifact with no holder metadata and a recent modification time is not reclaimed', () => {
  const sessionId = uniqueSessionId('no-holder-recent');
  const lockPath = turnLockPathFor(sessionId);
  fs.mkdirSync(lockPath, { recursive: true });
  try {
    assert.equal(isTurnLockStale(sessionId), false);
    assert.equal(acquireTurnLock(sessionId), false);
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

test('the same no-holder artifact is reclaimed once its modification time is old enough', () => {
  const sessionId = uniqueSessionId('no-holder-old');
  const lockPath = turnLockPathFor(sessionId);
  fs.mkdirSync(lockPath, { recursive: true });
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(lockPath, old, old);
  try {
    assert.equal(isTurnLockStale(sessionId), true);
    assert.equal(acquireTurnLock(sessionId), true);
  } finally {
    releaseTurnLock(sessionId);
  }
});

test('malformed holder JSON collapses to the safe default rather than throwing', () => {
  const sessionId = uniqueSessionId('malformed-holder');
  const lockPath = turnLockPathFor(sessionId);
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'holder.json'), '{not valid json', 'utf8');
  try {
    let staleResult;
    assert.doesNotThrow(() => {
      staleResult = isTurnLockStale(sessionId);
    });
    // Recent mtime (the directory was just created) falls back to the missing-metadata
    // grace window — not reclaimed yet.
    assert.equal(staleResult, false);
    assert.doesNotThrow(() => acquireTurnLock(sessionId));
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

// --- CR-01: cross-process reclaim race ---
//
// test/turn-lock-concurrency.test.js's own fork test only races two processes for a *fresh*
// lock (mkdirSync EEXIST alone as the arbiter). CR-01's actual defect was in the *reclaim*
// path — two processes independently observing the same *stale* lock, each running
// rmSync-then-mkdirSync with nothing atomic between the two calls, could both come away
// believing they held it. This test seeds one genuinely stale lock (a dead pid, using a real
// short-lived process's own now-exited pid, same honesty requirement as the in-process
// dead-pid test above) and races two forked OS processes to reclaim it, reusing the same
// fork mechanics test/turn-lock-concurrency.test.js established: execArgv: [] so neither
// child inherits node --test's own flags and gets relaunched under the test runner's IPC
// protocol, a two-phase ready/go handshake so both attempts land as close together as the
// platform allows, and the winner releasing before it reports its result so the parent's
// message receipt is a valid happens-after guarantee that the release already ran.
test('two forked processes racing to reclaim the same stale lock produce exactly one winner', async () => {
  const sessionId = uniqueSessionId('cross-process-reclaim');
  const lockPath = turnLockPathFor(sessionId);
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-lock-reclaim-fork-'));
  const scriptPath = path.join(scriptDir, 'reclaim-race-child.mjs');
  const lockModuleUrl = new URL('../packages/shared/session/turn-lock.js', import.meta.url).href;

  // A real, now-exited process's own pid — an invented number could belong to a live,
  // unrelated process on this host and would make isTurnLockStale (and therefore this whole
  // test) assert the opposite of what it claims.
  const finished = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(finished.pid > 0, 'expected the short-lived process to report a real pid');
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(
    path.join(lockPath, 'holder.json'),
    JSON.stringify({ pid: finished.pid, acquiredAt: new Date().toISOString(), sessionId, token: 'stale-token' }),
    'utf8',
  );
  assert.equal(isTurnLockStale(sessionId), true, 'sanity: the seeded lock must actually be stale before racing it');

  const childScript = `
import { acquireTurnLock, releaseTurnLock } from ${JSON.stringify(lockModuleUrl)};

process.once('message', (msg) => {
  if (msg !== 'go') return;
  let acquired = false;
  let errorMessage = null;
  try {
    acquired = acquireTurnLock(${JSON.stringify(sessionId)});
  } catch (err) {
    errorMessage = err.message;
  }
  if (acquired) {
    releaseTurnLock(${JSON.stringify(sessionId)});
  }
  process.send({ acquired, errorMessage });
  process.exit(0);
});

process.send('ready');
`;
  fs.writeFileSync(scriptPath, childScript, 'utf8');

  const forkOptions = { stdio: 'ignore', execArgv: [] };
  const children = [];
  try {
    children.push(fork(scriptPath, [], forkOptions), fork(scriptPath, [], forkOptions));

    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve, reject) => {
            child.once('message', (msg) => {
              if (msg === 'ready') resolve();
              else reject(new Error(`unexpected first message from child: ${JSON.stringify(msg)}`));
            });
            child.once('error', reject);
          }),
      ),
    );

    const results = await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve, reject) => {
            child.once('message', resolve);
            child.once('error', reject);
            child.send('go');
          }),
      ),
    );

    const successes = results.filter((r) => r.acquired === true);
    const failures = results.filter((r) => r.acquired === false);

    // If two racing reclaimers can both come away believing they hold the lock, this is
    // exactly the mutual-exclusion break CR-01 describes — must never be weakened to pass.
    assert.equal(successes.length, 1, `expected exactly one reclaim winner, got ${JSON.stringify(results)}`);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].errorMessage, null, 'the losing reclaimer must report a plain refusal, not throw');
    assert.equal(fs.existsSync(lockPath), false, 'the winner must have released before exiting');
  } finally {
    for (const child of children) {
      child.kill();
    }
    fs.rmSync(scriptDir, { recursive: true, force: true });
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

// CR-01b: the fork race above is the honest end-to-end proof, but it can only ever *observe*
// the window — two real processes either hit it or they do not. CI found it exactly once while
// 25 consecutive local runs of that same test never did, so it is not a regression guard: a
// reverted fix would sail past it almost every time. These two tests *force* the interleaving
// instead of racing for it, so the guarantee is asserted deterministically on every run.
//
// The seam is the node:fs default export. turn-lock.js reaches fs.renameSync and fs.mkdirSync
// by property lookup at call time, so replacing one of those properties for the duration of a
// single acquireTurnLock call injects a preemption at the exact instruction the defect lived
// at — no test hook in production source, and nothing about what acquireTurnLock does is
// altered. Each patch fires at most once, keys on the specific path being operated on, restores
// the real implementation immediately after the call, and restores it again from a finally.

// The defect itself: a reclaimer forms its staleness verdict about one directory, and by the
// time its rename runs, a faster reclaimer has finished and the lock *path* names that
// reclaimer's brand-new live directory instead. The rename succeeds — POSIX rename is atomic
// per path, not per directory — and pre-fix the loser went on to destroy the winner's lock and
// report success, leaving two processes each believing they held the turn. The injected work
// below is exactly what that faster reclaimer would have done in the gap.
test('a reclaimer whose stale directory is replaced mid-steal refuses, leaving the faster reclaimer untouched', () => {
  const sessionId = uniqueSessionId('reclaim-identity-swap');
  const lockPath = turnLockPathFor(sessionId);
  const realRenameSync = fs.renameSync;
  const winnerToken = `winner-${randomUUID()}`;
  let injectionFired = false;

  // A real, now-exited pid — same honesty requirement as every other reclaim fixture here.
  const finished = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(finished.pid > 0, 'expected the short-lived process to report a real pid');
  writeHolderFile(lockPath, {
    pid: finished.pid,
    acquiredAt: new Date().toISOString(),
    sessionId,
    token: 'stale-token',
  });
  assert.equal(isTurnLockStale(sessionId), true, 'sanity: the seeded directory must actually be stale before it is raced');
  const staleIno = fs.statSync(lockPath, { bigint: true }).ino;

  try {
    fs.renameSync = function (oldPath, newPath) {
      // Once, and only on the steal of the lock path itself: the injected reclaim's own rename
      // and the losing reclaimer's restore must both reach the real implementation.
      if (!injectionFired && oldPath === lockPath) {
        injectionFired = true;
        const winnerScratch = `${lockPath}.reclaim-winner`;
        realRenameSync.call(fs, lockPath, winnerScratch);
        fs.rmSync(winnerScratch, { recursive: true, force: true });
        fs.mkdirSync(lockPath);
        // process.pid, because the faster reclaimer is alive: its lock is emphatically not stale.
        fs.writeFileSync(
          path.join(lockPath, 'holder.json'),
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), sessionId, token: winnerToken }),
          'utf8',
        );
      }
      return realRenameSync.call(fs, oldPath, newPath);
    };

    const acquired = acquireTurnLock(sessionId);
    fs.renameSync = realRenameSync;

    assert.equal(injectionFired, true, 'sanity: the interleaving must actually have been injected into the steal');
    assert.notEqual(
      fs.statSync(lockPath, { bigint: true }).ino,
      staleIno,
      'sanity: the injected reclaim must really have replaced the directory, not merely rewritten its metadata',
    );
    assert.equal(
      acquired,
      false,
      'a steal that took a different directory than the one judged stale must report busy — winning the rename ' +
        'proves only THAT this process won the path, never WHAT it won',
    );
    const holder = JSON.parse(fs.readFileSync(path.join(lockPath, 'holder.json'), 'utf8'));
    assert.equal(holder.token, winnerToken, "the faster reclaimer's live lock must survive the losing reclaimer untouched");
  } finally {
    fs.renameSync = realRenameSync;
    releaseTurnLock(sessionId);
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

// The *ordering* the fix above depends on, pinned separately. Capturing the directory identity
// and forming the staleness verdict are two reads of the same path, and only one order is safe:
// identity first. Reverse them and a swap landing in between hands the reclaimer a verdict about
// the old directory together with an identity captured from its live replacement — the two agree,
// the comparison passes, and the reclaimer destroys a live lock while believing it did everything
// right. The previous test cannot see that, because its injection fires at the rename, by which
// point both orderings have already captured the same identity; a mutation swapping the two lines
// survives it. This injection fires *inside* the staleness verdict instead: fs.readFileSync
// returns the stale metadata the verdict is entitled to, and the faster reclaimer completes in the
// instant after that read. Only identity-captured-first refuses here.
test('a reclaimer captures directory identity before forming its staleness verdict, not after', () => {
  const sessionId = uniqueSessionId('reclaim-verdict-ordering');
  const lockPath = turnLockPathFor(sessionId);
  const holderPath = path.join(lockPath, 'holder.json');
  const realReadFileSync = fs.readFileSync;
  const winnerToken = `winner-${randomUUID()}`;
  let injectionFired = false;

  const finished = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.ok(finished.pid > 0, 'expected the short-lived process to report a real pid');
  writeHolderFile(lockPath, {
    pid: finished.pid,
    acquiredAt: new Date().toISOString(),
    sessionId,
    token: 'stale-token',
  });
  assert.equal(isTurnLockStale(sessionId), true, 'sanity: the seeded directory must actually be stale before it is raced');
  const staleIno = fs.statSync(lockPath, { bigint: true }).ino;

  try {
    // Installed only now, so the sanity check above reads the fixture undisturbed. Keyed on this
    // session's own holder.json and fires once, so no other read in the process is affected.
    fs.readFileSync = function (target, options) {
      if (!injectionFired && target === holderPath) {
        injectionFired = true;
        const staleMetadata = realReadFileSync.call(fs, target, options);
        const winnerScratch = `${lockPath}.reclaim-winner`;
        fs.renameSync(lockPath, winnerScratch);
        fs.rmSync(winnerScratch, { recursive: true, force: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(
          holderPath,
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), sessionId, token: winnerToken }),
          'utf8',
        );
        // The verdict still sees what it read before the swap — which is the whole point.
        return staleMetadata;
      }
      return realReadFileSync.call(fs, target, options);
    };

    const acquired = acquireTurnLock(sessionId);
    fs.readFileSync = realReadFileSync;

    assert.equal(injectionFired, true, 'sanity: the interleaving must actually have been injected into the staleness verdict');
    assert.notEqual(
      fs.statSync(lockPath, { bigint: true }).ino,
      staleIno,
      'sanity: the injected reclaim must really have replaced the directory mid-verdict',
    );
    assert.equal(
      acquired,
      false,
      'identity must be captured before the staleness verdict: capturing it afterwards reads it from the ' +
        'live replacement, so the comparison agrees with itself and authorises destroying a live lock',
    );
    const holder = JSON.parse(realReadFileSync.call(fs, holderPath, 'utf8'));
    assert.equal(holder.token, winnerToken, "the faster reclaimer's live lock must survive untouched");
  } finally {
    fs.readFileSync = realReadFileSync;
    releaseTurnLock(sessionId);
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

// The counterpart guard, at the other end of the same window. A losing reclaimer restores the
// rightful holder's directory over the placeholder it created, and that restore can land on top
// of a third acquirer's brand-new empty directory in the one-syscall gap between that acquirer's
// own create and its metadata write. Without an exclusive create, the third acquirer would then
// write holder.json straight into the restored holder's directory and come away believing it
// holds a lock that is demonstrably someone else's — the same mutual-exclusion break by a longer
// route. Forced here by injecting the replacement at exactly that instruction.
test('an acquirer whose new lock directory is replaced before it writes metadata refuses instead of overwriting the holder', () => {
  const sessionId = uniqueSessionId('holder-write-usurped');
  const lockPath = turnLockPathFor(sessionId);
  const realMkdirSync = fs.mkdirSync;
  const rightfulToken = `rightful-${randomUUID()}`;
  let injectionFired = false;

  try {
    fs.mkdirSync = function (dirPath, options) {
      const result = realMkdirSync.call(fs, dirPath, options);
      // Keyed on the lock path, so the lock-root create that precedes it is left alone.
      if (!injectionFired && dirPath === lockPath) {
        injectionFired = true;
        fs.rmSync(lockPath, { recursive: true, force: true });
        realMkdirSync.call(fs, lockPath);
        fs.writeFileSync(
          path.join(lockPath, 'holder.json'),
          JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), sessionId, token: rightfulToken }),
          'utf8',
        );
      }
      return result;
    };

    const acquired = acquireTurnLock(sessionId);
    fs.mkdirSync = realMkdirSync;

    assert.equal(injectionFired, true, 'sanity: the replacement must actually have been injected before the write');
    assert.equal(acquired, false, 'an acquirer must report busy once the directory at the path is no longer the one it created');
    const holder = JSON.parse(fs.readFileSync(path.join(lockPath, 'holder.json'), 'utf8'));
    assert.equal(holder.token, rightfulToken, "the live holder's metadata must not have been overwritten by the refused acquirer");
  } finally {
    fs.mkdirSync = realMkdirSync;
    releaseTurnLock(sessionId);
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
});

// --- No waiting anywhere ---

test('source scan: turn-lock.js contains no timer, no promise-returning filesystem call, and no while loop', () => {
  // Strip // comments before scanning — the module's own prose deliberately discusses
  // "await" and "async" as English words (documenting why the module must never use them),
  // which would otherwise false-positive this scan.
  const codeOnly = TURN_LOCK_SOURCE.replace(/\/\/.*$/gm, '');
  assert.ok(!/setTimeout|setInterval/.test(codeOnly), 'must not use a timer');
  assert.ok(!/fs\.promises/.test(codeOnly), 'must not use the promise-returning fs API');
  assert.ok(!/\bawait\b/.test(codeOnly), 'must not await anything — every filesystem call is synchronous');
  assert.ok(!/\bwhile\s*\(/.test(codeOnly), 'must not contain a while loop');
});

test('source scan: exactly two lock-directory creation attempts exist — the initial try and the single reclaim attempt, neither inside a loop', () => {
  const mkdirLockAttempts = [...TURN_LOCK_SOURCE.matchAll(/fs\.mkdirSync\(lockPath\)/g)];
  assert.equal(mkdirLockAttempts.length, 2);
});

test('STALE_LOCK_MAX_AGE_MS read from the source is strictly greater than 420000', () => {
  assert.ok(readStaleLockMaxAgeMs() > 420000);
});

test('session-id validation still rejects a separator-bearing id after this change', () => {
  assert.throws(() => acquireTurnLock('a/b'));
  assert.throws(() => releaseTurnLock('a/b'));
  assert.throws(() => isTurnLockStale('a/b'));
});
