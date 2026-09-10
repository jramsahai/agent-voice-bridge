// The generic command provider: any executable that takes a prompt and prints a reply.
// Every test points agent.command at a stub script written in a throwaway directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sendTurnToCommand, buildCommandArgs, TEXT_PLACEHOLDER } from '../packages/shared/adapters/agent-command.js';

async function withStubDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-agentcommand-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeStub(dir, body) {
  const scriptPath = path.join(dir, 'agent-stub.sh');
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return scriptPath;
}

test('buildCommandArgs substitutes every {text} placeholder and then sends nothing on stdin', () => {
  const { args, stdin } = buildCommandArgs('hello there', { args: ['--prompt', TEXT_PLACEHOLDER, '--echo', `[${TEXT_PLACEHOLDER}]`] });
  assert.deepEqual(args, ['--prompt', 'hello there', '--echo', '[hello there]']);
  assert.equal(stdin, null);
});

test('buildCommandArgs with no placeholder passes the args verbatim and the text on stdin', () => {
  const { args, stdin } = buildCommandArgs('hello', { args: ['--json'] });
  assert.deepEqual(args, ['--json']);
  assert.equal(stdin, 'hello\n');
});

test('sendTurnToCommand delivers the transcript on stdin when no argument carries the placeholder', async () => {
  await withStubDir(async (dir) => {
    const stub = writeStub(dir, 'read line; printf \'reply to: %s\' "$line"');
    const result = await sendTurnToCommand('what time is it', { command: stub }, {});
    assert.equal(result.rawText, 'reply to: what time is it');
    assert.equal(result.text, 'reply to what time is it');
    assert.deepEqual(result.meta.args, []);
  });
});

test('sendTurnToCommand delivers the transcript as an argument when the placeholder is used', async () => {
  await withStubDir(async (dir) => {
    const stub = writeStub(dir, 'printf \'%s|%s\' "$1" "$2"');
    const result = await sendTurnToCommand('hi', { command: stub, args: ['--message', TEXT_PLACEHOLDER] }, {});
    assert.equal(result.rawText, '--message|hi');
  });
});

test('sendTurnToCommand cleans the spoken text but leaves rawText verbatim', async () => {
  await withStubDir(async (dir) => {
    const stub = writeStub(dir, 'printf \'**Bold** reply \\xF0\\x9F\\x91\\x8D done\'');
    const result = await sendTurnToCommand('hi', { command: stub }, {});
    assert.equal(result.rawText, 'Bold reply \u{1F44D} done'.replace('Bold', '**Bold**'));
    assert.equal(result.text, 'Bold reply done');
  });
});

test('sendTurnToCommand rejects empty text and a missing command before spawning anything', async () => {
  await assert.rejects(() => sendTurnToCommand('   ', { command: '/bin/sh' }, {}), /non-empty text/);
  await assert.rejects(() => sendTurnToCommand('hi', {}, {}), /agent\.command/);
});

test('sendTurnToCommand names the command when it cannot be found', async () => {
  await assert.rejects(
    () => sendTurnToCommand('hi', { command: '/nonexistent/agent-binary-xyz' }, {}),
    /Agent command not found at "\/nonexistent\/agent-binary-xyz"/,
  );
});
