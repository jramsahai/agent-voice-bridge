// The published client read-timeout floor is only trustworthy if it stays *derived*. A
// value-level check alone cannot prove that: `export const MIN_CLIENT_READ_TIMEOUT_MS = 300000`
// satisfies every value assertion in the suite while silently destroying the property the
// constant exists for — raising a stage ceiling would no longer raise the floor. These checks
// pair the value assertion with a structural one on the source text, the same shape as
// api-spec-contract.test.js's wire-hygiene guard and wav.test.js's import scan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRANSCRIBE_TIMEOUT_MS, AGENT_TIMEOUT_MS } from '../packages/shared/adapters/stage-timeouts.js';
import { MIN_CLIENT_READ_TIMEOUT_MS } from '../packages/shared/transport/read-timeout.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceOf(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

// Takes the source text as a parameter — not a closure over the real file — so the negative
// case below drives a mutated fixture through the identical assertion path.
function assertReadTimeoutIsDerived(sourceText) {
  const exported = sourceText.match(/export const MIN_CLIENT_READ_TIMEOUT_MS\s*=\s*([^;]+);/);
  assert.ok(exported, 'read-timeout.js must export MIN_CLIENT_READ_TIMEOUT_MS');
  const expression = exported[1].trim();
  assert.ok(
    !/^[\d_]+$/.test(expression),
    `MIN_CLIENT_READ_TIMEOUT_MS is assigned the literal '${expression}' — it must stay derived from the stage ceilings, so raising either one raises this floor with no second edit to remember`,
  );
  assert.equal(
    expression,
    'TRANSCRIBE_TIMEOUT_MS + AGENT_TIMEOUT_MS',
    'MIN_CLIENT_READ_TIMEOUT_MS must be the sum of the two stage ceilings',
  );
}

test('the published read-timeout floor equals the sum of the two stage ceilings', () => {
  assert.equal(MIN_CLIENT_READ_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS + AGENT_TIMEOUT_MS);
});

test('the read-timeout floor is a derived sum expression in source, not a typed literal', () => {
  const sourceText = sourceOf('packages/shared/transport/read-timeout.js');
  assertReadTimeoutIsDerived(sourceText);

  // Negative-case proof: a fixture with the sum replaced by the literal it currently evaluates
  // to must fail this check. Without this, the test only restates that the sum is present and
  // could not catch the one mutation it exists to catch.
  const hardcoded = sourceText.replace(
    /export const MIN_CLIENT_READ_TIMEOUT_MS\s*=\s*[^;]+;/,
    `export const MIN_CLIENT_READ_TIMEOUT_MS = ${MIN_CLIENT_READ_TIMEOUT_MS};`,
  );
  assert.notEqual(hardcoded, sourceText, 'sanity: the mutation must have actually replaced the expression');
  assert.throws(
    () => assertReadTimeoutIsDerived(hardcoded),
    'assertReadTimeoutIsDerived must throw once the sum expression is replaced by an equivalent literal',
  );
});

test('both stage ceilings are exported as positive numbers', () => {
  for (const [name, value] of [['TRANSCRIBE_TIMEOUT_MS', TRANSCRIBE_TIMEOUT_MS], ['AGENT_TIMEOUT_MS', AGENT_TIMEOUT_MS]]) {
    assert.equal(typeof value, 'number', `${name} must be a number`);
    assert.ok(Number.isInteger(value) && value > 0, `${name} must be a positive integer, got ${value}`);
  }
});

// Each adapter must read its execFile timeout from the shared constant. An inlined numeric
// timeout would still pass every value assertion above while decoupling the stage from the
// published floor — exactly the drift these constants were introduced to prevent.
for (const { file, constant } of [
  { file: 'packages/shared/adapters/stt-whisper-local.js', constant: 'TRANSCRIBE_TIMEOUT_MS' },
  { file: 'packages/shared/adapters/agent-openclaw-cli.js', constant: 'AGENT_TIMEOUT_MS' },
  { file: 'packages/shared/adapters/agent-hermes-cli.js', constant: 'AGENT_TIMEOUT_MS' },
  { file: 'packages/shared/adapters/agent-command.js', constant: 'AGENT_TIMEOUT_MS' },
]) {
  test(`${file} takes its execFile timeout from ${constant}, not an inlined number`, () => {
    const sourceText = sourceOf(file);
    // assert.ok on a regex test rather than assert.match — a failed assert.match dumps the
    // entire source file into the report, burying the one line that matters.
    assert.ok(
      new RegExp(`import\\s+\\{[^}]*\\b${constant}\\b[^}]*\\}\\s+from\\s+'\\./stage-timeouts\\.js'`).test(sourceText),
      `${file} must import ${constant} from './stage-timeouts.js'`,
    );
    assert.ok(
      new RegExp(`timeout:\\s*${constant}\\b`).test(sourceText),
      `${file} must pass ${constant} as its execFile timeout option`,
    );
    const inlined = sourceText.match(/timeout:\s*\d[\d_]*/);
    assert.equal(
      inlined,
      null,
      `${file} declares a numeric execFile timeout (${inlined?.[0]}) — it must use ${constant} so the published read-timeout floor follows this stage`,
    );
  });
}
