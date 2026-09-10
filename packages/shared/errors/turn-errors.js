// Typed pipeline failures carrying a stable machine-readable code. Real Error subclasses —
// not the buildError() envelope object 02-RESEARCH.md's illustrative code throws directly,
// which 02-PATTERNS.md flagged as a third error shape this codebase doesn't use. The
// pipeline throws, matching sendTurnToAgent's posture for a programmer-error input;
// Phase 3's transport layer is what maps a caught .code to a buildError() envelope.
//
// Neither class carries a process id, a filesystem path, a host detail, or any adapter
// output in its message — a screenless client is the eventual reader.

import { isKnownErrorCode } from './error-codes.js';

// Exported so the test suite can exercise the check itself against a deliberately
// unregistered code, proving the mechanism works, without needing to mutate the frozen
// catalogue to do it.
export function assertTurnCodeRegistered(code) {
  if (!isKnownErrorCode(code)) {
    throw new Error(`turn-errors: '${code}' is not a registered error code`);
  }
  return code;
}

export class TurnBusyError extends Error {
  constructor() {
    super('A turn is already in progress for this session.');
    this.name = 'TurnBusyError';
    this.code = 'TURN_BUSY';
  }
}

export class TurnAbortedError extends Error {
  constructor() {
    super('The turn was aborted before it could complete.');
    this.name = 'TurnAbortedError';
    this.code = 'TURN_ABORTED';
  }
}

// Fail at import time, not at runtime on a client's first contended turn, if either class's
// code is ever deleted from the catalogue — the same fail-at-import discipline
// error-codes.js already applies to its own shape. This makes it structurally impossible
// for the classes and the catalogue to drift apart.
for (const ErrorClass of [TurnBusyError, TurnAbortedError]) {
  assertTurnCodeRegistered(new ErrorClass().code);
}
