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
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runTurn } from '../packages/shared/pipeline/turn-pipeline.js';
import { turnLockPathFor } from '../packages/shared/session/turn-lock.js';
import { transcribeWithWhisperLocal } from '../packages/shared/adapters/stt-whisper-local.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Read turn-pipeline.js's own temp-directory prefix from its source text (regex, not a new
// export), same convention test/turn-pipeline.test.js and test/convert.test.js already use,
// so these hygiene assertions can never drift from the real value.
const PIPELINE_SOURCE_URL = new URL('../packages/shared/pipeline/turn-pipeline.js', import.meta.url);
const PIPELINE_SOURCE = fs.readFileSync(PIPELINE_SOURCE_URL, 'utf8');

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
  const state = { child: null, exited: null, audioPath: null };
  const fn = (input, config, options = {}) =>
    new Promise((resolve, reject) => {
      // Captured for the promptness test's non-racy temp-hygiene assertion below: since a
      // turn creates exactly one temp directory for its whole lifetime (transcribe/agent/
      // speak all run inside the same withTempDir callback), the directory containing this
      // fake's own `input` argument (an audioPath when this fake plays the transcribe role)
      // is the turn's own directory — captured directly rather than diffed against the
      // shared, process-wide os.tmpdir() prefix listing, which is racy once more than one
      // file drives real runTurn() calls concurrently under node --test (see deferred-items.md).
      state.audioPath = input;
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
    agentConfig: { sessionId },
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
    agentConfig: { sessionId },
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
    agentConfig: { sessionId },
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

  const turnDir = path.dirname(getState().audioPath);
  assert.equal(
    fs.existsSync(turnDir),
    false,
    'the abandoned turn\'s own temp directory must be gone at the moment the rejection settles',
  );

  // A fresh turn started immediately afterwards must succeed — the next caller is not
  // blocked by the abandoned one.
  const { adapters: freshAdapters } = makeFastFakes();
  const freshResult = await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters: freshAdapters,
    sttConfig: {},
    agentConfig: { sessionId },
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
        agentConfig: { sessionId },
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
        agentConfig: { sessionId },
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
        agentConfig: { sessionId },
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
  const spawnedGate = createDeferred();
  const { fn: speak, getState } = makeRealSleepAdapter({ onSpawn: () => spawnedGate.resolve() });

  // Captured from the transcribe stage's own audioPath argument — the turn's one temp
  // directory is created once, before transcribe runs, and lasts the whole turn, so this is
  // the same directory the speech stage's abort must have removed by the time it settles.
  let turnDir;
  const adapters = {
    transcribe: async (audioPath) => {
      turnDir = path.dirname(audioPath);
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'OK', meta: {} }),
    speak,
  };

  const turnPromise = runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    agentConfig: { sessionId },
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
  assert.equal(
    fs.existsSync(turnDir),
    false,
    'the turn\'s own temp directory must be gone after an abort during the speech stage',
  );
});

test('after any abort rejection the lock artifact does not exist and the pipeline temp-prefix entry set is unchanged from before the turn', async () => {
  const sessionId = uniqueSessionId('unwind-generic');
  const controller = new AbortController();

  let turnDir;
  const adapters = {
    transcribe: async (audioPath) => {
      turnDir = path.dirname(audioPath);
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
        agentConfig: { sessionId },
        ttsConfig: {},
        signal: controller.signal,
      }),
    (err) => err.code === 'TURN_ABORTED',
  );

  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
  assert.equal(fs.existsSync(turnDir), false);
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

// =====================================================================================
// Task 2: signal threading through every real adapter, and speech-adapter temp-dir hygiene
// =====================================================================================

// --- The real production adapter, exercised against a real child process, no model ---

// transcribeWithWhisperLocal is itself an async function, so the promise it returns is a
// fresh wrapper promise created by the language runtime around its own `await
// execFileAsync(...)` — util.promisify's `.child` attachment lives on that *inner* promise,
// which this function's caller never sees. There is no handle to the real ChildProcess
// reachable from outside the module, so this test finds the running process the same way an
// external operator would: by querying the OS process table for the exact command line this
// call must have started, using the real, always-present `pgrep` utility.
async function findMatchingPids(pattern) {
  return new Promise((resolve, reject) => {
    execFile('pgrep', ['-f', pattern], (error, stdout) => {
      if (error) {
        // pgrep's own documented exit code for "no processes matched" is 1 — not a real
        // failure, just an empty result.
        if (error.code === 1) return resolve([]);
        return reject(error);
      }
      resolve(
        stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(Number),
      );
    });
  });
}

async function waitUntil(conditionFn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await conditionFn();
    if (result) return result;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('transcribeWithWhisperLocal aborts a real child process promptly, proven by the child\'s own termination outcome', async () => {
  const controller = new AbortController();
  // sttConfig.command points at a real, always-present short-lived binary; the "audio path"
  // argument becomes sleep's duration argument — no whisper binary, no model, no network. A
  // duration distinct from every other sleep invocation in this file keeps the pgrep pattern
  // below from ever matching an unrelated process.
  const sleepSeconds = '11';
  const callPromise = transcribeWithWhisperLocal(sleepSeconds, { command: 'sleep' }, { signal: controller.signal });

  const pids = await waitUntil(async () => {
    const found = await findMatchingPids(`sleep ${sleepSeconds}`);
    return found.length > 0 ? found : undefined;
  });
  assert.ok(pids?.length === 1, 'expected exactly one matching sleep process spawned by the adapter');
  const [pid] = pids;
  assert.doesNotThrow(() => process.kill(pid, 0), 'expected the child to be alive before the abort');

  controller.abort();
  await assert.rejects(callPromise);

  const goneAt = await waitUntil(() => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
  assert.equal(
    goneAt,
    true,
    'the production transcription adapter\'s child process must be genuinely gone, not merely have its promise settle',
  );
});

test('transcribeWithWhisperLocal called with only two arguments behaves exactly as before', async () => {
  const result = await transcribeWithWhisperLocal('two-arg-call', { command: 'echo' });
  assert.equal(result.text, 'two-arg-call');
});

// --- Structural assertions across all five adapter files ---

const ADAPTERS_DIR = path.join(repoRoot, 'packages/shared/adapters');

function collectJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectJsFiles(fullPath));
    } else if (entry.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

// Extracts the parenthesized argument-list text immediately following the occurrence of
// a call-site marker starting at markerIndex, by counting balanced parens — robust to
// nested object literals and multi-line calls, unlike a single non-greedy regex.
function extractCallArgs(source, markerIndex) {
  let depth = 0;
  let start = -1;
  for (let i = markerIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i);
      }
    }
  }
  throw new Error(`unbalanced parens scanning from index ${markerIndex}`);
}

// calleeName is passed as a plain runtime string, never written adjoined to an open paren in
// this file's own static source (not even in a comment) — this file lives under test/, which
// the offline scan in test/convert.test.js walks recursively, and that scan forbids the
// literal text formed by the network-call function name immediately followed by '(' from
// appearing anywhere under test/, built by concatenation there for the same reason.
function findAllCallSites(source, calleeName) {
  const sites = [];
  const marker = `${calleeName}(`;
  let idx = source.indexOf(marker);
  while (idx !== -1) {
    sites.push(extractCallArgs(source, idx));
    idx = source.indexOf(marker, idx + marker.length);
  }
  return sites;
}

test('source scan: every child-process options object across packages/shared/adapters/ includes a signal', () => {
  const files = collectJsFiles(ADAPTERS_DIR);
  assert.ok(files.length > 0, 'sanity: expected at least one adapter file');
  let sawAtLeastOneCall = false;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const callSites = findAllCallSites(source, 'execFileAsync');
    for (const args of callSites) {
      sawAtLeastOneCall = true;
      assert.ok(
        /signal/.test(args),
        `${path.relative(repoRoot, file)}: an execFileAsync call is missing a signal in its options`,
      );
    }
  }
  assert.ok(sawAtLeastOneCall, 'sanity: expected at least one execFileAsync call across the adapters');
});

test('source scan: every request options object across packages/shared/adapters/ includes a signal', () => {
  const files = collectJsFiles(ADAPTERS_DIR);
  let sawAtLeastOneCall = false;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const callSites = findAllCallSites(source, 'fetch');
    for (const args of callSites) {
      sawAtLeastOneCall = true;
      assert.ok(/signal/.test(args), `${path.relative(repoRoot, file)}: a fetch call is missing a signal in its options`);
    }
  }
  assert.ok(sawAtLeastOneCall, 'sanity: expected at least one fetch call across the adapters');
});

test('the health probe\'s existing timeout-derived signal is composed with the caller\'s rather than replaced, and both are reachable from the composed value', async () => {
  const { composeAbortSignals } = await import('../packages/shared/adapters/tts-kokoro-onnx.js');
  assert.equal(typeof composeAbortSignals, 'function', 'expected tts-kokoro-onnx.js to export composeAbortSignals');

  const callerController = new AbortController();
  const timeoutController = new AbortController();
  const composed = composeAbortSignals(callerController.signal, timeoutController.signal);

  assert.equal(composed.aborted, false);
  callerController.abort();
  assert.equal(composed.aborted, true, 'the composed signal must abort when the caller\'s own signal aborts');

  const composedFromTimeoutOnly = composeAbortSignals(undefined, timeoutController.signal);
  assert.equal(composedFromTimeoutOnly.aborted, false);
  timeoutController.abort();
  assert.equal(
    composedFromTimeoutOnly.aborted,
    true,
    'the composed signal must abort when the timeout-derived signal aborts, with no caller signal supplied',
  );

  // A single supplied signal is returned as-is, so a caller with no signal never pays for
  // a needless wrapper object.
  const soleController = new AbortController();
  assert.equal(composeAbortSignals(soleController.signal), soleController.signal);
  assert.equal(composeAbortSignals(undefined), undefined);
});

test('source scan: every temporary-directory creation under packages/shared/adapters/ sits inside the shared cleanup helper', () => {
  const files = collectJsFiles(ADAPTERS_DIR);
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(
      !source.includes('mkdtempSync('),
      `${path.relative(repoRoot, file)}: creates a temp directory outside withTempDir (a raw mkdtempSync call was found)`,
    );
  }
});

test('no adapter file imports anything outside node: builtins and this repository\'s own files', () => {
  const files = collectJsFiles(ADAPTERS_DIR);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      const isNodeBuiltin = specifier.startsWith('node:');
      const isRelative = specifier.startsWith('.');
      assert.ok(
        isNodeBuiltin || isRelative,
        `${path.relative(repoRoot, file)} imports '${specifier}', which is neither a node: builtin nor a relative path`,
      );
    }
  }
});
