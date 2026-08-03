// Refusal semantics, idempotent release, and stale-lock reclaim for the mkdirSync-based
// single-flight turn lock. Every test uses a session id unique to itself and cleans up in a
// finally, because `node --test` runs test files in parallel child processes and the lock is
// a real filesystem artifact they all share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
