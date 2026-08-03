// WR-02: sendTurnToOpenClaw's own session-state path helpers (getSessionStatePath,
// hasSessionBeenPrimed, markSessionPrimed) previously derived a filesystem path from
// sessionId with zero validation of their own, relying entirely on turn-pipeline.js's
// upstream guard. This file exercises openclaw-cli.js directly — the one exported entry
// point, sendTurnToOpenClaw — with no upstream validation in the way, proving the module's
// own guard is now load-bearing rather than merely inherited.
//
// Every test here points openclawConfig.command at a small stub script written inside the
// test's own throwaway directory, so nothing depends on a real `openclaw` binary being
// installed. Every session id this file constructs carries a unique, high-entropy suffix so
// two runs (or two parallel test files sharing the same voiceSessionStateDir) can never
// collide on the same session-state artifact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { sendTurnToOpenClaw } from '../packages/shared/adapters/openclaw-cli.js';

function uniqueLabel(label) {
  return `vbtest-openclawcli-${label}-${randomUUID()}`;
}

const voiceSessionStateDir = path.join(os.tmpdir(), 'openclaw-voice-bridge-session-state');

function writeStubOpenClaw(dir) {
  const scriptPath = path.join(dir, 'openclaw-stub.sh');
  fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf \'%s\' \'{"reply":"stub reply"}\'\n', { mode: 0o755 });
  return scriptPath;
}

test('sendTurnToOpenClaw rejects a sessionId containing a path separator, and creates no session-state artifact anywhere', async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-openclawcli-stub-'));
  try {
    const stubPath = writeStubOpenClaw(stubDir);
    const marker = uniqueLabel('traversal-marker');
    const maliciousSessionId = `../../../../tmp/${marker}`;

    await assert.rejects(
      () => sendTurnToOpenClaw('hello', { command: stubPath, sessionId: maliciousSessionId }, {}),
      /path separator/,
    );

    // The would-be traversal target, resolved exactly as path.join would resolve it — must
    // never have been written.
    assert.equal(fs.existsSync(path.join(os.tmpdir(), 'tmp', `${marker}.json`)), false);
    assert.equal(fs.existsSync(path.join('/tmp', `${marker}.json`)), false);
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test('sendTurnToOpenClaw rejects a sessionId of ".." the same way as a separator-bearing id', async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-openclawcli-stub-'));
  try {
    const stubPath = writeStubOpenClaw(stubDir);
    await assert.rejects(
      () => sendTurnToOpenClaw('hello', { command: stubPath, sessionId: '..' }, {}),
      /must not be "\." or "\.\."/,
    );
  } finally {
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});

test('sendTurnToOpenClaw with a well-formed sessionId still primes and writes exactly the expected session-state file', async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-openclawcli-stub-'));
  const sessionId = uniqueLabel('valid-session');
  const statePath = path.join(voiceSessionStateDir, `${sessionId}.json`);
  try {
    const stubPath = writeStubOpenClaw(stubDir);
    assert.equal(fs.existsSync(statePath), false, 'sanity: no pre-existing state for a fresh unique session id');

    const result = await sendTurnToOpenClaw('hello', { command: stubPath, sessionId }, {});
    assert.equal(typeof result.text, 'string');
    assert.equal(fs.existsSync(statePath), true, 'a well-formed session id must still be primed and recorded');

    // A second turn against the same session must not re-prime (hasSessionBeenPrimed reads
    // the same guarded path successfully for a valid id).
    const before = fs.readFileSync(statePath, 'utf8');
    await sendTurnToOpenClaw('hello again', { command: stubPath, sessionId }, {});
    assert.equal(fs.readFileSync(statePath, 'utf8'), before, 'a second turn must not rewrite the priming marker');
  } finally {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});
