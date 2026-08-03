// Transport-free turn orchestration over injected transcribe/agent/speak functions. This
// module treats the audio buffer as opaque bytes and imports no part of Phase 1's
// format-conversion layer (RQ-1) — format negotiation is Phase 3's, and an import here
// would make the fake-adapter test quietly depend on a codec binary being installed. Only
// node:fs, node:path, and this repository's own sibling modules are imported.

import fs from 'node:fs';
import path from 'node:path';

import { withTempDir } from '../lifecycle/tempfiles.js';
import { acquireTurnLock, releaseTurnLock } from '../session/turn-lock.js';
import { TurnBusyError, TurnAbortedError } from '../errors/turn-errors.js';

// Deliberately not the 'voice-bridge-turn-' prefix apps/voice-bridge/server.js's legacy
// handler uses — that code never removes its directories, and residue from a
// previously-run legacy server would silently pollute this module's own temp-hygiene
// assertions. Read by test/turn-pipeline.test.js via a source-text regex, following the
// convention packages/shared/audio/convert.js established for its own TEMP_DIR_PREFIX, so
// the test can never drift from the real value.
const TEMP_DIR_PREFIX = 'voice-bridge-pipeline-';

function isPlainFilename(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes(path.sep) && !value.includes('/');
}

// Every property read of sessionId in this module reads from openclawConfig and nowhere
// else — the mechanical proof that no caller-supplied field can select the conversation.
function assertValidArgs({ audioBuffer, adapters, openclawConfig, audioFilename }) {
  const sessionId = openclawConfig?.sessionId;
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.includes(path.sep) ||
    sessionId.includes('/') ||
    sessionId === '.' ||
    sessionId === '..'
  ) {
    throw new Error('runTurn: openclawConfig.sessionId must be a non-empty string with no path separator');
  }
  if (
    !adapters ||
    typeof adapters.transcribe !== 'function' ||
    typeof adapters.agent !== 'function' ||
    typeof adapters.speak !== 'function'
  ) {
    throw new Error('runTurn: adapters.transcribe, adapters.agent and adapters.speak must all be functions');
  }
  if (!Buffer.isBuffer(audioBuffer)) {
    throw new Error('runTurn: audioBuffer must be a Buffer');
  }
  if (!isPlainFilename(audioFilename)) {
    throw new Error('runTurn: audioFilename must be a bare filename with no path separator');
  }
  return sessionId;
}

export async function runTurn({
  audioBuffer,
  adapters,
  sttConfig,
  openclawConfig,
  ttsConfig,
  wantAudio = true,
  audioFilename = 'input.audio',
  signal,
}) {
  // Step 1: synchronous argument validation. Throws on any failure, before any adapter
  // call, any lock artifact and any temp directory.
  const sessionId = assertValidArgs({ audioBuffer, adapters, openclawConfig, audioFilename });

  // Step 2: the pipeline accepts an already-constructed AbortSignal and never constructs
  // one itself — the caller owns that lifecycle, whether the caller is a test or Phase 3's
  // request handler. Plan 02-03 adds the between-stage checks.
  if (signal?.aborted) {
    throw new TurnAbortedError();
  }

  // Step 3: acquire before the first await, so two racing calls contend deterministically.
  if (!acquireTurnLock(sessionId)) {
    throw new TurnBusyError();
  }

  const meta = { sessionId, durationsMs: {} };

  // Step 4: everything from here is inside the critical section; the outer finally
  // releases the lock on every outcome — success, an adapter throw, anything.
  try {
    return await withTempDir(TEMP_DIR_PREFIX, async (dir) => {
      const audioPath = path.join(dir, audioFilename);
      fs.writeFileSync(audioPath, audioBuffer);

      const transcribeStart = Date.now();
      const transcribeResult = await adapters.transcribe(audioPath, sttConfig, { signal });
      meta.durationsMs.transcribe = Date.now() - transcribeStart;

      const agentStart = Date.now();
      const agentResult = await adapters.agent(transcribeResult.text, openclawConfig, { signal });
      meta.durationsMs.agent = Date.now() - agentStart;

      const speechText = agentResult.text;
      let speech = null;
      if (wantAudio) {
        const speakStart = Date.now();
        speech = await adapters.speak(speechText, ttsConfig, { signal });
        meta.durationsMs.speak = Date.now() - speakStart;
      }

      return {
        transcript: transcribeResult.text,
        reply: agentResult.rawText ?? agentResult.text,
        speechText,
        speech,
        meta,
      };
    });
  } finally {
    releaseTurnLock(sessionId);
  }
}
