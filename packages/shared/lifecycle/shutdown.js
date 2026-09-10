// Signal handling that ends in-flight work through the same abort chain a client
// disconnect already uses (04-RESEARCH.md Pattern 3) — this module adds only a
// process-lifetime Set consumer and two signal handlers, no new cleanup mechanism.
// Aborting a tracked controller already cascades through runTurn()'s between-stage checks,
// releaseTurnLock's own finally, withTempDir's own finally, and every spawned child process
// (execFile's signal option, threaded through every adapter since Phase 2) — all four
// already fire today whenever a client disconnects mid-turn. This file needs no imports at
// all: it operates entirely on the injected server object and the injected
// process/exit-function references, never opening a socket or a network connection itself.

export const SHUTDOWN_TIMEOUT_MS = 10_000;

// installShutdownHandlers({ server, inFlightControllers, timeoutMs, processRef, exitFn })
// registers one handler per signal on processRef for both the terminate and the interrupt
// signal, each delegating to the same shared shutdown(signalName) function so the two entry
// points cannot drift. processRef and exitFn are injectable (matching runPreflightChecks'
// and validateRequest's own dependency-injection convention) so test/shutdown.test.js proves
// every branch — including the timeout branch and the second-signal branch — against doubles,
// registering no real signal handler and ending no real process.
export function installShutdownHandlers({
  server,
  inFlightControllers,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  processRef = process,
  exitFn = (code) => processRef.exit(code),
}) {
  let shuttingDown = false;

  // Every path through this function must reach exitFn exactly once and return immediately
  // after, since exitFn does not end control flow in a test the way a real process.exit()
  // would end control flow in production.
  async function shutdown(signalName) {
    if (shuttingDown) {
      // D-12: a second identical signal arriving during an in-progress shutdown exits
      // immediately with a non-zero code rather than restarting the sequence or waiting
      // again — an operator's second Ctrl-C should never read as a silent no-op.
      exitFn(1);
      return;
    }
    shuttingDown = true;

    // Only the signal name and, below, a count of in-flight turns are ever printed here —
    // no client name, no configured secret, no request detail (T-4-04).
    console.log(`[voice-bridge] received ${signalName}, shutting down`);

    const closed = new Promise((resolve) => server.close(resolve));

    // This is the entire cleanup mechanism: aborting propagates to the pipeline's
    // between-stage checks, to the turn lock's release, to the temp directory's removal,
    // and to every spawned child, because all four already run from this same signal today
    // whenever a client disconnects. No child-process registry, no second temp sweep.
    for (const controller of inFlightControllers) {
      controller.abort();
    }

    // The timer is cleared the moment the race settles, whichever side wins — an uncleared
    // timer would otherwise keep the event loop (and, in a test, the process) alive for the
    // remainder of timeoutMs even after shutdown has already decided its outcome.
    let timeoutHandle;
    const timeout = new Promise((resolve) => {
      timeoutHandle = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([closed, timeout]);
    clearTimeout(timeoutHandle);

    if (inFlightControllers.size > 0) {
      console.error(
        `[voice-bridge] shutdown timeout exceeded with ${inFlightControllers.size} turn(s) still in flight — forcing connections closed`,
      );
      // WR-02: server.close() only stops new TCP connections, not new HTTP requests
      // dispatched on a keep-alive socket that was already open when shutdown began. Such a
      // straggler's controller is added to inFlightControllers (request-handler.js) *after*
      // the single abort pass above already ran, so it would otherwise never receive an
      // abort signal — leaving its spawned child process (whisper-cli/agent CLI/tts-kokoro)
      // orphaned once this process exits. Re-scanning here, right before force-closing every
      // connection, catches any controller added since the first pass.
      for (const controller of inFlightControllers) {
        controller.abort();
      }
      server.closeAllConnections();
      exitFn(1);
      return;
    }

    exitFn(0);
  }

  processRef.on('SIGTERM', () => shutdown('SIGTERM'));
  processRef.on('SIGINT', () => shutdown('SIGINT'));

  return { shutdown };
}
