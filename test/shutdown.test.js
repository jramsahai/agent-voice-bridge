// Server-free proof of installShutdownHandlers' every branch (OPS-04, D-10 in
// 04-04-PLAN.md), driven entirely against a fake server, a fake process built on a plain
// event emitter, and an exit function that records every code it was called with. No real
// signal handler is ever registered, no real process is ever ended. This file is
// automatically swept into test/turn-suite-hygiene.test.js's PHASE_TEST_FILES because it
// imports from packages/shared/lifecycle/, which is why it declares its own
// uniqueSessionId(label) generator below even though shutdown handling never touches the
// turn lock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { installShutdownHandlers, SHUTDOWN_TIMEOUT_MS } from '../packages/shared/lifecycle/shutdown.js';

function uniqueSessionId(label) {
  return `vbtest-shutdown-${label}-${randomUUID()}`;
}

test('sanity: the required session id generator produces distinct values for the same label', () => {
  assert.notEqual(uniqueSessionId('sanity'), uniqueSessionId('sanity'));
});

// A fake server exposing only what installShutdownHandlers actually calls: close(callback)
// and closeAllConnections(). cooperative:true invokes the close callback on a later tick
// (via setImmediate) so a real Promise.race has something to race against; cooperative:false
// never invokes it, proving the timeout branch.
function makeFakeServer({ cooperative = true } = {}) {
  let closeCallCount = 0;
  let closeAllConnectionsCallCount = 0;
  return {
    close(callback) {
      closeCallCount += 1;
      if (cooperative) {
        setImmediate(callback);
      }
    },
    closeAllConnections() {
      closeAllConnectionsCallCount += 1;
    },
    get closeCallCount() {
      return closeCallCount;
    },
    get closeAllConnectionsCallCount() {
      return closeAllConnectionsCallCount;
    },
  };
}

// A fake process built on a plain EventEmitter — process.on('SIGTERM'/'SIGINT', ...) is all
// installShutdownHandlers ever calls on it, so emit('SIGTERM')/emit('SIGINT') drives the
// handler exactly the way a real signal would, without touching the real process object.
function makeFakeProcess() {
  return new EventEmitter();
}

function makeFakeExit() {
  const calls = [];
  const exitFn = (code) => {
    calls.push(code);
  };
  exitFn.calls = calls;
  return exitFn;
}

function makeControllers(count) {
  return new Set(Array.from({ length: count }, () => new AbortController()));
}

test('installing registers a handler for both the terminate and the interrupt signal on the fake process object', () => {
  const server = makeFakeServer();
  const processRef = makeFakeProcess();
  const exitFn = makeFakeExit();
  installShutdownHandlers({ server, inFlightControllers: new Set(), processRef, exitFn });

  assert.equal(processRef.listenerCount('SIGTERM'), 1);
  assert.equal(processRef.listenerCount('SIGINT'), 1);
});

test('emitting the terminate signal with an empty controller set closes the listener and ends with a zero exit code, without waiting out the timeout', async () => {
  const server = makeFakeServer({ cooperative: true });
  const processRef = makeFakeProcess();
  const exitFn = makeFakeExit();
  const inFlightControllers = new Set();
  const { shutdown } = installShutdownHandlers({
    server,
    inFlightControllers,
    processRef,
    exitFn,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  await shutdown('SIGTERM');

  assert.equal(server.closeCallCount, 1);
  assert.equal(server.closeAllConnectionsCallCount, 0);
  assert.deepEqual(exitFn.calls, [0]);
});

test('emitting either signal with two controllers in the set leaves both controllers\' signals aborted', async () => {
  const terminateControllers = makeControllers(2);
  const interruptControllers = makeControllers(2);

  const terminateHandlers = installShutdownHandlers({
    server: makeFakeServer(),
    inFlightControllers: terminateControllers,
    processRef: makeFakeProcess(),
    exitFn: makeFakeExit(),
  });
  await terminateHandlers.shutdown('SIGTERM');
  for (const controller of terminateControllers) {
    assert.equal(controller.signal.aborted, true);
  }

  const interruptHandlers = installShutdownHandlers({
    server: makeFakeServer(),
    inFlightControllers: interruptControllers,
    processRef: makeFakeProcess(),
    exitFn: makeFakeExit(),
  });
  await interruptHandlers.shutdown('SIGINT');
  for (const controller of interruptControllers) {
    assert.equal(controller.signal.aborted, true);
  }
});

test('a fake server whose close callback never fires, with a small timeoutMs and one controller left in the set, records the force-close call and ends with a non-zero exit code', async () => {
  const server = makeFakeServer({ cooperative: false });
  const processRef = makeFakeProcess();
  const exitFn = makeFakeExit();
  // A controller left in the set on purpose (never aborted-and-then-removed by any turn
  // handler in this doubles-only test) so inFlightControllers.size stays > 0 past the race —
  // this is what drives the force-close branch, distinct from server.close() never resolving.
  const inFlightControllers = makeControllers(1);

  const { shutdown } = installShutdownHandlers({
    server,
    inFlightControllers,
    processRef,
    exitFn,
    timeoutMs: 5,
  });

  await shutdown('SIGTERM');

  assert.equal(server.closeAllConnectionsCallCount, 1);
  assert.deepEqual(exitFn.calls, [1]);
});

test('a second signal emitted while the first shutdown is still in progress records an additional non-zero exit code and does not restart the sequence', async () => {
  const server = makeFakeServer({ cooperative: false });
  const processRef = makeFakeProcess();
  const exitFn = makeFakeExit();
  const inFlightControllers = new Set();

  const { shutdown } = installShutdownHandlers({
    server,
    inFlightControllers,
    processRef,
    exitFn,
    timeoutMs: 50,
  });

  const first = shutdown('SIGTERM');
  // Fires while the first shutdown's race is still pending (timeoutMs=50, cooperative:false
  // so server.close's callback never resolves the closed side of the race either).
  await shutdown('SIGTERM');

  assert.equal(server.closeCallCount, 1, 'the second signal must not call server.close a second time');
  assert.deepEqual(exitFn.calls, [1], 'the second signal exits immediately, before the first shutdown has settled');

  await first;
  assert.deepEqual(exitFn.calls, [1, 0], 'the first shutdown eventually settles and records its own exit code');
});

test('the recorded effects of the interrupt signal path deep-equal those of the terminate signal path', async () => {
  const terminateExit = makeFakeExit();
  const terminateServer = makeFakeServer({ cooperative: true });
  const terminateControllers = makeControllers(1);
  const terminateHandlers = installShutdownHandlers({
    server: terminateServer,
    inFlightControllers: terminateControllers,
    processRef: makeFakeProcess(),
    exitFn: terminateExit,
  });
  await terminateHandlers.shutdown('SIGTERM');

  const interruptExit = makeFakeExit();
  const interruptServer = makeFakeServer({ cooperative: true });
  const interruptControllers = makeControllers(1);
  const interruptHandlers = installShutdownHandlers({
    server: interruptServer,
    inFlightControllers: interruptControllers,
    processRef: makeFakeProcess(),
    exitFn: interruptExit,
  });
  await interruptHandlers.shutdown('SIGINT');

  assert.deepEqual(terminateExit.calls, interruptExit.calls);
  assert.equal(terminateServer.closeCallCount, interruptServer.closeCallCount);
  assert.equal(terminateServer.closeAllConnectionsCallCount, interruptServer.closeAllConnectionsCallCount);
  assert.equal([...terminateControllers][0].signal.aborted, [...interruptControllers][0].signal.aborted);
});

test('the exit function is recorded exactly once per shutdown invocation', async () => {
  const server = makeFakeServer({ cooperative: true });
  const exitFn = makeFakeExit();
  const { shutdown } = installShutdownHandlers({
    server,
    inFlightControllers: new Set(),
    processRef: makeFakeProcess(),
    exitFn,
  });

  await shutdown('SIGTERM');
  assert.equal(exitFn.calls.length, 1);
});

test('emitting a real signal on the fake process object drives the same shutdown function the returned shutdown() drives', async () => {
  const server = makeFakeServer({ cooperative: true });
  const processRef = makeFakeProcess();
  const exitFn = makeFakeExit();
  installShutdownHandlers({ server, inFlightControllers: new Set(), processRef, exitFn });

  processRef.emit('SIGTERM');
  // The handler installed on the fake process is fire-and-forget (an arrow function that
  // calls the async shutdown() without awaiting it), matching how a real signal listener
  // cannot await an async handler either — give the microtask queue a turn to let the
  // fake server's setImmediate-scheduled close callback fire and the shutdown settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(exitFn.calls, [0]);
});

// =====================================================================================
// Plan 04-05 (gap closure): 04-VERIFICATION.md gap 2 (WR-02) — a controller admitted to
// inFlightControllers after the first abort pass has already run must still be aborted,
// before server.closeAllConnections() and before exitFn. D-15: shutdown()'s body runs
// synchronously up to its first await (the Promise.race), so calling shutdown('SIGTERM')
// without awaiting it places a controller added afterward after the first pass as a fact
// of language semantics, not a timing hope.
// =====================================================================================

test('WR-02: a controller added to the in-flight set after the first abort pass has already run is still aborted, before the force-close call and before the exit function', async () => {
  const server = makeFakeServer({ cooperative: false });
  const processRef = makeFakeProcess();
  const exitFn = makeFakeExit();
  const inFlightControllers = makeControllers(1);
  const [earlyController] = inFlightControllers;

  const { shutdown } = installShutdownHandlers({
    server,
    inFlightControllers,
    processRef,
    exitFn,
    timeoutMs: 5,
  });

  const lateController = new AbortController();
  let closeAllConnectionsCountAtLateAbort = null;
  lateController.signal.addEventListener('abort', () => {
    closeAllConnectionsCountAtLateAbort = server.closeAllConnectionsCallCount;
  });

  const settled = shutdown('SIGTERM');

  // Asserts the premise rather than assuming it: the controller present at signal time is
  // already aborted at the moment the late controller is added below, which is what makes
  // "added after the first pass" a fact of this test rather than a hope about timing.
  assert.equal(earlyController.signal.aborted, true);

  inFlightControllers.add(lateController);

  await settled;

  assert.equal(lateController.signal.aborted, true);
  assert.equal(closeAllConnectionsCountAtLateAbort, 0);
  assert.equal(server.closeAllConnectionsCallCount, 1);
  assert.deepEqual(exitFn.calls, [1]);
});
