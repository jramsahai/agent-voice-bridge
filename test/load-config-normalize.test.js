// The in-memory migration of the pre-provider `openclaw` config key, and validateConfig's
// refusal of a config that still carries it after loading.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../packages/shared/config/load-config.js';
import { validateConfig } from '../packages/shared/config/validate-config.js';

function validAgentConfig() {
  return {
    server: { host: '127.0.0.1', port: 4318 },
    security: {
      clients: { browser: 'a-genuinely-long-browser-secret-value' },
      expectedHost: 'device.example.ts.net',
      allowedOrigins: ['https://device.example.ts.net'],
    },
    stt: { provider: 'whisper-local', command: './scripts/whisper-audio' },
    agent: { provider: 'openclaw', command: 'openclaw', sessionId: 'voice' },
    tts: { provider: 'macos-say' },
  };
}

test('a lone openclaw key becomes agent with provider openclaw, with one warning naming the rename', () => {
  const { config, warnings } = normalizeConfig({ server: {}, openclaw: { command: 'openclaw', sessionId: 's', thinking: 'low' } });
  assert.deepEqual(config.agent, { provider: 'openclaw', command: 'openclaw', sessionId: 's', thinking: 'low' });
  assert.equal('openclaw' in config, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"openclaw" was renamed to "agent"/);
});

test('a config already using agent passes through untouched, with no warning', () => {
  const input = validAgentConfig();
  const { config, warnings } = normalizeConfig(input);
  assert.equal(config, input);
  assert.deepEqual(warnings, []);
});

test('a config carrying both keys is not migrated, and validateConfig rejects the leftover', () => {
  const input = { ...validAgentConfig(), openclaw: { command: 'openclaw', sessionId: 'old' } };
  const { config, warnings } = normalizeConfig(input);
  assert.equal(config, input);
  assert.deepEqual(warnings, []);
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('"openclaw" was renamed to "agent"')));
});

test('validateConfig accepts every shipped provider and names the vocabulary for an unknown one', () => {
  for (const provider of ['openclaw', 'hermes', 'command']) {
    const config = validAgentConfig();
    config.agent.provider = provider;
    assert.deepEqual(validateConfig(config), [], `provider ${provider} must validate`);
  }
  const config = validAgentConfig();
  config.agent.provider = 'nope';
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('agent.provider must be one of: openclaw, hermes, command')));
});
