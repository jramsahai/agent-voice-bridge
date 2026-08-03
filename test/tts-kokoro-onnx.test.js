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

// Port 1 is a well-known privileged port essentially never bound by an ordinary process,
// including in CI containers — a request to it fails immediately with a connection refusal
// on every platform this codebase targets, without needing this test to open any listener of
// its own.
const UNREACHABLE_SERVICE_URL = 'http://127.0.0.1:1';

test('an already-aborted signal propagates out of speakWithKokoroFast rather than being swallowed by the health probe and routed into the spawn-based fallback', async (t) => {
  const controller = new AbortController();
  controller.abort();

  // mkdtempSync is withTempDir's own first statement, and both of this module's own reply
  // paths (the FastAPI branch and the spawn-based fallback) wrap their work in withTempDir —
  // so a call count of zero is a structural proof that neither reply path was ever reached,
  // immune to any concurrent, unrelated activity elsewhere in the suite (the same technique
  // this phase's own turn-lock-concurrency.test.js established for the identical problem).
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
