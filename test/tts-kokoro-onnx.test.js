// WR-03: the Kokoro FastAPI health probe previously swallowed a caller-initiated abort as
// "service down," letting speakWithKokoroFast fall through to the heavier spawn-based
// fallback for a caller that had already vanished. This file exercises the one exported
// entry point that reaches the health probe, speakWithKokoroFast, against a service url that
// nothing is listening on — the network call itself always fails fast on this host either
// way, so the only thing this test can distinguish is *why* it failed: a genuine abort must
// now propagate out of speakWithKokoroFast directly, rather than being swallowed and quietly
// routed into the fallback that spawns a real child process.
//
// This file deliberately imports only from packages/shared/adapters/tts-kokoro-onnx.js — not
// from this phase's own session/lifecycle/pipeline directories — so it stays outside
// test/turn-suite-hygiene.test.js's phase-scoped file set. It makes no live network call of
// its own; the one call this module makes is expected to fail immediately because nothing is
// listening on the target port, and the abort (already fired before the call starts) is what
// this test actually asserts propagated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { speakWithKokoroFast } from '../packages/shared/adapters/tts-kokoro-onnx.js';
import { probeExecutable } from '../packages/shared/health/probes.js';
import {
  getBackendStatus,
  resetBackendHealthCache,
  BACKEND_DOWN,
} from '../packages/shared/health/backend-health-cache.js';

// Port 1 is a well-known privileged port essentially never bound by an ordinary process,
// including in CI containers — a request to it fails immediately with a connection refusal
// on every platform this codebase targets, without needing this test to open any listener of
// its own.
const UNREACHABLE_SERVICE_URL = 'http://127.0.0.1:1';

test('an already-aborted signal propagates out of speakWithKokoroFast rather than being swallowed by the health probe and routed into the spawn-based fallback', async (t) => {
  const controller = new AbortController();
  controller.abort();

  // mkdtempSync is withTempDir's own first statement. Since plan 03-06, the spawn-based
  // fallback is the only reply path that creates a temp directory at all — the FastAPI
  // branch now returns the service's own WAV response body directly, with no afconvert
  // subprocess and no temp directory. So a call count of zero proves the fallback was never
  // reached; the FastAPI branch is separately excluded here because the service URL under
  // test is unreachable, immune to any concurrent, unrelated activity elsewhere in the suite
  // (the same technique this phase's own turn-lock-concurrency.test.js established for the
  // identical problem).
  const mkdtempSpy = t.mock.method(fs, 'mkdtempSync');

  await assert.rejects(() =>
    speakWithKokoroFast('hello', { serviceUrl: UNREACHABLE_SERVICE_URL }, { signal: controller.signal }),
  );

  assert.equal(
    mkdtempSpy.mock.callCount(),
    0,
    'the caller\'s own abort must propagate directly, never reaching either reply path\'s temp directory creation',
  );
});

test('a genuinely-down service (no abort in play) still falls through to the spawn-based fallback, proven by reaching its own distinct failure mode', async () => {
  // No signal at all this time — the health probe's rejection here is a real connection
  // refusal, not an abort, so it must still collapse to "not available" and let
  // speakWithKokoroFast proceed into the fallback exactly as before this fix. The fallback
  // then fails on its own missing-binary path (a command that does not exist on this host),
  // which is a structurally different failure than an abort — proving this call actually
  // reached the fallback rather than stopping at the health probe.
  await assert.rejects(
    () =>
      speakWithKokoroFast(
        'hello',
        { serviceUrl: UNREACHABLE_SERVICE_URL, command: '/nonexistent-tts-kokoro-binary-xyz' },
        {},
      ),
    (err) => {
      assert.notEqual(err.name, 'AbortError', 'a non-aborted call must not fail with an abort-shaped error');
      return true;
    },
  );
});

test('probeExecutable resolves for a command that exists and is executable, and rejects for a name that resolves nowhere on PATH', async () => {
  await assert.doesNotReject(() => probeExecutable(process.execPath));
  await assert.rejects(() => probeExecutable('this-command-does-not-exist-anywhere-xyz'));
});

// Proves the per-turn tax is gone (OPS-05): two speakWithKokoroFast calls against an
// unreachable service inside one TTL window must both reach the spawn fallback while the
// underlying reachability probe runs once. Asserted via the cache's own observable
// call-count behavior rather than by timing the calls, which would be flaky.
test('two speakWithKokoroFast calls against an unreachable service inside one TTL window read the cached speech verdict rather than re-probing', async () => {
  resetBackendHealthCache();

  let primingProbeCallCount = 0;
  const primingProbe = async () => {
    primingProbeCallCount += 1;
    throw new Error('unreachable');
  };

  // Prime the 'speech' entry ourselves so both speakWithKokoroFast calls below can only
  // observe a cache hit, never invoke their own probeHttpService closure.
  const primedVerdict = await getBackendStatus('speech', primingProbe);
  assert.equal(primedVerdict, BACKEND_DOWN);
  assert.equal(primingProbeCallCount, 1);

  const ttsConfig = { serviceUrl: UNREACHABLE_SERVICE_URL, command: '/nonexistent-tts-kokoro-binary-xyz' };
  await assert.rejects(() => speakWithKokoroFast('hello', ttsConfig, {}));
  await assert.rejects(() => speakWithKokoroFast('hello', ttsConfig, {}));

  // If either speakWithKokoroFast call above had re-probed, it would have done so through
  // its own closure, never through this fake — so a fresh counting fake for the same name
  // staying uncalled proves the 'speech' entry primingProbe wrote is still the one in the
  // cache, untouched by either speakWithKokoroFast call.
  let verifyingProbeCallCount = 0;
  const verifyingProbe = async () => {
    verifyingProbeCallCount += 1;
  };
  await getBackendStatus('speech', verifyingProbe);
  assert.equal(
    verifyingProbeCallCount,
    0,
    'the speech entry primed above must still be fresh, proving neither speakWithKokoroFast call re-probed',
  );
});

// DEBT-04 regression pins: speakWithFastApi coerced a configured speed through a truthiness
// fallback (`ttsConfig.speed || 1.0`), so a configured 0 silently became 1.0 — the operator
// who typed a speed the service will not honour got no signal at all. This section pins the
// resolver's explicit refuse-or-honour contract and the entry-point path-independence of the
// refusal.
//
// `resolveKokoroSpeed` and `DEFAULT_KOKORO_SPEED` are read via a runtime dynamic import
// rather than a static named import at the top of this file, because before this task's fix
// commit neither export exists yet. A static named import of a not-yet-existing export is an
// ES module link-time SyntaxError that fails the *entire* file before any test runs,
// destroying RED evidence for every test in it — not just this section's. This mirrors the
// technique 09-01-SUMMARY.md records for DEBT-05's MAX_CONTAINER_BYTES pin.
async function loadKokoroAdapterModule() {
  return import('../packages/shared/adapters/tts-kokoro-onnx.js');
}

test('DEBT-04: resolveKokoroSpeed returns the default for an absent speed and returns a valid speed unchanged', async () => {
  const { resolveKokoroSpeed, DEFAULT_KOKORO_SPEED } = await loadKokoroAdapterModule();
  assert.equal(resolveKokoroSpeed({}), DEFAULT_KOKORO_SPEED);
  assert.equal(resolveKokoroSpeed({ speed: undefined }), DEFAULT_KOKORO_SPEED);
  assert.equal(resolveKokoroSpeed({ speed: 0.75 }), 0.75);
  assert.equal(resolveKokoroSpeed({ speed: 2 }), 2);
});

test('DEBT-04: resolveKokoroSpeed throws for every value that cannot be honoured meaningfully, naming the config key', async () => {
  const { resolveKokoroSpeed } = await loadKokoroAdapterModule();
  const invalidSpeeds = [0, -1, NaN, Infinity, -Infinity, '1.0', null, true, {}];
  for (const speed of invalidSpeeds) {
    assert.throws(
      () => resolveKokoroSpeed({ speed }),
      (err) => {
        assert.ok(err.message.includes('tts.speed'), `message for ${String(speed)} must name the config key`);
        return true;
      },
      `resolveKokoroSpeed must throw for ${String(speed)}`,
    );
  }
});

test('DEBT-04: resolveKokoroSpeed truncates a rejected value longer than the bounded-echo limit rather than reflecting it whole', async () => {
  const { resolveKokoroSpeed } = await loadKokoroAdapterModule();
  const longValue = 'x'.repeat(300);
  assert.throws(
    () => resolveKokoroSpeed({ speed: longValue }),
    (err) => {
      assert.ok(!err.message.includes(longValue), 'the full 300-character value must not appear in the message');
      assert.ok(err.message.includes('x'.repeat(200)), 'the truncated 200-character prefix must still appear');
      return true;
    },
  );
});

test('DEBT-04: speakWithKokoroFast refuses a configured speed of 0 before reaching either reply path, with the speech backend down', async () => {
  resetBackendHealthCache();
  await assert.rejects(
    () =>
      speakWithKokoroFast(
        'hello',
        { speed: 0, serviceUrl: UNREACHABLE_SERVICE_URL, command: '/nonexistent-tts-kokoro-binary-xyz' },
        {},
      ),
    (err) => {
      assert.ok(err.message.includes('tts.speed'), 'the rejection must name the tts.speed config key');
      assert.ok(
        !err.message.includes('/nonexistent-tts-kokoro-binary-xyz'),
        "the rejection must be the speed refusal, not the spawn fallback's missing-binary failure",
      );
      return true;
    },
  );
});

test('DEBT-04: with no speed configured, speakWithKokoroFast still reaches the spawn fallback and fails on its own missing-binary path, unchanged', async () => {
  resetBackendHealthCache();
  await assert.rejects(
    () =>
      speakWithKokoroFast(
        'hello',
        { serviceUrl: UNREACHABLE_SERVICE_URL, command: '/nonexistent-tts-kokoro-binary-xyz' },
        {},
      ),
    (err) => {
      assert.ok(!err.message.includes('tts.speed'), 'a call with no speed key must not fail with the speed refusal');
      return true;
    },
  );
});

test('DEBT-04: an already-aborted signal still wins over the speed gate, even with an invalid speed configured', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      speakWithKokoroFast(
        'hello',
        { speed: 0, serviceUrl: UNREACHABLE_SERVICE_URL },
        { signal: controller.signal },
      ),
    (err) => {
      assert.equal(err.name, 'AbortError', 'an already-aborted caller must still win with the abort-shaped error');
      return true;
    },
  );
});

// WR-03: getKokoroServiceUrl now mirrors resolveKokoroSpeed's refuse-or-honour contract —
// only undefined falls through to env var / default. Any other falsy or non-string value
// (including '') is rejected by name rather than silently discarded through ||.
test('WR-03: getKokoroServiceUrl returns the default when serviceUrl is undefined', async () => {
  const { getKokoroServiceUrl } = await loadKokoroAdapterModule();

  const originalEnv = process.env.KOKORO_TTS_URL;
  try {
    delete process.env.KOKORO_TTS_URL;
    const url = getKokoroServiceUrl({});
    assert.equal(url, 'http://127.0.0.1:4319', 'must return the hardcoded default when env is unset');

    process.env.KOKORO_TTS_URL = 'http://custom:5000';
    const urlWithEnv = getKokoroServiceUrl({});
    assert.equal(urlWithEnv, 'http://custom:5000', 'must return the env var when set');
  } finally {
    if (originalEnv !== undefined) {
      process.env.KOKORO_TTS_URL = originalEnv;
    } else {
      delete process.env.KOKORO_TTS_URL;
    }
  }
});

test('WR-03: getKokoroServiceUrl returns a non-empty string serviceUrl unchanged', async () => {
  const { getKokoroServiceUrl } = await loadKokoroAdapterModule();
  const url = getKokoroServiceUrl({ serviceUrl: 'http://myhost:1234' });
  assert.equal(url, 'http://myhost:1234');
});

test('WR-03: getKokoroServiceUrl throws for an empty string serviceUrl', async () => {
  const { getKokoroServiceUrl } = await loadKokoroAdapterModule();
  assert.throws(
    () => getKokoroServiceUrl({ serviceUrl: '' }),
    (err) => {
      assert.ok(err.message.includes('tts.serviceUrl'), 'message must name the config key');
      return true;
    },
  );
});

test('WR-03: getKokoroServiceUrl throws for null serviceUrl', async () => {
  const { getKokoroServiceUrl } = await loadKokoroAdapterModule();
  assert.throws(
    () => getKokoroServiceUrl({ serviceUrl: null }),
    (err) => {
      assert.ok(err.message.includes('tts.serviceUrl'));
      return true;
    },
  );
});

test('WR-03: getKokoroServiceUrl throws for false serviceUrl', async () => {
  const { getKokoroServiceUrl } = await loadKokoroAdapterModule();
  assert.throws(
    () => getKokoroServiceUrl({ serviceUrl: false }),
    (err) => {
      assert.ok(err.message.includes('tts.serviceUrl'));
      return true;
    },
  );
});

test('WR-03: getKokoroServiceUrl throws for 0 serviceUrl', async () => {
  const { getKokoroServiceUrl } = await loadKokoroAdapterModule();
  assert.throws(
    () => getKokoroServiceUrl({ serviceUrl: 0 }),
    (err) => {
      assert.ok(err.message.includes('tts.serviceUrl'));
      return true;
    },
  );
});

test('WR-03: getKokoroServiceUrl throws for a non-string serviceUrl', async () => {
  const { getKokoroServiceUrl } = await loadKokoroAdapterModule();
  assert.throws(
    () => getKokoroServiceUrl({ serviceUrl: { host: 'localhost' } }),
    (err) => {
      assert.ok(err.message.includes('tts.serviceUrl'));
      return true;
    },
  );
});

// WR-04: the spawn-based fallback emits a console.error diagnostic when a configured tts.speed
// is ignored (i.e., when the speed is configured and not equal to DEFAULT_KOKORO_SPEED).
// This is the only diagnostic an operator gets when the fallback is used with a nondefault speed.
test('WR-04: speakWithKokoroFast logs a console.error to stdout when configured speed is ignored by spawn fallback', async () => {
  resetBackendHealthCache();
  const { DEFAULT_KOKORO_SPEED } = await loadKokoroAdapterModule();

  let capturedError = null;
  const originalConsoleError = console.error;
  try {
    console.error = (msg) => {
      capturedError = msg;
    };

    // Force the spawn fallback by using an unreachable service URL and a nonexistent command.
    // The fallback will fail on the missing-binary path after emitting the speed diagnostic.
    await assert.rejects(() =>
      speakWithKokoroFast(
        'hello',
        { serviceUrl: UNREACHABLE_SERVICE_URL, command: '/nonexistent-tts-kokoro-binary-xyz', speed: 0.75 },
        {},
      ),
    );

    assert.ok(
      capturedError && typeof capturedError === 'string',
      'console.error must have been called with a message about ignored speed',
    );
    assert.ok(
      capturedError.includes('tts.speed'),
      'the diagnostic must mention that tts.speed is configured',
    );
    assert.ok(
      capturedError.includes('spawn-based'),
      'the diagnostic must mention this is the spawn-based fallback',
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('WR-04: speakWithKokoroFast does not log the console.error when speed is absent', async () => {
  resetBackendHealthCache();

  let consoleErrorCalled = false;
  const originalConsoleError = console.error;
  try {
    console.error = () => {
      consoleErrorCalled = true;
    };

    // No speed configured this time — the diagnostic should not fire.
    await assert.rejects(() =>
      speakWithKokoroFast(
        'hello',
        { serviceUrl: UNREACHABLE_SERVICE_URL, command: '/nonexistent-tts-kokoro-binary-xyz' },
        {},
      ),
    );

    assert.equal(consoleErrorCalled, false, 'console.error must not be called when speed is absent');
  } finally {
    console.error = originalConsoleError;
  }
});

test('WR-04: speakWithKokoroFast does not log the console.error when speed equals DEFAULT_KOKORO_SPEED', async () => {
  resetBackendHealthCache();
  const { DEFAULT_KOKORO_SPEED } = await loadKokoroAdapterModule();

  let consoleErrorCalled = false;
  const originalConsoleError = console.error;
  try {
    console.error = () => {
      consoleErrorCalled = true;
    };

    // Speed equals the default — the diagnostic should not fire.
    await assert.rejects(() =>
      speakWithKokoroFast(
        'hello',
        { serviceUrl: UNREACHABLE_SERVICE_URL, command: '/nonexistent-tts-kokoro-binary-xyz', speed: DEFAULT_KOKORO_SPEED },
        {},
      ),
    );

    assert.equal(consoleErrorCalled, false, 'console.error must not be called when speed equals DEFAULT_KOKORO_SPEED');
  } finally {
    console.error = originalConsoleError;
  }
});

test('WR-04: resolveKokoroSpeed is called before the health probe, so an invalid speed is refused before the spawn fallback could be reached', async () => {
  resetBackendHealthCache();

  await assert.rejects(
    () =>
      speakWithKokoroFast(
        'hello',
        { serviceUrl: UNREACHABLE_SERVICE_URL, command: '/nonexistent-tts-kokoro-binary-xyz', speed: 0 },
        {},
      ),
    (err) => {
      assert.ok(err.message.includes('tts.speed'), 'the rejection must be the speed validation, not a spawn failure');
      return true;
    },
  );
});
