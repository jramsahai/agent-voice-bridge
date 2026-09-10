// The Hermes CLI provider. No real `hermes` binary is involved: every test points
// agent.command at a stub script. What is pinned here is the argument shape the adapter
// emits and the once-per-session priming it shares with the OpenClaw adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sendTurnToHermes, buildHermesArgs, DEFAULT_HERMES_ARGS } from '../packages/shared/adapters/agent-hermes-cli.js';
import { SESSION_STATE_DIR } from '../packages/shared/adapters/agent-session.js';

function uniqueLabel(label) {
  return `vbtest-hermescli-${label}-${randomUUID()}`;
}

function writeArgvStub(dir) {
  // Prints every argument on its own line so a test can read back the exact argv.
  const scriptPath = path.join(dir, 'hermes-stub.sh');
  fs.writeFileSync(scriptPath, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n', { mode: 0o755 });
  return scriptPath;
}

test('buildHermesArgs emits the one-shot prefix, the query, and a --resume for the configured session', () => {
  assert.deepEqual(buildHermesArgs('hello', { sessionId: 'voice' }), [...DEFAULT_HERMES_ARGS, '-q', 'hello', '--resume', 'voice']);
  assert.deepEqual(buildHermesArgs('hello', {}), [...DEFAULT_HERMES_ARGS, '-q', 'hello']);
});

test('buildHermesArgs lets agent.args replace the fixed prefix for a differing Hermes version', () => {
  assert.deepEqual(buildHermesArgs('hi', { args: ['-z'], sessionId: 's' }), ['-z', '-q', 'hi', '--resume', 's']);
});

test('sendTurnToHermes primes the session exactly once, then sends only the transcript', async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-hermescli-stub-'));
  const sessionId = uniqueLabel('session');
  const statePath = path.join(SESSION_STATE_DIR, `${sessionId}.json`);
  try {
    const stub = writeArgvStub(stubDir);
    assert.equal(fs.existsSync(statePath), false);

    const first = await sendTurnToHermes('hello', { command: stub, sessionId }, {});
    assert.equal(fs.existsSync(statePath), true, 'the first turn must record the priming');
    // The turn itself carries the transcript, not the priming text.
    assert.deepEqual(first.meta.args, [...DEFAULT_HERMES_ARGS, '-q', 'hello', '--resume', sessionId]);
    assert.equal(first.rawText, first.meta.args.join('\n'));

    const before = fs.readFileSync(statePath, 'utf8');
    const second = await sendTurnToHermes('again', { command: stub, sessionId }, {});
    assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'a second turn must not re-prime');
    assert.deepEqual(second.meta.args, [...DEFAULT_HERMES_ARGS, '-q', 'again', '--resume', sessionId]);
  } finally {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test('sendTurnToHermes rejects a sessionId that could become a path component', async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-hermescli-stub-'));
  try {
    const stub = writeArgvStub(stubDir);
    await assert.rejects(() => sendTurnToHermes('hi', { command: stub, sessionId: '../escape' }, {}), /path separator/);
    await assert.rejects(() => sendTurnToHermes('hi', { command: stub, sessionId: '..' }, {}), /must not be "\." or "\.\."/);
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test('sendTurnToHermes names the command when it cannot be found', async () => {
  await assert.rejects(
    () => sendTurnToHermes('hi', { command: '/nonexistent/hermes-xyz' }, {}),
    /Hermes CLI not found at "\/nonexistent\/hermes-xyz"/,
  );
});
