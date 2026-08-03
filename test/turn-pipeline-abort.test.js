// Plan 02-03: proves a vanished caller costs nothing — the real child process the current
// stage is waiting on genuinely dies, the lock and temp directory release within the turn
// rather than at an adapter's timeout, and between-stage aborts stop the pipeline before the
// next (more expensive) stage ever starts. Every test that acquires a lock uses a session id
// unique to itself and releases in a finally, same discipline as test/turn-pipeline.test.js.
//
// Pitfall 4 (02-RESEARCH.md): a fake adapter that ignores its signal makes an abort test pass
// for the wrong reason — the pipeline's own promise settles while the fake's own work keeps
// running. Every real-process assertion below determines the child's fate from the child's
// own termination outcome (an 'exit' event, or process.kill(pid, 0) throwing ESRCH), never
// from the turn's promise having settled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { runTurn } from '../packages/shared/pipeline/turn-pipeline.js';
import { turnLockPathFor } from '../packages/shared/session/turn-lock.js';

// Read turn-pipeline.js's own temp-directory prefix from its source text (regex, not a new
// export), same convention test/turn-pipeline.test.js and test/convert.test.js already use,
// so these hygiene assertions can never drift from the real value.
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
  return `vbtest-abort-${label}-${randomUUID()}`;
}

function makeFastFakes({ transcript = 'hello', rawReply = 'ok', speechText = 'ok' } = {}) {
  const calls = { transcribe: 0, agent: 0, speak: 0 };
  const transcribe = async () => {
    calls.transcribe += 1;
    return { text: transcript, meta: {} };
  };
  const agent = async () => {
    calls.agent += 1;
    return { text: speechText, rawText: rawReply, meta: {} };
  };
  const speak = async () => {
    calls.speak += 1;
    return { audioBuffer: Buffer.from('fake-audio'), mimeType: 'audio/mp4', meta: {} };
  };
  return { adapters: { transcribe, agent, speak }, calls };
}

// Starts a real, always-present short-lived system process (`sleep`) through the array-form
// child-process facility, forwarding the caller's signal into its options exactly the way
// every real adapter in this codebase now does (Task 2). `onSpawn`, when given, fires
// synchronously the moment the child is created — used to deterministically wait for a
// later-pipeline-stage's child to exist before the test aborts, without any timer-based race.
function makeRealSleepAdapter({ seconds = 5, forwardSignal = true, onSpawn } = {}) {
  const state = { child: null, exited: null };
  const fn = (input, config, options = {}) =>
    new Promise((resolve, reject) => {
      const execOptions = forwardSignal ? { signal: options.signal } : {};
      const child = execFile('sleep', [String(seconds)], execOptions, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve({ text: 'unused', audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} });
        }
      });
      state.child = child;
      state.exited = new Promise((res) => {
        child.on('exit', (code, sig) => res({ code, signal: sig }));
      });
      if (onSpawn) onSpawn(child);
    });
  return { fn, getState: () => state };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// --- Real process termination, proven from the child's own outcome (Pitfall 4) ---

test('aborting mid-transcribe kills the real child process the fake adapter started, proven by the child\'s own termination outcome rather than the turn\'s promise settling', async () => {
  const sessionId = uniqueSessionId('real-kill');
  const controller = new AbortController();
  const { fn: transcribe, getState } = makeRealSleepAdapter();
  const agent = async () => {
    throw new Error('agent must not be called — the child was still alive when the turn was aborted mid-transcribe');
  };
  const speak = async () => {
    throw new Error('speak must not be called');
  };

  const turnPromise = runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters: { transcribe, agent, speak },
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    signal: controller.signal,
  });

  // execFile spawns the child synchronously inside the executor of the Promise transcribe
  // constructs — that executor runs before runTurn's async chain yields control back here,
  // so the child is already alive by this point without any polling.
  const { child } = getState();
  assert.ok(child?.pid, 'expected the fake adapter to have spawned a real child process synchronously');

  controller.abort();

  await assert.rejects(turnPromise, (err) => err.code === 'TURN_ABORTED');

  const exitInfo = await getState().exited;
  assert.equal(exitInfo.signal, 'SIGTERM', 'the child must have been terminated by the forwarded abort signal');
  assert.throws(
    () => process.kill(child.pid, 0),
    /ESRCH/,
    'the child process must be genuinely gone from the OS process table — not merely have its promise settle',
  );
});

test('the process-death assertion has teeth: an adapter that ignores its signal leaves the real child alive well after abort, unlike a signal-forwarding adapter', async () => {
  const sessionId = uniqueSessionId('teeth');
  const controller = new AbortController();
  const { fn: transcribe, getState } = makeRealSleepAdapter({ forwardSignal: false });
  const agent = async () => {
    throw new Error('agent must not be called');
  };
  const speak = async () => {
    throw new Error('speak must not be called');
  };

  // Note: because this adapter ignores the signal, `runTurn` itself cannot react to the
  // abort until this in-flight adapter call eventually settles on its own — this is exactly
  // the SESS-04 failure mode a signal-forwarding adapter exists to prevent, and precisely why
  // this test does not await turnPromise until after killing the child directly below.
  const turnPromise = runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters: { transcribe, agent, speak },
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    signal: controller.signal,
  });

  const { child } = getState();
  assert.ok(child?.pid, 'expected the fake adapter to have spawned a real child process synchronously');

  controller.abort();

  // 200ms is well past the single-digit-millisecond window in which the sibling
  // signal-forwarding test above observes real termination, and well short of this child's
  // full 5-second natural lifetime — the exact false-pass condition Pitfall 4 warns about:
  // an equivalent check against a signal-forwarding adapter reports the process gone by now,
  // while this ignoring adapter's process is still alive, proving the assertion is watching
  // the process rather than the promise.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.doesNotThrow(
    () => process.kill(child.pid, 0),
    'the ignored-signal child must still be alive 200ms after abort, unlike a signal-forwarding adapter\'s child',
  );

  // Kill it directly rather than waiting out the remaining ~4.8s of its natural lifetime,
  // then let the turn itself settle — with the signal aborted, the pipeline normalizes the
  // resulting rejection to TurnAbortedError once the now-killed adapter call finally settles.
  child.kill('SIGKILL');
  await assert.rejects(turnPromise, (err) => err.code === 'TURN_ABORTED');
});

// --- Promptness, measured against the number SESS-04 names ---

test('promptness: the abort-to-rejection interval is far below the transcription adapter\'s 120000ms timeout, measured with a monotonic clock', async () => {
  const sessionId = uniqueSessionId('promptness');
  const controller = new AbortController();
  const { fn: transcribe, getState } = makeRealSleepAdapter();
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);

  const turnPromise = runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters: {
      transcribe,
      agent: async () => {
        throw new Error('agent must not be called');
      },
      speak: async () => {
        throw new Error('speak must not be called');
      },
    },
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    signal: controller.signal,
  });

  assert.ok(getState().child?.pid, 'expected the child to already be spawned');

  const abortAtNs = process.hrtime.bigint();
  controller.abort();
  await assert.rejects(turnPromise, (err) => err.code === 'TURN_ABORTED');
  const rejectedAtNs = process.hrtime.bigint();
  const elapsedMs = Number(rejectedAtNs - abortAtNs) / 1e6;

  // stt-whisper-local.js's own configured execFileAsync timeout — named explicitly so the
  // comparison says out loud which number it is beating, per SESS-04's literal phrasing.
  const TRANSCRIPTION_ADAPTER_TIMEOUT_MS = 120000;
  assert.ok(elapsedMs < 500, `expected the abort-to-rejection interval under 500ms, took ${elapsedMs}ms`);
  assert.ok(
    elapsedMs < TRANSCRIPTION_ADAPTER_TIMEOUT_MS,
    `expected far below the transcription adapter's ${TRANSCRIPTION_ADAPTER_TIMEOUT_MS}ms timeout, took ${elapsedMs}ms`,
  );

  assert.equal(
    fs.existsSync(turnLockPathFor(sessionId)),
    false,
    'the lock artifact must be gone at the moment the rejection settles',
  );

  assert.deepEqual(
    listMatchingTempEntries(prefix).sort(),
    before.sort(),
    'the abandoned turn\'s own temp directory must be gone at the moment the rejection settles',
  );

  // A fresh turn started immediately afterwards must succeed — the next caller is not
  // blocked by the abandoned one.
  const { adapters: freshAdapters } = makeFastFakes();
  const freshResult = await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters: freshAdapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });
  assert.equal(freshResult.transcript, 'hello');
});

// --- Between-stage abort ---

test('abort between transcription and the agent stage rejects with the aborted code and never calls the agent fake', async () => {
  const sessionId = uniqueSessionId('between-transcribe-agent');
  const controller = new AbortController();
  let agentCalled = false;
  let speakCalled = false;
  const adapters = {
    transcribe: async () => {
      // Simulates a caller vanishing at the exact instant transcription finishes.
      controller.abort();
      return { text: 'hello', meta: {} };
    },
    agent: async () => {
      agentCalled = true;
      return { text: 'reply', rawText: 'reply', meta: {} };
    },
    speak: async () => {
      speakCalled = true;
      return { audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} };
    },
  };

  await assert.rejects(
    () =>
      runTurn({
        audioBuffer: Buffer.from('bytes'),
        adapters,
        sttConfig: {},
        openclawConfig: { sessionId },
        ttsConfig: {},
        signal: controller.signal,
      }),
    (err) => err.code === 'TURN_ABORTED',
  );

  assert.equal(agentCalled, false, 'the agent stage must never run once the caller has vanished');
  assert.equal(speakCalled, false);
  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
});

test('abort between the agent and speech stages rejects with the aborted code and never calls the speak fake', async () => {
  const sessionId = uniqueSessionId('between-agent-speak');
  const controller = new AbortController();
  let speakCalled = false;
  const adapters = {
    transcribe: async () => ({ text: 'hello', meta: {} }),
    agent: async () => {
      // Simulates a caller vanishing at the exact instant the agent reply is ready.
      controller.abort();
      return { text: 'reply', rawText: 'reply', meta: {} };
    },
    speak: async () => {
      speakCalled = true;
      return { audioBuffer: Buffer.alloc(0), mimeType: 'audio/mp4', meta: {} };
    },
  };

  await assert.rejects(
    () =>
      runTurn({
        audioBuffer: Buffer.from('bytes'),
        adapters,
        sttConfig: {},
        openclawConfig: { sessionId },
        ttsConfig: {},
        signal: controller.signal,
      }),
    (err) => err.code === 'TURN_ABORTED',
  );

  assert.equal(speakCalled, false, 'the speech stage must never run once the caller has vanished');
  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
});

test('a signal already aborted before the call rejects with the aborted code and acquires no lock at all', async () => {
  const sessionId = uniqueSessionId('pre-aborted');
  const controller = new AbortController();
  controller.abort();
  const { adapters, calls } = makeFastFakes();

  await assert.rejects(
    () =>
      runTurn({
        audioBuffer: Buffer.from('bytes'),
        adapters,
        sttConfig: {},
        openclawConfig: { sessionId },
        ttsConfig: {},
        signal: controller.signal,
      }),
    (err) => err.code === 'TURN_ABORTED',
  );

  assert.equal(calls.transcribe, 0, 'an already-dead caller must not even reach the transcribe stage');
  assert.equal(
    fs.existsSync(turnLockPathFor(sessionId)),
    false,
    'an already-dead caller must not even briefly acquire the lock',
  );
});

// --- Unwinding ---

test('abort during the speech stage still releases the lock and removes the temp directory, proven against a real child process', async () => {
  const sessionId = uniqueSessionId('abort-during-speech');
  const controller = new AbortController();
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const spawnedGate = createDeferred();
  const { fn: speak, getState } = makeRealSleepAdapter({ onSpawn: () => spawnedGate.resolve() });

  const adapters = {
    transcribe: async () => ({ text: 'hi', meta: {} }),
    agent: async () => ({ text: 'ok', rawText: 'OK', meta: {} }),
    speak,
  };

  const turnPromise = runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    signal: controller.signal,
  });

  // transcribe/agent are ordinary async fakes, which always defer at least one microtask
  // even when trivial — unlike the direct-invocation tests above, we cannot assume the
  // speak stage's child has spawned synchronously right after calling runTurn. Wait for the
  // adapter's own spawn signal instead of any timer.
  await spawnedGate.promise;
  const { child } = getState();
  assert.ok(child?.pid, 'expected the speech-stage fake to have spawned a real child process');

  controller.abort();

  await assert.rejects(turnPromise, (err) => err.code === 'TURN_ABORTED');

  const exitInfo = await getState().exited;
  assert.equal(exitInfo.signal, 'SIGTERM');
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/);

  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false, 'the lock must be released');
  assert.deepEqual(
    listMatchingTempEntries(prefix).sort(),
    before.sort(),
    'the pipeline temp-prefix entry set must be unchanged after an abort during the speech stage',
  );
});

test('after any abort rejection the lock artifact does not exist and the pipeline temp-prefix entry set is unchanged from before the turn', async () => {
  const sessionId = uniqueSessionId('unwind-generic');
  const controller = new AbortController();
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);

  const adapters = {
    transcribe: async () => {
      controller.abort();
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'OK', meta: {} }),
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
        signal: controller.signal,
      }),
    (err) => err.code === 'TURN_ABORTED',
  );

  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

// --- Regression: lock acquisition still precedes the first await (plan 02-02's determinism
// guarantee must survive this plan's edits) ---

test('regression: acquireTurnLock still precedes the first await in runTurn after the between-stage checks were added', () => {
  const declIndex = PIPELINE_SOURCE.indexOf('export async function runTurn(');
  assert.ok(declIndex >= 0);
  const body = PIPELINE_SOURCE.slice(declIndex);
  const acquireIndex = body.indexOf('acquireTurnLock(');
  const awaitIndex = body.indexOf('await ');
  assert.ok(acquireIndex >= 0);
  assert.ok(awaitIndex >= 0);
  assert.ok(acquireIndex < awaitIndex);
});
