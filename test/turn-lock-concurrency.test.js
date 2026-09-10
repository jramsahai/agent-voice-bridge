// TEST-03: the concurrency proof. Every assertion here drives the real runTurn() pipeline
// twice or more — this file never calls acquireTurnLock/releaseTurnLock to arrange
// contention, only to inspect an artifact's existence or to clean one up, because "not a
// unit test of the lock primitive alone" is the literal requirement. Ordering is arranged
// entirely by hand-resolved deferred promises; nothing here uses a timer, a sleep, or a
// delay of any length.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { runTurn } from '../packages/shared/pipeline/turn-pipeline.js';
import { turnLockPathFor, releaseTurnLock } from '../packages/shared/session/turn-lock.js';
import { TurnBusyError } from '../packages/shared/errors/turn-errors.js';

function uniqueSessionId(label) {
  return `vbtest-lockrace-${label}-${randomUUID()}`;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Imitates markSessionPrimed's write shape in agent-session.js (mkdirSync the parent, then
// one writeFileSync of a small JSON document) so the single-writer proof below is about a
// realistic write, not a synthetic counter.
function writeScratchRecord(scratchPath, turnId) {
  fs.appendFileSync(scratchPath, `${JSON.stringify({ turnId, writtenAt: new Date().toISOString() })}\n`, 'utf8');
}

function readScratchRecords(scratchPath) {
  if (!fs.existsSync(scratchPath)) return [];
  return fs
    .readFileSync(scratchPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function makeBaseArgs(sessionId, adapters) {
  return (turnId) => ({
    audioBuffer: Buffer.from(turnId, 'utf8'),
    adapters,
    sttConfig: {},
    agentConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });
}

// --- The in-process race, arranged by a gate the test controls, extended with the
// single-writer proof: the shared scratch file the fake agent writes must carry exactly one
// well-formed record for the winner of the two-turn race, and none for the loser. ---

test('a second turn arriving mid-turn is refused immediately, never interleaves, and the scratch file records only the winner', async () => {
  const sessionId = uniqueSessionId('two-turn-race');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-lockrace-scratch-'));
  const scratchPath = path.join(scratchDir, 'session-state.jsonl');

  try {
    const agentGate = createDeferred();
    let agentCallCount = 0;
    let transcribeCallCount = 0;

    const adapters = {
      // Counted, not just called: runTurn's withTempDir wraps transcribe/agent/speak, and
      // mkdtempSync is withTempDir's own first statement — transcribe is the first thing to
      // run inside that callback. transcribeCallCount staying at 1 is therefore a
      // deterministic, non-racy proof that turn B's temp directory was never created: it is
      // structurally impossible to reach transcribe without withTempDir having already run
      // mkdtempSync. A scan of the shared, process-wide os.tmpdir() prefix listing was
      // deliberately rejected here — `node --test` runs test files in parallel, and other
      // files' own runTurn() calls share this exact prefix, which made that scan flake under
      // full-suite load without indicating any actual defect in this module.
      transcribe: async (audioPath) => {
        transcribeCallCount += 1;
        return { text: fs.readFileSync(audioPath, 'utf8') };
      },
      agent: async (text) => {
        agentCallCount += 1;
        await agentGate.promise; // parks here until the test releases it
        writeScratchRecord(scratchPath, text);
        return { text: `reply:${text}`, rawText: `reply:${text}`, meta: {} };
      },
      speak: async () => ({ audioBuffer: Buffer.alloc(0), mimeType: 'audio/wav', meta: {} }),
    };
    const baseArgs = makeBaseArgs(sessionId, adapters);

    // Not awaited: per the pipeline's acquire-before-first-await ordering, turn A's lock is
    // already held by the time control returns here.
    const turnAPromise = runTurn(baseArgs('turn-a'));

    // Turn B is called while turn A is still parked inside the fake agent — and this whole
    // block runs, settles, and is asserted BEFORE agentGate.resolve() is ever called below,
    // which is what proves turn B was refused, not queued behind turn A.
    const turnBOutcome = await runTurn(baseArgs('turn-b')).catch((err) => err);

    assert.ok(turnBOutcome instanceof TurnBusyError, 'turn B must reject with a TurnBusyError');
    assert.equal(turnBOutcome.code, 'TURN_BUSY');
    assert.equal(transcribeCallCount, 1, 'turn B must never reach the temp-directory-creating transcribe stage at all');
    assert.equal(agentCallCount, 1, 'turn B must never reach the agent stage at all');

    agentGate.resolve(); // let turn A finish
    const turnAResult = await turnAPromise;
    assert.equal(turnAResult.reply, 'reply:turn-a');

    // The lock and its filesystem artifact must be gone after turn A completes, proving
    // release ran and a subsequent turn is now possible — not merely reported possible.
    assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
    const turnCResult = await runTurn(baseArgs('turn-c'));
    assert.equal(turnCResult.reply, 'reply:turn-c');

    const records = readScratchRecords(scratchPath);
    assert.equal(records.length, 2, 'exactly turn A and turn C reached the agent stage and wrote a record — turn B never did');
    assert.deepEqual(records.map((r) => r.turnId), ['turn-a', 'turn-c']);
    for (const raw of fs.readFileSync(scratchPath, 'utf8').split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(raw), 'no torn or partial record in the shared scratch file');
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    releaseTurnLock(sessionId);
  }
});

// --- single-writer-across-N-turns invariant: the executable form of this phase's promote
// decision. Several waves of turns race one session; within each wave a winner and a set of
// losers are launched with no await between them, none of them awaited individually until
// the whole wave has been dispatched. ---

test('single-writer-across-N-turns invariant: exactly the turns that acquire the lock write a record, every other turn is refused as busy, and the record order matches the resolution order', async () => {
  const sessionId = uniqueSessionId('interleave');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-lockrace-scratch-'));
  const scratchPath = path.join(scratchDir, 'session-state.jsonl');

  try {
    const WAVES = 3;
    const LOSERS_PER_WAVE = 2;
    let totalLaunched = 0;
    let totalResolved = 0;
    let totalRejected = 0;
    const expectedWinnerOrder = [];

    for (let wave = 0; wave < WAVES; wave += 1) {
      const winnerGate = createDeferred();
      const winnerId = `wave-${wave}-winner`;
      expectedWinnerOrder.push(winnerId);

      const adapters = {
        transcribe: async (audioPath) => ({ text: fs.readFileSync(audioPath, 'utf8') }),
        agent: async (text) => {
          await winnerGate.promise;
          writeScratchRecord(scratchPath, text);
          return { text: `reply:${text}`, rawText: `reply:${text}`, meta: {} };
        },
        speak: async () => ({ audioBuffer: Buffer.alloc(0), mimeType: 'audio/wav', meta: {} }),
      };
      const baseArgs = makeBaseArgs(sessionId, adapters);

      // Launched at once: the winner first, then every loser, none of them awaited in this
      // loop — per the pipeline's acquire-before-first-await ordering, the winner's lock is
      // already held by the time any loser's own acquireTurnLock call runs.
      const winnerPromise = runTurn(baseArgs(winnerId));
      totalLaunched += 1;

      const loserPromises = [];
      for (let i = 0; i < LOSERS_PER_WAVE; i += 1) {
        loserPromises.push(runTurn(baseArgs(`wave-${wave}-loser-${i}`)).catch((err) => err));
        totalLaunched += 1;
      }
      const loserOutcomes = await Promise.all(loserPromises);
      for (const outcome of loserOutcomes) {
        assert.ok(outcome instanceof TurnBusyError, 'every loser must reject with a TurnBusyError, never an opaque failure');
        totalRejected += 1;
      }

      winnerGate.resolve();
      const winnerResult = await winnerPromise;
      assert.equal(winnerResult.reply, `reply:${winnerId}`);
      totalResolved += 1;
    }

    assert.equal(totalResolved + totalRejected, totalLaunched, 'nothing was lost and nothing ran twice');
    assert.equal(totalResolved, WAVES);
    assert.equal(totalRejected, WAVES * LOSERS_PER_WAVE);

    const records = readScratchRecords(scratchPath);
    assert.equal(records.length, totalResolved, 'the record count equals the count of resolved turns');
    assert.deepEqual(
      records.map((r) => r.turnId),
      expectedWinnerOrder,
      'the records appear in the same order the successful turns resolved — the conversation order is the order the lock was granted',
    );
    for (const raw of fs.readFileSync(scratchPath, 'utf8').split('\n').filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(raw), 'no torn or duplicated record');
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    releaseTurnLock(sessionId);
  }
});

// --- The cross-process race: the only proof an in-process flag alone would not have been
// enough. Two real OS processes fork, each imports the real lock module, and both attempt
// exactly one acquisition after a two-phase ready/go handshake with the parent. ---

test('two forked processes racing acquisition on one lock path after a go handshake produce exactly one success', async () => {
  const sessionId = uniqueSessionId('cross-process');
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-lockrace-fork-'));
  const scriptPath = path.join(scriptDir, 'race-child.mjs');
  const lockModuleUrl = new URL('../packages/shared/session/turn-lock.js', import.meta.url).href;

  // Written at test time into a throwaway temp directory removed in the finally below — no
  // fixture file is committed to the repository.
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
  // Release BEFORE reporting the result — the parent is a genuinely separate OS process,
  // so send() and this process's own release() are not ordered from the parent's point of
  // view unless release happens first: only then does the parent's receipt of the message
  // (necessarily downstream of this send call) guarantee the release already ran.
  if (acquired) {
    releaseTurnLock(${JSON.stringify(sessionId)});
  }
  process.send({ acquired, errorMessage });
  process.exit(0);
});

process.send('ready');
`;
  fs.writeFileSync(scriptPath, childScript, 'utf8');

  // execArgv: [] — node --test's own flags (--test-concurrency, etc.) are on
  // process.execArgv and fork() inherits them by default; forking with them intact
  // relaunches each child under the test-runner's own IPC/TAP protocol instead of running
  // this plain script, which collides with the handshake's own process.send()/'message'
  // calls. An explicit empty execArgv makes each child a plain `node race-child.mjs` run.
  const forkOptions = { stdio: 'ignore', execArgv: [] };
  const children = [];
  try {
    children.push(fork(scriptPath, [], forkOptions), fork(scriptPath, [], forkOptions));

    // Two-phase handshake: wait for both children to report ready before sending 'go' to
    // either, so both acquisition attempts land as close together as the platform allows
    // rather than being separated by process-startup cost.
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

    // If a same-tick two-process race is ever unreliable on this platform, this assertion
    // must not be weakened to make it pass — a test that sometimes proves mutual exclusion
    // proves nothing. Record and surface the flake instead.
    assert.equal(successes.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].errorMessage, null, 'the loser must report a plain refusal, not throw an error');
    assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false, 'the winner must have released before exiting');
  } finally {
    for (const child of children) {
      child.kill();
    }
    fs.rmSync(scriptDir, { recursive: true, force: true });
    releaseTurnLock(sessionId);
  }
});
