// Phase 2's tracer: a full fake-adapter turn, the shared-session-id proof, every
// guard-clause rejection, lock span/ordering, and temp/lock hygiene. Every test that
// acquires a lock uses a session id unique to that test and releases in a finally, because
// `node --test` runs test files in parallel child processes and the lock is a real
// filesystem artifact shared across them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { runTurn } from '../packages/shared/pipeline/turn-pipeline.js';
import { acquireTurnLock, releaseTurnLock, turnLockPathFor } from '../packages/shared/session/turn-lock.js';
import { withTempDir } from '../packages/shared/lifecycle/tempfiles.js';
import { TurnBusyError } from '../packages/shared/errors/turn-errors.js';

// Read turn-pipeline.js's own temp-directory prefix from its source text (regex, not a new
// export) so the hygiene assertions below can never drift from the real value — same
// pattern test/convert.test.js uses for its own TEMP_DIR_PREFIX.
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
  return `vbtest-${label}-${randomUUID()}`;
}

function makeFakes({ transcript = 'hello world', rawReply = 'Hi **there**.', speechText = 'Hi there.' } = {}) {
  const calls = { transcribe: 0, agent: 0, speak: 0 };
  const record = { transcribe: [], agent: [], speak: [] };

  const transcribe = async (audioPath, sttConfig, options) => {
    calls.transcribe += 1;
    // Snapshot existence/contents now — withTempDir removes the directory before runTurn
    // resolves, so this must be captured while the transcribe fake is still running.
    const existedAtCallTime = fs.existsSync(audioPath);
    const contentsAtCallTime = existedAtCallTime ? fs.readFileSync(audioPath) : null;
    record.transcribe.push({ audioPath, sttConfig, options, existedAtCallTime, contentsAtCallTime });
    return { text: transcript, meta: {} };
  };
  const agent = async (text, openclawConfig, options) => {
    calls.agent += 1;
    record.agent.push({ text, openclawConfig, options });
    return { text: speechText, rawText: rawReply, meta: {} };
  };
  const speak = async (text, ttsConfig, options) => {
    calls.speak += 1;
    record.speak.push({ text, ttsConfig, options });
    return { audioBuffer: Buffer.from('fake-audio-bytes'), mimeType: 'audio/mp4', meta: {} };
  };

  return { adapters: { transcribe, agent, speak }, calls, record };
}

// --- Happy path ---

test('a complete turn resolves transcript, reply, speechText and speech from the fake adapters', async () => {
  const sessionId = uniqueSessionId('happy');
  const audioBuffer = Buffer.from('raw-audio-bytes-for-happy-path');
  const { adapters, record } = makeFakes({
    transcript: 'what time is it',
    rawReply: '**It is** 3pm.',
    speechText: 'It is 3pm.',
  });

  const result = await runTurn({
    audioBuffer,
    adapters,
    sttConfig: { command: 'whisper-cli' },
    openclawConfig: { sessionId },
    ttsConfig: { provider: 'macos-say' },
  });

  assert.equal(result.transcript, 'what time is it');
  assert.equal(result.reply, '**It is** 3pm.');
  assert.equal(result.speechText, 'It is 3pm.');
  assert.ok(result.speech);
  assert.equal(result.speech.mimeType, 'audio/mp4');

  assert.equal(record.speak.length, 1);
  assert.equal(record.speak[0].text, 'It is 3pm.', 'speak must receive the cleaned speechText, not the raw reply');

  assert.equal(record.transcribe.length, 1);
  const { sttConfig, options: transcribeOptions, existedAtCallTime, contentsAtCallTime } = record.transcribe[0];
  assert.ok(existedAtCallTime, 'the transcribe fake must receive a real, existing file path');
  assert.deepEqual(contentsAtCallTime, audioBuffer, 'the file contents must be byte-identical to the passed buffer');
  assert.deepEqual(sttConfig, { command: 'whisper-cli' });
  assert.ok('signal' in transcribeOptions);

  assert.equal(record.agent.length, 1);
  const { text: agentText, openclawConfig: agentConfig, options: agentOptions } = record.agent[0];
  assert.equal(agentText, 'what time is it');
  assert.equal(agentConfig.sessionId, sessionId);
  assert.ok('signal' in agentOptions);

  const { text: speakText, ttsConfig, options: speakOptions } = record.speak[0];
  assert.equal(speakText, 'It is 3pm.');
  assert.deepEqual(ttsConfig, { provider: 'macos-say' });
  assert.ok('signal' in speakOptions);

  assert.equal(result.meta.sessionId, sessionId);
  assert.equal(typeof result.meta.durationsMs.transcribe, 'number');
  assert.equal(typeof result.meta.durationsMs.agent, 'number');
  assert.equal(typeof result.meta.durationsMs.speak, 'number');
});

test('wantAudio: false resolves with speech null and never calls the speak fake', async () => {
  const sessionId = uniqueSessionId('no-audio');
  const { adapters, calls } = makeFakes();

  const result = await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });

  assert.equal(result.speech, null);
  assert.equal(calls.speak, 0);
  assert.equal(result.meta.durationsMs.speak, undefined, 'a stage that never ran must not report a duration');
});

// --- Shared session identity ---

test('two sequential turns with the same config report the same session id and reuse the config object reference', async () => {
  const sessionId = uniqueSessionId('shared');
  const openclawConfig = { sessionId };
  const { adapters, record } = makeFakes();

  const first = await runTurn({
    audioBuffer: Buffer.from('turn-one'),
    adapters,
    sttConfig: {},
    openclawConfig,
    ttsConfig: {},
    wantAudio: false,
  });
  const second = await runTurn({
    audioBuffer: Buffer.from('turn-two'),
    adapters,
    sttConfig: {},
    openclawConfig,
    ttsConfig: {},
    wantAudio: false,
  });

  assert.equal(first.meta.sessionId, sessionId);
  assert.equal(second.meta.sessionId, sessionId);
  assert.equal(record.agent[0].openclawConfig, openclawConfig, 'the agent fake must receive the identical config object reference');
  assert.equal(record.agent[1].openclawConfig, openclawConfig);
});

test('source assertion: every sessionId property read in turn-pipeline.js reads from openclawConfig', () => {
  const identifiers = [...PIPELINE_SOURCE.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\.sessionId/g)].map((m) => m[1]);
  assert.ok(identifiers.length > 0, 'expected at least one sessionId property read in the module');
  assert.deepEqual(new Set(identifiers), new Set(['openclawConfig']));
});

test('unknown top-level keys are ignored: session id always comes from openclawConfig and extraneous keys never reach an adapter', async () => {
  const sessionId = uniqueSessionId('unknown-keys');
  const { adapters, record } = makeFakes();

  await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
    sessionId: 'attacker-controlled-id',
    extraneous: 'must never reach an adapter',
  });

  assert.equal(record.agent[0].openclawConfig.sessionId, sessionId);
  assert.ok(!('extraneous' in record.agent[0].openclawConfig));
});

// --- Guard clauses ---

const sessionIdGuardCases = [
  { label: 'session id absent', sessionId: undefined },
  { label: 'session id empty string', sessionId: '' },
  { label: 'session id not a string', sessionId: 42 },
  { label: 'session id containing a path separator', sessionId: 'a/b' },
  { label: 'session id equal to ..', sessionId: '..' },
];

for (const { label, sessionId } of sessionIdGuardCases) {
  test(`guard clause: ${label} rejects before any adapter call, lock artifact or temp directory`, async () => {
    const prefix = readTempDirPrefix();
    const before = listMatchingTempEntries(prefix);
    const { adapters, calls } = makeFakes();

    await assert.rejects(() =>
      runTurn({
        audioBuffer: Buffer.from('bytes'),
        adapters,
        sttConfig: {},
        openclawConfig: { sessionId },
        ttsConfig: {},
      }),
    );

    assert.equal(calls.transcribe, 0);
    assert.equal(calls.agent, 0);
    assert.equal(calls.speak, 0);
    assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
    assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
  });
}

const adapterGuardCases = [
  { label: 'adapters absent', adapters: undefined },
  { label: 'transcribe missing', adapters: { agent: async () => ({}), speak: async () => ({}) } },
  {
    label: 'agent not a function',
    adapters: { transcribe: async () => ({}), agent: 'not-a-function', speak: async () => ({}) },
  },
  {
    label: 'speak not a function',
    adapters: { transcribe: async () => ({}), agent: async () => ({}), speak: 123 },
  },
];

for (const { label, adapters } of adapterGuardCases) {
  test(`guard clause: ${label} rejects before any lock artifact or temp directory`, async () => {
    const sessionId = uniqueSessionId('adapter-guard');
    const prefix = readTempDirPrefix();
    const before = listMatchingTempEntries(prefix);

    await assert.rejects(() =>
      runTurn({
        audioBuffer: Buffer.from('bytes'),
        adapters,
        sttConfig: {},
        openclawConfig: { sessionId },
        ttsConfig: {},
      }),
    );

    assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
    assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
  });
}

test('guard clause: non-Buffer audioBuffer rejects before any adapter call, lock artifact or temp directory', async () => {
  const sessionId = uniqueSessionId('buffer-guard');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const { adapters, calls } = makeFakes();

  await assert.rejects(() =>
    runTurn({
      audioBuffer: 'not-a-buffer',
      adapters,
      sttConfig: {},
      openclawConfig: { sessionId },
      ttsConfig: {},
    }),
  );

  assert.equal(calls.transcribe, 0);
  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('guard clause: an audioFilename with a path separator is rejected the same way as a bad session id', async () => {
  const sessionId = uniqueSessionId('filename-guard');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const { adapters, calls } = makeFakes();

  await assert.rejects(() =>
    runTurn({
      audioBuffer: Buffer.from('bytes'),
      adapters,
      sttConfig: {},
      openclawConfig: { sessionId },
      ttsConfig: {},
      audioFilename: 'a/b.wav',
    }),
  );

  assert.equal(calls.transcribe, 0);
  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

// --- Lock span and ordering ---

test('after a successful turn the lock artifact does not exist', async () => {
  const sessionId = uniqueSessionId('lock-after-success');
  const { adapters } = makeFakes();

  await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });

  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
});

test('a throwing agent fake propagates the original error unchanged and still releases the lock', async () => {
  const sessionId = uniqueSessionId('lock-after-throw');
  const boom = new Error('agent exploded');
  const adapters = {
    transcribe: async () => ({ text: 'hi', meta: {} }),
    agent: async () => {
      throw boom;
    },
    speak: async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mp4', meta: {} }),
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
    (err) => err === boom,
  );

  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
});

test('lock span: the artifact and its holder metadata exist while the agent stage runs, and are gone after', async () => {
  const sessionId = uniqueSessionId('lock-span');
  let sawLockDuringAgent = false;
  let sawHolderFile = false;

  const adapters = {
    transcribe: async () => ({ text: 'hi', meta: {} }),
    agent: async () => {
      const lockPath = turnLockPathFor(sessionId);
      sawLockDuringAgent = fs.existsSync(lockPath);
      sawHolderFile = fs.existsSync(path.join(lockPath, 'holder.json'));
      return { text: 'ok', rawText: 'OK', meta: {} };
    },
    speak: async () => ({ audioBuffer: Buffer.from('x'), mimeType: 'audio/mp4', meta: {} }),
  };

  await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });

  assert.equal(sawLockDuringAgent, true, 'the agent stage runs inside the critical section');
  assert.equal(sawHolderFile, true, 'the lock directory must carry the holder metadata file');
  assert.equal(fs.existsSync(turnLockPathFor(sessionId)), false);
});

test('an already-held lock causes runTurn to reject with TurnBusyError without calling any adapter', async () => {
  const sessionId = uniqueSessionId('busy');
  assert.ok(acquireTurnLock(sessionId));
  try {
    const { adapters, calls } = makeFakes();
    await assert.rejects(
      () =>
        runTurn({
          audioBuffer: Buffer.from('bytes'),
          adapters,
          sttConfig: {},
          openclawConfig: { sessionId },
          ttsConfig: {},
        }),
      (err) => err instanceof TurnBusyError,
    );
    assert.equal(calls.transcribe, 0);
  } finally {
    releaseTurnLock(sessionId);
  }
});

test('source assertion: the lock-acquisition call precedes the first await in runTurn', () => {
  const declIndex = PIPELINE_SOURCE.indexOf('export async function runTurn(');
  assert.ok(declIndex >= 0, 'runTurn must be declared as an exported async function');
  const body = PIPELINE_SOURCE.slice(declIndex);
  const acquireIndex = body.indexOf('acquireTurnLock(');
  const awaitIndex = body.indexOf('await ');
  assert.ok(acquireIndex >= 0, 'runTurn must call acquireTurnLock');
  assert.ok(awaitIndex >= 0, 'runTurn must contain an await');
  assert.ok(
    acquireIndex < awaitIndex,
    `acquireTurnLock (source index ${acquireIndex}) must precede the first await (source index ${awaitIndex})`,
  );
});

// --- Temp hygiene and format-agnosticism ---

test('temp hygiene: the pipeline temp-prefix entry set is unchanged across a successful turn', async () => {
  const sessionId = uniqueSessionId('temp-hygiene');
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const { adapters } = makeFakes();

  await runTurn({
    audioBuffer: Buffer.from('bytes'),
    adapters,
    sttConfig: {},
    openclawConfig: { sessionId },
    ttsConfig: {},
    wantAudio: false,
  });

  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('source assertion: turn-pipeline.js imports nothing from Phase 1\'s format-conversion directory', () => {
  const specifiers = [...PIPELINE_SOURCE.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, 'expected at least one import in turn-pipeline.js');
  for (const specifier of specifiers) {
    assert.ok(!specifier.includes('/audio/'), `${specifier} must not resolve into the format-conversion directory`);
  }
});

// --- withTempDir and lock primitives, exercised directly ---

test('withTempDir resolves the callback value and removes the directory', async () => {
  let capturedDir;
  const result = await withTempDir('vbtest-tempfiles-', async (dir) => {
    capturedDir = dir;
    assert.ok(fs.existsSync(dir));
    return 'callback-value';
  });
  assert.equal(result, 'callback-value');
  assert.equal(fs.existsSync(capturedDir), false);
});

test('withTempDir removes the directory and re-raises unchanged when the callback throws', async () => {
  let capturedDir;
  const boom = new Error('callback exploded');
  await assert.rejects(
    () =>
      withTempDir('vbtest-tempfiles-', async (dir) => {
        capturedDir = dir;
        throw boom;
      }),
    (err) => err === boom,
  );
  assert.equal(fs.existsSync(capturedDir), false);
});

test('releaseTurnLock for a session that holds nothing does not throw', () => {
  const sessionId = uniqueSessionId('release-unheld');
  assert.doesNotThrow(() => releaseTurnLock(sessionId));
});
