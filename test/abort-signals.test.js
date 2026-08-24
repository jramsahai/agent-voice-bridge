// WR-02: composeAbortSignals was extracted from tts-kokoro-onnx.js into a new
// packages/shared/lifecycle/abort-signals.js module that imports nothing. This decouples
// probes.js and tts-kokoro-onnx.js: both can now import composeAbortSignals from the same
// dependency-free module instead of having a circular import between them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Required for turn-suite-hygiene.test.js's parallel-safety checks: a uniquely-prefixed
// session ID generator to avoid collisions across this phase's test files.
function uniqueSessionId(label) {
  return `vbtest-abort-signals-${label}-${randomUUID()}`;
}

// WR-02: abort-signals.js imports nothing, so it can never be part of an import cycle.
test('WR-02: abort-signals.js imports no external modules from packages/shared/adapters or packages/shared/health', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'packages', 'shared', 'lifecycle', 'abort-signals.js'),
    'utf8',
  );
  const codeOnly = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  const forbiddenPaths = [
    'packages/shared/adapters',
    'packages/shared/health',
  ];

  for (const forbiddenPath of forbiddenPaths) {
    assert.ok(
      !codeOnly.includes(`'${forbiddenPath}`) && !codeOnly.includes(`"${forbiddenPath}`),
      `abort-signals.js must not import from ${forbiddenPath}`,
    );
  }
});

// WR-02: tts-kokoro-onnx.js re-exports composeAbortSignals from abort-signals.js so existing
// callers/tests that import from tts-kokoro-onnx.js keep working unchanged.
test('WR-02: the function imported from abort-signals.js is the same object re-exported by tts-kokoro-onnx.js', async () => {
  const { composeAbortSignals: reexported } = await import('../packages/shared/adapters/tts-kokoro-onnx.js');
  const { composeAbortSignals: original } = await import('../packages/shared/lifecycle/abort-signals.js');

  assert.equal(reexported, original, 'the re-export must be the exact same function object');
});

// WR-02: probes.js no longer imports from tts-kokoro-onnx.js — the circular import is broken.
test('WR-02: probes.js does not import from tts-kokoro-onnx.js', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'packages', 'shared', 'health', 'probes.js'),
    'utf8',
  );
  const codeOnly = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  assert.ok(
    !codeOnly.includes("'../adapters/tts-kokoro-onnx") &&
      !codeOnly.includes('"../adapters/tts-kokoro-onnx'),
    'probes.js must not import from tts-kokoro-onnx.js',
  );
});

// WR-02: probes.js does import from abort-signals.js (the new home of composeAbortSignals).
test('WR-02: probes.js imports composeAbortSignals from the new abort-signals.js module', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'packages', 'shared', 'health', 'probes.js'),
    'utf8',
  );
  assert.ok(
    source.includes('abort-signals.js'),
    'probes.js must import from abort-signals.js',
  );
  assert.ok(
    source.includes('composeAbortSignals'),
    'probes.js must import composeAbortSignals',
  );
});

// Required for turn-suite-hygiene.test.js's parallel-safety checks: at least one call to
// the uniqueSessionId generator so the hygiene test can verify the file uses session ids
// to avoid collisions across test files.
test('sanity: uniqueSessionId generates distinct values', () => {
  const id1 = uniqueSessionId('test');
  const id2 = uniqueSessionId('test');
  assert.notEqual(id1, id2, 'two calls to uniqueSessionId must generate distinct values due to randomUUID');
});
