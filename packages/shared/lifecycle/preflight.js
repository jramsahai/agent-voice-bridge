// Startup reachability checks, composed from the existing health probes rather than
// reimplemented. Every check here resolves a command or a service URL without ever running
// it — probeExecutable() is a resolvability check by design, and composing it is the whole
// point of this module: starting the service must never start an agent turn nobody asked
// for. Both probe functions are injectable parameters with real defaults, following this
// codebase's existing dependency-injection convention, so test/preflight.test.js drives
// every branch without touching a real filesystem path or a real service.

import { probeExecutable, probeHttpService } from '../health/probes.js';
import { getKokoroServiceUrl } from '../adapters/tts-kokoro-onnx.js';

// Fixed declaration order (D-09, 04-03-PLAN.md): stt.command, openclaw.command,
// /usr/bin/afconvert, then exactly one of [system speech binary | ONNX spawn-fallback
// command] depending on the configured provider, and finally — only for the ONNX
// provider — the speech service itself as the one soft check. The output arrays are always
// built by walking this list in order, never by the order in which the underlying probes
// happen to settle, so the emitted messages are stable between runs.
function buildChecks(config) {
  const provider = config.tts?.provider ?? 'macos-say';
  const checks = [
    {
      kind: 'hard',
      probeArg: config.stt?.command ?? '',
      message: (arg) => `stt.command ('${arg}') is not resolvable — required for transcription`,
    },
    {
      kind: 'hard',
      probeArg: config.openclaw?.command ?? 'openclaw',
      message: (arg) => `openclaw.command ('${arg}') is not resolvable — required to reach the agent`,
    },
    {
      kind: 'hard',
      probeArg: '/usr/bin/afconvert',
      message: () =>
        '/usr/bin/afconvert is not resolvable — required for audio format conversion on this macOS host',
    },
  ];

  if (provider === 'macos-say') {
    checks.push({
      kind: 'hard',
      probeArg: '/usr/bin/say',
      message: () => '/usr/bin/say is not resolvable — required by the configured macos-say TTS provider',
    });
  } else if (provider === 'kokoro-onnx') {
    checks.push({
      kind: 'hard',
      probeArg: config.tts?.command ?? 'tts-kokoro',
      message: (arg) =>
        `tts.command ('${arg}') is not resolvable — the Kokoro spawn fallback would also fail, so every turn would fail`,
      isExecutable: true,
    });
    checks.push({
      kind: 'soft',
      probeArg: getKokoroServiceUrl(config.tts),
      message: (arg) =>
        `speech service is not reachable at ${arg} — turns will use the command-spawn fallback until it is`,
      isExecutable: false,
    });
  }

  return checks.map((check) => ({ ...check, isExecutable: check.isExecutable ?? true }));
}

export async function runPreflightChecks({
  config,
  probeExecutableFn = probeExecutable,
  probeHttpServiceFn = probeHttpService,
}) {
  const checks = buildChecks(config);

  const outcomes = await Promise.allSettled(
    checks.map((check) => (check.isExecutable ? probeExecutableFn(check.probeArg) : probeHttpServiceFn(check.probeArg))),
  );

  const errors = [];
  const warnings = [];
  checks.forEach((check, index) => {
    if (outcomes[index].status !== 'rejected') return;
    const message = check.message(check.probeArg);
    if (check.kind === 'hard') {
      errors.push(message);
    } else {
      warnings.push(message);
    }
  });

  return { errors, warnings };
}
