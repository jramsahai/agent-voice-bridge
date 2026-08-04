// Server-free proof of runPreflightChecks' hard/soft classification (OPS-03, D-09 in
// 04-03-PLAN.md), driven entirely with injected fake probes — no real filesystem path, no
// real network, no server. This file is automatically swept into
// test/turn-suite-hygiene.test.js's PHASE_TEST_FILES because it imports from
// packages/shared/lifecycle/, which is why it declares its own uniqueSessionId(label)
// generator below even though preflight checks never touch the turn lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { runPreflightChecks } from '../packages/shared/lifecycle/preflight.js';

function uniqueSessionId(label) {
  return `vbtest-preflight-${label}-${randomUUID()}`;
}

test('sanity: the required session id generator produces distinct values for the same label', () => {
  assert.notEqual(uniqueSessionId('sanity'), uniqueSessionId('sanity'));
});

function buildConfig(overrides = {}) {
  return {
    stt: { command: 'whisper-cli' },
    openclaw: { command: 'openclaw' },
    tts: { provider: 'macos-say' },
    ...overrides,
  };
}

function makeFakeExecutableProbe({ rejectCommands = [] } = {}) {
  const calls = [];
  const fn = async (command) => {
    calls.push(command);
    if (rejectCommands.includes(command)) {
      throw new Error(`fake reject: ${command}`);
    }
  };
  fn.calls = calls;
  return fn;
}

function makeFakeServiceProbe({ shouldReject = false } = {}) {
  return async () => {
    if (shouldReject) {
      throw new Error('fake service reject');
    }
  };
}

test('a rejected stt.command probe produces exactly one error naming the command and zero warnings', async () => {
  const config = buildConfig();
  const { errors, warnings } = await runPreflightChecks({
    config,
    probeExecutableFn: makeFakeExecutableProbe({ rejectCommands: ['whisper-cli'] }),
    probeHttpServiceFn: makeFakeServiceProbe(),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /whisper-cli/);
  assert.deepEqual(warnings, []);
});

test('a rejected openclaw.command probe produces exactly one error naming the command and zero warnings', async () => {
  const config = buildConfig();
  const { errors, warnings } = await runPreflightChecks({
    config,
    probeExecutableFn: makeFakeExecutableProbe({ rejectCommands: ['openclaw'] }),
    probeHttpServiceFn: makeFakeServiceProbe(),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /openclaw/);
  assert.deepEqual(warnings, []);
});

test('a rejected /usr/bin/afconvert probe produces exactly one error naming it and zero warnings', async () => {
  const config = buildConfig();
  const { errors, warnings } = await runPreflightChecks({
    config,
    probeExecutableFn: makeFakeExecutableProbe({ rejectCommands: ['/usr/bin/afconvert'] }),
    probeHttpServiceFn: makeFakeServiceProbe(),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /afconvert/);
  assert.deepEqual(warnings, []);
});

test('a rejected /usr/bin/say probe (macos-say provider) produces exactly one error and zero warnings', async () => {
  const config = buildConfig({ tts: { provider: 'macos-say' } });
  const { errors, warnings } = await runPreflightChecks({
    config,
    probeExecutableFn: makeFakeExecutableProbe({ rejectCommands: ['/usr/bin/say'] }),
    probeHttpServiceFn: makeFakeServiceProbe(),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\/usr\/bin\/say/);
  assert.deepEqual(warnings, []);
});

test('a rejected speech-service probe (kokoro-onnx provider) produces exactly one warning and zero errors', async () => {
  const config = buildConfig({
    tts: { provider: 'kokoro-onnx', command: 'tts-kokoro', serviceUrl: 'http://127.0.0.1:4319' },
  });
  const { errors, warnings } = await runPreflightChecks({
    config,
    probeExecutableFn: makeFakeExecutableProbe(),
    probeHttpServiceFn: makeFakeServiceProbe({ shouldReject: true }),
  });
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
});

test('macos-say provider probes the system speech binary and never the ONNX spawn command', async () => {
  const config = buildConfig({ tts: { provider: 'macos-say' } });
  const probeExecutableFn = makeFakeExecutableProbe();
  await runPreflightChecks({ config, probeExecutableFn, probeHttpServiceFn: makeFakeServiceProbe() });
  assert.ok(probeExecutableFn.calls.includes('/usr/bin/say'));
  assert.ok(!probeExecutableFn.calls.includes('tts-kokoro'));
});

test('kokoro-onnx provider probes the spawn-fallback command and never the system speech binary', async () => {
  const config = buildConfig({ tts: { provider: 'kokoro-onnx', command: 'tts-kokoro' } });
  const probeExecutableFn = makeFakeExecutableProbe();
  await runPreflightChecks({ config, probeExecutableFn, probeHttpServiceFn: makeFakeServiceProbe() });
  assert.ok(probeExecutableFn.calls.includes('tts-kokoro'));
  assert.ok(!probeExecutableFn.calls.includes('/usr/bin/say'));
});

test('with every injected probe resolving, both errors and warnings deep-equal []', async () => {
  const config = buildConfig({ tts: { provider: 'kokoro-onnx', command: 'tts-kokoro' } });
  const { errors, warnings } = await runPreflightChecks({
    config,
    probeExecutableFn: makeFakeExecutableProbe(),
    probeHttpServiceFn: makeFakeServiceProbe(),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('messages are emitted in the fixed declaration order regardless of which injected probe settles first', async () => {
  const config = buildConfig({
    tts: { provider: 'kokoro-onnx', command: 'tts-kokoro-fail', serviceUrl: 'http://127.0.0.1:9999' },
  });
  const delays = { 'whisper-cli': 30, openclaw: 10, '/usr/bin/afconvert': 5, 'tts-kokoro-fail': 20 };
  const probeExecutableFn = async (command) => {
    await new Promise((resolve) => setTimeout(resolve, delays[command] ?? 0));
    if (command === 'whisper-cli' || command === 'tts-kokoro-fail') {
      throw new Error(`fake reject: ${command}`);
    }
  };
  const probeHttpServiceFn = async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    throw new Error('fake service reject');
  };
  const { errors, warnings } = await runPreflightChecks({ config, probeExecutableFn, probeHttpServiceFn });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /whisper-cli/);
  assert.match(errors[1], /tts-kokoro-fail/);
  assert.equal(warnings.length, 1);
});

test('the injected executable probe is only ever asked about command strings, and the fake never spawns a process', async () => {
  const config = buildConfig();
  const probeExecutableFn = makeFakeExecutableProbe();
  await runPreflightChecks({ config, probeExecutableFn, probeHttpServiceFn: makeFakeServiceProbe() });
  assert.ok(probeExecutableFn.calls.length > 0);
  for (const call of probeExecutableFn.calls) {
    assert.equal(typeof call, 'string');
  }
});
