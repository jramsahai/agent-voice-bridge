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

import { sendTurnToOpenClaw, cleanTextForSpeech } from '../packages/shared/adapters/openclaw-cli.js';

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

// cleanTextForSpeech's emoji strip: a screenless device speaking pictograph names is a
// defect the client can't work around, so the strip is pinned with exact-string assertions
// covering plain pictographs, multi-code-point sequences (ZWJ, flags, keycaps, skin tone),
// and proof the legacy arrow/bullet/checkmark set and ordinary prose are unaffected.

test('cleanTextForSpeech removes plain pictographs, including a multi-emoji reply', () => {
  assert.equal(cleanTextForSpeech('Hello \u{1F600} world'), 'Hello world');
  assert.equal(cleanTextForSpeech('Great job \u{1F44D} \u{1F389} today'), 'Great job today');
});

test('cleanTextForSpeech removes ZWJ sequences, joiner included, with no orphan code point', () => {
  assert.equal(cleanTextForSpeech('Meet \u{1F468}‍\u{1F469}‍\u{1F467} today'), 'Meet today');
  assert.equal(cleanTextForSpeech('A \u{1F469}‍\u{1F4BB} arrived'), 'A arrived');
});

test('cleanTextForSpeech removes a regional-indicator flag sequence', () => {
  assert.equal(cleanTextForSpeech('Ship to \u{1F1FA}\u{1F1F8} now'), 'Ship to now');
});

test('cleanTextForSpeech strips a keycap sequence but retains the base digit', () => {
  assert.equal(cleanTextForSpeech('Step 1️⃣ then 2️⃣'), 'Step 1 then 2');
});

test('cleanTextForSpeech removes a skin-tone modifier attached to a base pictograph', () => {
  assert.equal(cleanTextForSpeech('Nice \u{1F44D}\u{1F3FD} job'), 'Nice job');
});

test('cleanTextForSpeech leaves ordinary text, digits, and punctuation byte-identical', () => {
  const prose = 'The meeting is at 3pm on Tuesday, and it costs $4.50.';
  assert.equal(cleanTextForSpeech(prose), prose);
});

test('cleanTextForSpeech still strips the legacy arrow/bullet/checkmark set', () => {
  assert.equal(cleanTextForSpeech('A → B • C ✓ D ✔ E'), 'A B C D E');
});

function writeEmojiStubOpenClaw(dir, reply) {
  const scriptPath = path.join(dir, 'openclaw-stub-emoji.sh');
  const payload = JSON.stringify({ reply });
  fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s' '${payload}'\n`, { mode: 0o755 });
  return scriptPath;
}

test('sendTurnToOpenClaw cleans emoji from text but leaves rawText verbatim, emoji included', async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-openclawcli-stub-'));
  const sessionId = uniqueLabel('emoji-invariant');
  const statePath = path.join(voiceSessionStateDir, `${sessionId}.json`);
  try {
    const reply = 'Great job \u{1F44D} today';
    const stubPath = writeEmojiStubOpenClaw(stubDir, reply);

    const result = await sendTurnToOpenClaw('hello', { command: stubPath, sessionId }, {});
    assert.equal(result.text, 'Great job today');
    assert.equal(result.rawText, reply);
  } finally {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }
});
