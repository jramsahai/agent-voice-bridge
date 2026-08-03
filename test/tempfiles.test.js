// Plan 02-03, Task 3: closes OPS-02 across every outcome the other test files do not each
// cover — withTempDir exercised directly across success, throw, rejection and abort, plus
// turn-level hygiene across six distinct outcomes (success, a throw from each of the three
// adapters, a guard-clause refusal, and a busy refusal), a zero-length buffer, back-to-back
// directory distinctness, and several-at-once concurrency. Every test that acquires a lock
// uses a session id unique to itself and releases in a finally, same discipline as
// test/turn-pipeline.test.js and test/turn-pipeline-abort.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { withTempDir } from '../packages/shared/lifecycle/tempfiles.js';
import { runTurn } from '../packages/shared/pipeline/turn-pipeline.js';
import { acquireTurnLock, releaseTurnLock } from '../packages/shared/session/turn-lock.js';

// Read turn-pipeline.js's own temp-directory prefix from its source text (regex, not a new
// export) so these hygiene assertions can never drift from the real value — same convention
// test/turn-pipeline.test.js and test/turn-pipeline-abort.test.js already use.
const PIPELINE_SOURCE_URL = new URL('../packages/shared/pipeline/turn-pipeline.js', import.meta.url);
const PIPELINE_SOURCE = fs.readFileSync(PIPELINE_SOURCE_URL, 'utf8');

function readTempDirPrefix() {
  const match = PIPELINE_SOURCE.match(/TEMP_DIR_PREFIX\s*=\s*'([^']+)'/);
  assert.ok(match, 'turn-pipeline.js must declare a documented TEMP_DIR_PREFIX constant');
  return match[1];
}

function listMatchingTempEntries(prefix) {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix));
}

function uniqueSessionId(label) {
  return `vbtest-tempfiles-${label}-${randomUUID()}`;
}

function makeFakes({ transcript = 'hello', rawReply = 'ok', speechText = 'ok' } = {}) {
  const transcribe = async () => ({ text: transcript, meta: {} });
  const agent = async () => ({ text: speechText, rawText: rawReply, meta: {} });
  const speak = async () => ({ audioBuffer: Buffer.from('fake-audio'), mimeType: 'audio/mp4', meta: {} });
  return { adapters: { transcribe, agent, speak } };
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

test('temp hygiene: the pipeline temp-prefix entry set is unchanged across a successful turn', async () => {
  const sessionId = uniqueSessionId('outcome-success');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const { adapters } = makeFakes();

  await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
  });

  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('temp hygiene: the pipeline temp-prefix entry set is unchanged across a turn whose transcribe adapter throws', async () => {
  const sessionId = uniqueSessionId('outcome-transcribe-throws');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const adapters = {
    transcribe: async () => {
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

  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('temp hygiene: the pipeline temp-prefix entry set is unchanged across a turn whose agent adapter throws', async () => {
  const sessionId = uniqueSessionId('outcome-agent-throws');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const adapters = {
    transcribe: async () => ({ text: 'hi', meta: {} }),
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

  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('temp hygiene: the pipeline temp-prefix entry set is unchanged across a turn whose speak adapter throws', async () => {
  const sessionId = uniqueSessionId('outcome-speak-throws');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const adapters = {
    transcribe: async () => ({ text: 'hi', meta: {} }),
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

  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('temp hygiene: the pipeline temp-prefix entry set is unchanged across a turn refused by a guard clause', async () => {
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const { adapters } = makeFakes();

  await assert.rejects(() =>
    runTurn({
      audioBuffer: Buffer.from('bytes'),
      adapters,
      sttConfig: {},
      openclawConfig: { sessionId: '' },
      ttsConfig: {},
    }),
  );

  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('temp hygiene: the pipeline temp-prefix entry set is unchanged across a turn refused as busy', async () => {
  const sessionId = uniqueSessionId('outcome-busy');
  const prefix = readTempDirPrefix();
  assert.ok(acquireTurnLock(sessionId));
  try {
    const before = listMatchingTempEntries(prefix);
    const { adapters } = makeFakes();

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

    assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
  } finally {
    releaseTurnLock(sessionId);
  }
});

// --- Empty input ---

test('a zero-length audio buffer still produces a directory that is removed, and the transcribe adapter receives a real path to a zero-length file', async () => {
  const sessionId = uniqueSessionId('zero-length');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  let observedSize;
  let observedPathExists;
  const adapters = {
    transcribe: async (audioPath) => {
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
  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

// --- Adjacency: two turns never collide on a directory name ---

test('two back-to-back turns hand their transcribe adapters two different directory paths', async () => {
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
});

// --- Concurrency: several turns launched at once ---

test('several turns launched at once against one session leave the entry set exactly as they found it, whichever won the lock', async () => {
  const sessionId = uniqueSessionId('several-at-once');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const { adapters } = makeFakes();

  // Launched without awaiting individually, then settled together — the point of this
  // assertion is the entry set, not which caller happened to win the lock.
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

  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});
