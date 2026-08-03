// Plan 02-03, Task 3: closes OPS-02 across every outcome the other test files do not each
// cover — withTempDir exercised directly across success, throw, rejection and abort, plus
// turn-level hygiene across six distinct outcomes (success, a throw from each of the three
// adapters, a guard-clause refusal, and a busy refusal), a zero-length buffer, back-to-back
// directory distinctness, and several-at-once concurrency. Every test that acquires a lock
// uses a session id unique to itself and releases in a finally, same discipline as
// test/turn-pipeline.test.js and test/turn-pipeline-abort.test.js.
//
// None of these hygiene assertions diff a shared, process-wide directory listing.
// `node --test` runs test files in parallel by default, and this file's own sibling
// (test/turn-pipeline-abort.test.js) also drives real runTurn() calls under the same shared
// TEMP_DIR_PREFIX — deferred-items.md documents the exact same class of race for
// test/turn-pipeline.test.js from plan 02-01, where a bare before/after snapshot of that
// shared listing can catch another concurrently-running file's own transient entry and fail
// for a reason that has nothing to do with the test itself. Every outcome that creates a
// directory instead captures *its own* path from inside the transcribe adapter (the one
// place the pipeline hands it out) and asserts on that specific path; every outcome that
// creates no directory at all asserts a zero adapter call count instead — the deterministic,
// non-racy proof plan 02-02 established for the identical problem in
// test/turn-lock-concurrency.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { withTempDir } from '../packages/shared/lifecycle/tempfiles.js';
import { runTurn } from '../packages/shared/pipeline/turn-pipeline.js';
import { acquireTurnLock, releaseTurnLock } from '../packages/shared/session/turn-lock.js';

function uniqueSessionId(label) {
  return `vbtest-tempfiles-${label}-${randomUUID()}`;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// --- withTempDir on its own ---

test('withTempDir returns the callback\'s resolved value and removes the directory', async () => {
  let capturedDir;
  const result = await withTempDir('vbtest-tempfiles-basic-', async (dir) => {
    capturedDir = dir;
    assert.ok(fs.existsSync(dir));
    return 'callback-value';
  });
  assert.equal(result, 'callback-value');
  assert.equal(fs.existsSync(capturedDir), false);
});

test('withTempDir removes the directory and re-raises the original error unchanged when the callback throws synchronously', async () => {
  let capturedDir;
  const boom = new Error('callback exploded');
  await assert.rejects(
    () =>
      withTempDir('vbtest-tempfiles-throw-', async (dir) => {
        capturedDir = dir;
        throw boom;
      }),
    (err) => err === boom,
  );
  assert.equal(fs.existsSync(capturedDir), false);
});

test('withTempDir removes the directory and re-raises the original rejection unchanged when the callback rejects', async () => {
  let capturedDir;
  const boom = new Error('callback rejected');
  await assert.rejects(
    () =>
      withTempDir('vbtest-tempfiles-reject-', (dir) => {
        capturedDir = dir;
        return Promise.reject(boom);
      }),
    (err) => err === boom,
  );
  assert.equal(fs.existsSync(capturedDir), false);
});

test('withTempDir removes the directory and re-raises unchanged when the callback rejects because a signal it was given aborted', async () => {
  let capturedDir;
  const controller = new AbortController();
  await assert.rejects(
    () =>
      withTempDir('vbtest-tempfiles-abort-', async (dir) => {
        capturedDir = dir;
        controller.abort();
        const abortError = new Error('the operation was aborted');
        abortError.name = 'AbortError';
        throw abortError;
      }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(fs.existsSync(capturedDir), false);
  assert.equal(controller.signal.aborted, true);
});

test('withTempDir does not throw when the callback has already removed the directory itself', async () => {
  const result = await withTempDir('vbtest-tempfiles-self-clean-', async (dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    return 'ok';
  });
  assert.equal(result, 'ok');
});

test('two concurrent withTempDir calls with the same prefix receive two different directories, and neither can observe or remove the other\'s', async () => {
  const gate = createDeferred();
  let dirA;
  let dirB;

  const pA = withTempDir('vbtest-tempfiles-concurrent-', async (dir) => {
    dirA = dir;
    await gate.promise;
    return 'a';
  });
  const pB = withTempDir('vbtest-tempfiles-concurrent-', async (dir) => {
    dirB = dir;
    return 'b';
  });

  const resultB = await pB;
  assert.equal(resultB, 'b');
  assert.ok(dirA, 'dirA must have been assigned before b resolved');
  assert.notEqual(dirA, dirB, 'two concurrent calls with the same prefix must receive two different directories');
  assert.equal(fs.existsSync(dirB), false, 'b\'s own directory must be removed after b resolves');
  assert.equal(fs.existsSync(dirA), true, 'a\'s directory must be untouched by b\'s cleanup while a is still in flight');

  gate.resolve();
  const resultA = await pA;
  assert.equal(resultA, 'a');
  assert.equal(fs.existsSync(dirA), false);
});

// --- Turn-level hygiene across six outcomes ---

test('temp hygiene: a successful turn creates a real directory and removes it', async () => {
  const sessionId = uniqueSessionId('outcome-success');
  let createdDir;
  const adapters = {
    transcribe: async (audioPath) => {
      createdDir = path.dirname(audioPath);
      assert.ok(fs.existsSync(createdDir), 'the directory must exist while the transcribe stage runs');
      return { text: 'hello', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'OK', meta: {} }),
    speak: async () => ({ audioBuffer: Buffer.from('fake-audio'), mimeType: 'audio/mp4', meta: {} }),
  };

  await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
  });

  assert.ok(createdDir, 'expected the transcribe adapter to have captured a real directory');
  assert.equal(fs.existsSync(createdDir), false, 'the directory must be removed after a successful turn');
});

test('temp hygiene: a turn whose transcribe adapter throws still removes its own directory', async () => {
  const sessionId = uniqueSessionId('outcome-transcribe-throws');
  let createdDir;
  const adapters = {
    transcribe: async (audioPath) => {
      createdDir = path.dirname(audioPath);
      throw new Error('transcribe exploded');
    },
    agent: async () => ({ text: 'x', rawText: 'x', meta: {} }),
    speak: async () => ({ audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} }),
  };

  await assert.rejects(() =>
    runTurn({
      audioBuffer: Buffer.from('bytes'),
      adapters,
      sttConfig: {},
      openclawConfig: { sessionId },
      ttsConfig: {},
    }),
  );

  assert.ok(createdDir);
  assert.equal(fs.existsSync(createdDir), false);
});

test('temp hygiene: a turn whose agent adapter throws still removes its own directory', async () => {
  const sessionId = uniqueSessionId('outcome-agent-throws');
  let createdDir;
  const adapters = {
    transcribe: async (audioPath) => {
      createdDir = path.dirname(audioPath);
      return { text: 'hi', meta: {} };
    },
    agent: async () => {
      throw new Error('agent exploded');
    },
    speak: async () => ({ audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} }),
  };

  await assert.rejects(() =>
    runTurn({
      audioBuffer: Buffer.from('bytes'),
      adapters,
      sttConfig: {},
      openclawConfig: { sessionId },
      ttsConfig: {},
    }),
  );

  assert.ok(createdDir);
  assert.equal(fs.existsSync(createdDir), false);
});

test('temp hygiene: a turn whose speak adapter throws still removes its own directory', async () => {
  const sessionId = uniqueSessionId('outcome-speak-throws');
  let createdDir;
  const adapters = {
    transcribe: async (audioPath) => {
      createdDir = path.dirname(audioPath);
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'OK', meta: {} }),
    speak: async () => {
      throw new Error('speak exploded');
    },
  };

  await assert.rejects(() =>
    runTurn({
      audioBuffer: Buffer.from('bytes'),
      adapters,
      sttConfig: {},
      openclawConfig: { sessionId },
      ttsConfig: {},
    }),
  );

  assert.ok(createdDir);
  assert.equal(fs.existsSync(createdDir), false);
});

test('temp hygiene: a turn refused by a guard clause never reaches the transcribe stage, so no directory is ever created', async () => {
  // A guard-clause refusal happens synchronously, before withTempDir's own mkdtempSync — a
  // shared-prefix listing snapshot around this call is a near-zero-width window in principle,
  // but "near-zero" still isn't zero under node --test's parallel file execution (a sibling
  // file can legitimately create and remove its own entry inside any window, however small).
  // transcribeCallCount is the deterministic proxy 02-02 established for exactly this case:
  // withTempDir's mkdtempSync is its own first statement, and transcribe is the first adapter
  // call inside its callback, so a call count staying at 0 is a structural proof no directory
  // was ever created — immune to any concurrent sibling file's own unrelated activity.
  let transcribeCallCount = 0;
  const adapters = {
    transcribe: async () => {
      transcribeCallCount += 1;
      return { text: 'unused', meta: {} };
    },
    agent: async () => ({ text: 'unused', rawText: 'unused', meta: {} }),
    speak: async () => ({ audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} }),
  };

  await assert.rejects(() =>
    runTurn({
      audioBuffer: Buffer.from('bytes'),
      adapters,
      sttConfig: {},
      openclawConfig: { sessionId: '' },
      ttsConfig: {},
    }),
  );

  assert.equal(transcribeCallCount, 0);
});

test('temp hygiene: a turn refused as busy never reaches the transcribe stage, so no directory is ever created', async () => {
  const sessionId = uniqueSessionId('outcome-busy');
  assert.ok(acquireTurnLock(sessionId));
  try {
    let transcribeCallCount = 0;
    const adapters = {
      transcribe: async () => {
        transcribeCallCount += 1;
        return { text: 'unused', meta: {} };
      },
      agent: async () => ({ text: 'unused', rawText: 'unused', meta: {} }),
      speak: async () => ({ audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} }),
    };

    await assert.rejects(
      () =>
        runTurn({
          audioBuffer: Buffer.from('bytes'),
          adapters,
          sttConfig: {},
          openclawConfig: { sessionId },
          ttsConfig: {},
        }),
      (err) => err.code === 'TURN_BUSY',
    );

    assert.equal(transcribeCallCount, 0);
  } finally {
    releaseTurnLock(sessionId);
  }
});

// --- Empty input ---

test('a zero-length audio buffer still produces a real directory that is removed, and the transcribe adapter receives a real path to a zero-length file', async () => {
  const sessionId = uniqueSessionId('zero-length');
  let observedSize;
  let observedPathExists;
  let createdDir;
  const adapters = {
    transcribe: async (audioPath) => {
      createdDir = path.dirname(audioPath);
      observedPathExists = fs.existsSync(audioPath);
      observedSize = fs.statSync(audioPath).size;
      return { text: 'x', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'OK', meta: {} }),
    speak: async () => ({ audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} }),
  };

  await runTurn({
    audioBuffer: Buffer.alloc(0),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });

  assert.equal(observedPathExists, true, 'the transcribe adapter must receive a real, existing file path');
  assert.equal(observedSize, 0, 'the file backing a zero-length audio buffer must itself be zero-length');
  assert.ok(createdDir);
  assert.equal(fs.existsSync(createdDir), false, 'the directory must be removed even for a zero-length buffer');
});

// --- Adjacency: two turns never collide on a directory name ---

test('two back-to-back turns hand their transcribe adapters two different directory paths, both removed', async () => {
  const sessionId = uniqueSessionId('back-to-back');
  const capturedDirs = [];
  const adapters = {
    transcribe: async (audioPath) => {
      capturedDirs.push(path.dirname(audioPath));
      return { text: 'x', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'OK', meta: {} }),
    speak: async () => ({ audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} }),
  };

  await runTurn({
    audioBuffer: Buffer.from('one'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });
  await runTurn({
    audioBuffer: Buffer.from('two'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });

  assert.equal(capturedDirs.length, 2);
  assert.notEqual(capturedDirs[0], capturedDirs[1], 'a second turn must never reuse the first turn\'s directory name');
  assert.equal(fs.existsSync(capturedDirs[0]), false);
  assert.equal(fs.existsSync(capturedDirs[1]), false);
});

// --- Concurrency: several turns launched at once ---

test('several turns launched at once against one session each remove their own directory, whichever won the lock', async () => {
  const sessionId = uniqueSessionId('several-at-once');
  const capturedDirs = [];
  const adapters = {
    transcribe: async (audioPath) => {
      capturedDirs.push(path.dirname(audioPath));
      return { text: 'hello', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'OK', meta: {} }),
    speak: async () => ({ audioBuffer: Buffer.from('fake-audio'), mimeType: 'audio/mp4', meta: {} }),
  };

  // Launched without awaiting individually, then settled together — the point of this
  // assertion is that every directory a winner created is gone afterward, not which caller
  // happened to win the lock.
  const outcomes = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      runTurn({
        audioBuffer: Buffer.from('bytes'),
        adapters,
        sttConfig: {},
        openclawConfig: { sessionId },
        ttsConfig: {},
        wantAudio: false,
      }),
    ),
  );

  const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
  const rejected = outcomes.filter((o) => o.status === 'rejected');
  assert.ok(fulfilled.length >= 1, 'at least one turn must win the lock');
  for (const outcome of rejected) {
    assert.equal(outcome.reason?.code, 'TURN_BUSY', 'every loser must be refused as busy, never anything else');
  }

  assert.equal(capturedDirs.length, fulfilled.length, 'only a turn that actually won the lock reaches the transcribe stage');
  for (const dir of capturedDirs) {
    assert.equal(fs.existsSync(dir), false, `${dir} must be removed after the turn that created it settles`);
  }
});
