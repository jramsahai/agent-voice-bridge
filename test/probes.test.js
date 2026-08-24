// DEBT-03 regression pin: probeExecutable used two synchronous fs.accessSync calls (the
// path-separator branch and the PATH-walk loop), which blocked the event loop for the whole
// walk on every health-probe cache miss — the one code path whose entire purpose is to
// answer quickly whether a backend is reachable. This file pins the promise-based rewrite.
//
// probes.js has no test file of its own until this one; its two pre-existing behaviour
// assertions (resolves for a real executable, rejects by name for one that resolves nowhere)
// stay in test/tts-kokoro-onnx.test.js per this plan's explicit instruction — not relocated
// here. This file adds only the new non-blocking pins plus a source-level guard against a
// synchronous filesystem call creeping back in.
//
// Makes no network call and spawns no process — the two probes here only ever touch the
// filesystem, and the second one is a text scan of probes.js itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeExecutable } from '../packages/shared/health/probes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Exhaustively drains the microtask queue without ever letting the event loop advance into
// the poll phase — awaiting an already-resolved promise inside an async function only
// schedules and runs microtasks. A promise that can only settle after a real filesystem
// round trip cannot settle during this loop, while the pre-fix implementation's synchronous
// throw (which makes the returned promise already-rejected the moment it is created) settles
// on the very first iteration. This is why the technique needs no wall-clock threshold and
// cannot become a flaky timing test.
async function drainMicrotasks(iterations = 100) {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

test('probeExecutable does not settle within a drained microtask queue for a nonexistent absolute path (path-separator branch)', async () => {
  let settled = false;
  // Attached as a side effect only — asserting rejection later against `original` itself,
  // not against this .then() chain, because a .then(onFulfilled, onRejected) that does not
  // rethrow inside onRejected always produces a promise that RESOLVES, regardless of whether
  // the source promise rejected.
  const original = probeExecutable('/a/path/that/does/not/exist');
  original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await drainMicrotasks();
  assert.equal(
    settled,
    false,
    'the promise must not settle purely from draining microtasks — it must reach a real filesystem round trip first',
  );

  await assert.rejects(() => original);
});

test('probeExecutable does not settle within a drained microtask queue for a bare command name that resolves nowhere (PATH-walk branch)', async () => {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  assert.ok(
    pathEntries.length > 0,
    'sanity: PATH must split into at least one entry for the PATH-walk loop body to run at all',
  );

  let settled = false;
  const original = probeExecutable('this-command-does-not-exist-anywhere-xyz');
  original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await drainMicrotasks();
  assert.equal(
    settled,
    false,
    'the PATH-walk branch must not settle purely from draining microtasks either',
  );

  await assert.rejects(() => original);
});

test('probeExecutable resolves for a real absolute executable and rejects by name for a command that resolves nowhere', async () => {
  await assert.doesNotReject(() => probeExecutable(process.execPath));
  await assert.rejects(
    () => probeExecutable('this-command-does-not-exist-anywhere-xyz'),
    (err) => {
      assert.ok(err.message.includes('this-command-does-not-exist-anywhere-xyz'));
      return true;
    },
  );
});

test('probes.js contains no synchronous filesystem call', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'packages', 'shared', 'health', 'probes.js'), 'utf8');
  const codeOnly = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  // Built via concatenation, not written as a literal substring, so this scan (which reads
  // its own file among those test/convert.test.js's Phase 1 offline scan walks) never flags
  // itself, and a future doc comment mentioning the old API cannot silently re-satisfy it.
  const syncFsToken = ['access', 'Sync'].join('');
  assert.ok(!codeOnly.includes(syncFsToken), 'probes.js must not contain a synchronous filesystem call');
});

// WR-01: a guard at the top of probeExecutable now throws for empty strings and non-strings
// before the path-separator branch can degenerate into checking a PATH directory's own
// traversability. Previously probeExecutable('') resolved as reachable because path.join(dir, '')
// collapsed to a traversable PATH directory.
test('WR-01: probeExecutable rejects an empty string with the guard message', async () => {
  await assert.rejects(
    () => probeExecutable(''),
    (err) => {
      assert.equal(err.message, 'probeExecutable: command must be a non-empty string');
      return true;
    },
  );
});

test('WR-01: probeExecutable rejects null with the guard message', async () => {
  await assert.rejects(
    () => probeExecutable(null),
    (err) => {
      assert.equal(err.message, 'probeExecutable: command must be a non-empty string');
      return true;
    },
  );
});

test('WR-01: probeExecutable rejects undefined with the guard message', async () => {
  await assert.rejects(
    () => probeExecutable(undefined),
    (err) => {
      assert.equal(err.message, 'probeExecutable: command must be a non-empty string');
      return true;
    },
  );
});

test('WR-01: probeExecutable rejects a number with the guard message', async () => {
  await assert.rejects(
    () => probeExecutable(0),
    (err) => {
      assert.equal(err.message, 'probeExecutable: command must be a non-empty string');
      return true;
    },
  );
});

test('WR-01: probeExecutable rejects an object with the guard message', async () => {
  await assert.rejects(
    () => probeExecutable({}),
    (err) => {
      assert.equal(err.message, 'probeExecutable: command must be a non-empty string');
      return true;
    },
  );
});

test('WR-01: the guard does not shadow the existing behavior for valid absolute executables and bare PATH commands', async () => {
  // The four existing tests in this file verify this, but assert it here as explicit evidence
  // that the guard does not affect them
  await assert.doesNotReject(() => probeExecutable(process.execPath));
  await assert.rejects(() => probeExecutable('this-command-does-not-exist-anywhere-xyz'));
});
