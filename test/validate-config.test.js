// Server-free proof of every documented invalid config shape (OPS-03) — pure unit suite over
// fixture objects, no filesystem, no server. Follows the flat node:test + node:assert/strict
// idiom test/error-response.test.js already established for this repo's other pure-function
// suites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  validateConfig,
  MIN_CLIENT_TOKEN_LENGTH,
  PLACEHOLDER_TOKEN_PREFIX,
} from '../packages/shared/config/validate-config.js';

const EXAMPLE_CONFIG_PATH = new URL('../config/config.example.json', import.meta.url);

function validConfig() {
  return {
    server: { host: '127.0.0.1', port: 4318 },
    security: {
      clients: {
        browser: 'a-genuinely-long-browser-secret-value',
        handheld: 'a-genuinely-long-handheld-secret-value',
      },
      expectedHost: 'device.example.ts.net',
      allowedOrigins: ['https://device.example.ts.net'],
      rateLimitWindowMs: 15_000,
      rateLimitMaxRequests: 6,
    },
    stt: { provider: 'whisper-local', command: './scripts/whisper-audio' },
    openclaw: { command: 'openclaw', sessionId: 'voice-bridge-mvp', thinking: 'low' },
    tts: { provider: 'kokoro-onnx', command: 'tts-kokoro', serviceUrl: 'http://127.0.0.1:4319' },
  };
}

function withMutation(mutate) {
  const config = validConfig();
  mutate(config);
  return config;
}

// --- Baseline: a valid config produces no errors ---

test('validateConfig(validConfig()) deep-equals []', () => {
  assert.deepEqual(validateConfig(validConfig()), []);
});

// --- Guard clauses: no config, an empty config, and a config missing security entirely ---

test('validateConfig throws when called with no argument at all', () => {
  assert.throws(() => validateConfig());
});

test('validateConfig throws for a bare empty object', () => {
  assert.throws(() => validateConfig({}));
});

test('validateConfig throws for a config whose security section is entirely absent', () => {
  assert.throws(() => validateConfig({ server: { host: '127.0.0.1', port: 4318 } }));
});

test('validateConfig throws for a non-object config (null, array, string, number)', () => {
  for (const bad of [null, [], 'a string', 42]) {
    assert.throws(() => validateConfig(bad));
  }
});

// --- 1. server.host / server.port ---

test('an empty or missing server.host produces an error naming server.host', () => {
  for (const host of ['', undefined, null, 42]) {
    const config = withMutation((c) => {
      c.server.host = host;
    });
    const errors = validateConfig(config);
    assert.ok(errors.length > 0);
    assert.ok(errors.join(' ').includes('server.host'));
  }
});

test('an out-of-range or non-integer server.port produces an error naming server.port', () => {
  for (const port of [0, 65536, -1, 1.5, 'abc', undefined]) {
    const config = withMutation((c) => {
      c.server.port = port;
    });
    const errors = validateConfig(config);
    assert.ok(errors.length > 0);
    assert.ok(errors.join(' ').includes('server.port'));
  }
});

// --- 2. security.clients presence and shape ---

test('security.clients absent, null, an array, a string, and {} each yield a non-empty error list naming security.clients', () => {
  for (const clients of [undefined, null, [], 'x', {}]) {
    const config = withMutation((c) => {
      if (clients === undefined) {
        delete c.security.clients;
      } else {
        c.security.clients = clients;
      }
    });
    const errors = validateConfig(config);
    assert.ok(errors.length > 0, `expected an error for security.clients = ${JSON.stringify(clients)}`);
    assert.ok(errors.join(' ').includes('security.clients'));
  }
});

test('removing the last entry from a one-client config produces an error', () => {
  const config = withMutation((c) => {
    c.security.clients = { onlyone: 'a-genuinely-long-secret-value-here' };
  });
  assert.deepEqual(validateConfig(config), []);
  config.security.clients = {};
  const errors = validateConfig(config);
  assert.ok(errors.length > 0);
  assert.ok(errors.join(' ').includes('security.clients'));
});

// --- 3/4. per-entry shape and token quality (D-08) ---

test('a non-string client token produces an error naming that client', () => {
  const config = withMutation((c) => {
    c.security.clients.browser = 12345;
  });
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('security.clients.browser')));
});

test('a token shorter than MIN_CLIENT_TOKEN_LENGTH produces an error naming the client and the minimum, never the token', () => {
  const shortToken = 'x'.repeat(MIN_CLIENT_TOKEN_LENGTH - 1);
  const config = withMutation((c) => {
    c.security.clients.browser = shortToken;
  });
  const errors = validateConfig(config);
  const joined = errors.join(' ');
  assert.ok(joined.includes('security.clients.browser'));
  assert.ok(joined.includes(String(MIN_CLIENT_TOKEN_LENGTH)));
  assert.ok(!joined.includes(shortToken));
});

test('a token beginning with PLACEHOLDER_TOKEN_PREFIX produces an error naming the client, never the token', () => {
  const placeholderToken = `${PLACEHOLDER_TOKEN_PREFIX}something-long-enough-to-pass-length`;
  const config = withMutation((c) => {
    c.security.clients.browser = placeholderToken;
  });
  const errors = validateConfig(config);
  const joined = errors.join(' ');
  assert.ok(joined.includes('security.clients.browser'));
  assert.ok(!joined.includes(placeholderToken));
});

// --- 5. duplicate-token detection (AUTH-02 revocation independence) ---

test('two clients sharing one token value produce an error naming both client names, never the shared token', () => {
  const sharedToken = 'a-shared-genuinely-long-secret-value';
  const config = withMutation((c) => {
    c.security.clients = { browser: sharedToken, handheld: sharedToken };
  });
  const errors = validateConfig(config);
  const joined = errors.join(' ');
  assert.ok(joined.includes('security.clients.browser'));
  assert.ok(joined.includes('security.clients.handheld'));
  assert.ok(!joined.includes(sharedToken));
});

test('two clients whose tokens differ by exactly one character produce no error', () => {
  const config = withMutation((c) => {
    c.security.clients = {
      browser: 'a-genuinely-long-secret-value-aaaa1',
      handheld: 'a-genuinely-long-secret-value-aaaa2',
    };
  });
  assert.deepEqual(validateConfig(config), []);
});

// --- 6. leftover pre-Phase-4 security.token key ---

test('a config carrying the pre-Phase-4 singular security.token key yields an error naming security.clients as the replacement', () => {
  const config = withMutation((c) => {
    c.security.token = 'some-old-shared-secret';
  });
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('security.clients')));
});

// --- 7. allowedOrigins / rate-limit numbers ---

test('a non-array or non-string-array allowedOrigins produces an error', () => {
  for (const bad of ['not-an-array', ['ok', 42], {}]) {
    const config = withMutation((c) => {
      c.security.allowedOrigins = bad;
    });
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('security.allowedOrigins')));
  }
});

test('a non-finite or non-positive rateLimitWindowMs produces an error', () => {
  for (const bad of [0, -1, NaN, Infinity, 'x']) {
    const config = withMutation((c) => {
      c.security.rateLimitWindowMs = bad;
    });
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('security.rateLimitWindowMs')));
  }
});

test('a non-finite or non-positive rateLimitMaxRequests produces an error', () => {
  for (const bad of [0, -1, NaN, Infinity, 'x']) {
    const config = withMutation((c) => {
      c.security.rateLimitMaxRequests = bad;
    });
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('security.rateLimitMaxRequests')));
  }
});

// --- 8. stt / openclaw ---

test('an empty or missing stt.command produces an error', () => {
  for (const bad of ['', undefined]) {
    const config = withMutation((c) => {
      if (bad === undefined) delete c.stt.command;
      else c.stt.command = bad;
    });
    const errors = validateConfig(config);
    assert.ok(errors.some((e) => e.includes('stt.command')));
  }
});

test('an empty or missing openclaw.command produces an error', () => {
  const config = withMutation((c) => {
    c.openclaw.command = '';
  });
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('openclaw.command')));
});

test('an empty or missing openclaw.sessionId produces an error', () => {
  const config = withMutation((c) => {
    delete c.openclaw.sessionId;
  });
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('openclaw.sessionId')));
});

// --- 9. tts ---

test('an unrecognised tts.provider produces an error naming the real provider vocabulary', () => {
  const config = withMutation((c) => {
    c.tts.provider = 'not-a-real-provider';
  });
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('tts.provider')));
});

test('tts.provider kokoro-onnx with a missing tts.command produces an error', () => {
  const config = withMutation((c) => {
    c.tts.provider = 'kokoro-onnx';
    delete c.tts.command;
  });
  const errors = validateConfig(config);
  assert.ok(errors.some((e) => e.includes('tts.command')));
});

test('tts.provider macos-say never requires tts.command', () => {
  const config = withMutation((c) => {
    c.tts = { provider: 'macos-say' };
  });
  assert.deepEqual(validateConfig(config), []);
});

// --- Multiple independent problems in one pass ---

test('a config with three independent problems yields an error list of length 3', () => {
  const config = withMutation((c) => {
    c.server.host = '';
    c.stt.command = '';
    c.openclaw.command = '';
  });
  const errors = validateConfig(config);
  assert.equal(errors.length, 3);
});

// --- The shipped example config is deliberately non-bootable ---

test('the shipped config/config.example.json, parsed and validated, yields exactly the placeholder-token errors and nothing else', () => {
  const raw = fs.readFileSync(EXAMPLE_CONFIG_PATH, 'utf8');
  const exampleConfig = JSON.parse(raw);
  const errors = validateConfig(exampleConfig);
  assert.ok(errors.length > 0, 'the shipped example config must be intentionally non-bootable');
  for (const error of errors) {
    assert.ok(
      error.includes(PLACEHOLDER_TOKEN_PREFIX) || /still carries the shipped example placeholder token/.test(error),
      `unexpected non-placeholder error from the example config: ${error}`,
    );
  }
  for (const clientName of Object.keys(exampleConfig.security.clients)) {
    assert.ok(
      errors.some((error) => error.includes(`security.clients.${clientName}`)),
      `expected an error naming client '${clientName}'`,
    );
  }
});

// --- No message may ever contain a fixture's own configured token value ---

test('for every invalid fixture above, the joined error text contains none of that fixture\'s own token values', () => {
  const fixtures = [
    withMutation((c) => {
      c.security.clients.browser = 'x'.repeat(MIN_CLIENT_TOKEN_LENGTH - 1);
    }),
    withMutation((c) => {
      c.security.clients.browser = `${PLACEHOLDER_TOKEN_PREFIX}a-secret-that-is-otherwise-long-enough`;
    }),
    withMutation((c) => {
      const shared = 'a-shared-token-value-that-is-long-enough';
      c.security.clients = { browser: shared, handheld: shared };
    }),
  ];
  for (const config of fixtures) {
    const errors = validateConfig(config);
    assert.ok(errors.length > 0, 'sanity: fixture must actually be invalid');
    const joined = errors.join(' ');
    for (const token of Object.values(config.security.clients)) {
      if (typeof token !== 'string') continue;
      assert.ok(!joined.includes(token), `error text must not contain configured token '${token}'`);
    }
  }
});
