// Proves getBackendStatus's call-count, boundary, failure, and reset semantics with
// injected fake probes and an injected clock — no real sleeping, no network. This file
// imports only from packages/shared/health/backend-health-cache.js, which itself performs
// no I/O of its own, so the whole suite runs in milliseconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getBackendStatus,
  resetBackendHealthCache,
  PROBE_TTL_MS,
  BACKEND_UP,
  BACKEND_DOWN,
} from '../packages/shared/health/backend-health-cache.js';

function makeCountingProbe(behavior = () => Promise.resolve()) {
  let count = 0;
  const probe = async () => {
    count += 1;
    return behavior();
  };
  return { probe, callCount: () => count };
}

function makeClock(startMs) {
  let current = startMs;
  return {
    now: () => current,
    set(ms) {
      current = ms;
    },
  };
}

// Called before every test in this file so files running in parallel under `node --test`
// cannot see each other's cached entries.
test.beforeEach(() => {
  resetBackendHealthCache();
});

test('an empty cache calls the probe exactly once and resolves BACKEND_UP when the probe resolves', async () => {
  const { probe, callCount } = makeCountingProbe();
  const verdict = await getBackendStatus('speech', probe);
  assert.equal(verdict, BACKEND_UP);
  assert.equal(callCount(), 1);
});

test('ten sequential calls inside one window leave the probe call count at 1', async () => {
  const { probe, callCount } = makeCountingProbe();
  for (let i = 0; i < 10; i += 1) {
    // Sequential by design — this is the call-count guarantee the cache exists to provide.
    // eslint-disable-next-line no-await-in-loop
    await getBackendStatus('speech', probe);
  }
  assert.equal(callCount(), 1);
});

test('a call one millisecond before the TTL boundary serves the cached verdict, and the boundary instant itself re-probes', async () => {
  const base = 1_000_000;
  const clock = makeClock(base);
  const { probe, callCount } = makeCountingProbe();

  await getBackendStatus('speech', probe, { now: clock.now });
  assert.equal(callCount(), 1);

  clock.set(base + PROBE_TTL_MS - 1);
  await getBackendStatus('speech', probe, { now: clock.now });
  assert.equal(callCount(), 1, 'one millisecond before the boundary must still serve the cached verdict');

  clock.set(base + PROBE_TTL_MS);
  await getBackendStatus('speech', probe, { now: clock.now });
  assert.equal(callCount(), 2, 'the boundary instant itself must re-probe, not serve the cached verdict');
});

test('a probe that rejects resolves BACKEND_DOWN rather than rejecting', async () => {
  const { probe, callCount } = makeCountingProbe(() => Promise.reject(new Error('probe failed')));
  const verdict = await getBackendStatus('speech', probe);
  assert.equal(verdict, BACKEND_DOWN);
  assert.equal(callCount(), 1);
});

test('after a rejecting probe caches a down verdict, a second call inside the window returns BACKEND_DOWN with the probe call count still 1', async () => {
  const { probe, callCount } = makeCountingProbe(() => Promise.reject(new Error('down')));
  const first = await getBackendStatus('down-backend', probe);
  const second = await getBackendStatus('down-backend', probe);
  assert.equal(first, BACKEND_DOWN);
  assert.equal(second, BACKEND_DOWN);
  assert.equal(callCount(), 1);
});

test('a cached down verdict is re-probed on the same schedule an up verdict is, at the exact TTL boundary', async () => {
  const base = 2_000_000;
  const clock = makeClock(base);
  const { probe, callCount } = makeCountingProbe(() => Promise.reject(new Error('down')));

  await getBackendStatus('speech', probe, { now: clock.now });
  assert.equal(callCount(), 1);

  clock.set(base + PROBE_TTL_MS - 1);
  await getBackendStatus('speech', probe, { now: clock.now });
  assert.equal(callCount(), 1);

  clock.set(base + PROBE_TTL_MS);
  await getBackendStatus('speech', probe, { now: clock.now });
  assert.equal(callCount(), 2);
});

test('two distinct backend names each drive exactly one probe call across two independent windows', async () => {
  const speech = makeCountingProbe();
  const agent = makeCountingProbe();

  await getBackendStatus('speech', speech.probe);
  await getBackendStatus('agent', agent.probe);
  await getBackendStatus('speech', speech.probe);
  await getBackendStatus('agent', agent.probe);

  assert.equal(speech.callCount(), 1);
  assert.equal(agent.callCount(), 1);
});

test('resetBackendHealthCache empties every entry, so the next call for a previously cached name drives one further probe call', async () => {
  const { probe, callCount } = makeCountingProbe();
  await getBackendStatus('speech', probe);
  assert.equal(callCount(), 1);

  resetBackendHealthCache();

  await getBackendStatus('speech', probe);
  assert.equal(callCount(), 2);
});
