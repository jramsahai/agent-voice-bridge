// Typed pipeline failures carrying a stable machine-readable code. Real Error subclasses —
// not the buildError() envelope object 02-RESEARCH.md's illustrative code throws directly,
// which 02-PATTERNS.md flagged as a third error shape this codebase doesn't use. The
// pipeline throws, matching sendTurnToOpenClaw's posture for a programmer-error input;
// Phase 3's transport layer is what maps a caught .code to a buildError() envelope.
//
// Neither class carries a process id, a filesystem path, a host detail, or any adapter
// output in its message — a screenless client is the eventual reader.

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
