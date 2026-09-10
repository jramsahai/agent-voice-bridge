// The provider selector the server hands the pipeline as adapters.agent, and the command
// each provider asks preflight and the health probe to resolve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sendTurnToAgent, getAgentCommand, getAgentProvider, AGENT_PROVIDERS, DEFAULT_AGENT_PROVIDER } from '../packages/shared/adapters/agent.js';

test('the provider vocabulary is exactly the three shipped adapters, defaulting to openclaw', () => {
  assert.deepEqual(AGENT_PROVIDERS, ['openclaw', 'hermes', 'command']);
  assert.equal(DEFAULT_AGENT_PROVIDER, 'openclaw');
  assert.equal(getAgentProvider({}), 'openclaw');
  assert.equal(getAgentProvider({ provider: 'hermes' }), 'hermes');
});

test('getAgentCommand returns the configured command, else the provider default', () => {
  assert.equal(getAgentCommand({ command: '/opt/x/openclaw' }), '/opt/x/openclaw');
  assert.equal(getAgentCommand({ provider: 'hermes', command: '/opt/x/hermes' }), '/opt/x/hermes');
  assert.equal(getAgentCommand({ provider: 'command', command: './my-agent' }), './my-agent');
  assert.equal(getAgentCommand({ provider: 'command' }), '');
  const savedOpenClaw = process.env.OPENCLAW_BIN;
  const savedHermes = process.env.HERMES_BIN;
  delete process.env.OPENCLAW_BIN;
  delete process.env.HERMES_BIN;
  try {
    assert.equal(getAgentCommand({}), 'openclaw');
    assert.equal(getAgentCommand({ provider: 'hermes' }), 'hermes');
  } finally {
    if (savedOpenClaw !== undefined) process.env.OPENCLAW_BIN = savedOpenClaw;
    if (savedHermes !== undefined) process.env.HERMES_BIN = savedHermes;
  }
});

test('sendTurnToAgent routes to the command provider and rejects an unknown one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-agentdispatch-'));
  try {
    const stub = path.join(dir, 'stub.sh');
    fs.writeFileSync(stub, '#!/bin/sh\nread line; printf \'via command: %s\' "$line"\n', { mode: 0o755 });
    const result = await sendTurnToAgent('ping', { provider: 'command', command: stub, sessionId: 'unused' }, {});
    assert.equal(result.rawText, 'via command: ping');
    await assert.rejects(() => sendTurnToAgent('ping', { provider: 'mystery' }, {}), /Unsupported agent provider: mystery/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
