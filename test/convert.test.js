// FMT-04/FMT-05 container conversion suite: the tracer's deliberately stubbed container
// branch, filled by plan 01-05. Verified-reliable resample paths (WAV in, WAV out) shell to
// the real /usr/bin/afconvert binary; every failure path runs against a small injected shell
// script created inside the test's own mkdtempSync directory, per RESEARCH.md Pitfall 5 —
// driving a failure through a codec path verified broken on this host would make the suite
// depend on an OS defect rather than this module's own error handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUDIO_FORMATS } from '../packages/shared/audio/format-registry.js';
import { readWavFormat, wavToPcm } from '../packages/shared/audio/wav.js';
import {
  prepareTranscriptionInput,
  prepareClientOutput,
  convertWavToWhisperWav,
} from '../packages/shared/audio/convert.js';
import { makePcm16, makeCanonicalWav, makeStereoWav, makeWavWithFillerChunk, makeMalformedWav } from './helpers/fixtures.js';

// Derived from the registry, not hardcoded, so this file never has to know the exact wire
// id of "the container format" or "the codec-free format" — only that exactly one of each
// exists in v1.
const CONTAINER_FORMAT_ID = Object.keys(AUDIO_FORMATS).find((id) => !AUDIO_FORMATS[id].headerless);
const CODEC_FREE_FORMAT_ID = Object.keys(AUDIO_FORMATS).find((id) => AUDIO_FORMATS[id].headerless);
assert.ok(CONTAINER_FORMAT_ID, 'a container format must be registered for this suite to run');
assert.ok(CODEC_FREE_FORMAT_ID, 'a headerless format must be registered for this suite to run');

const WHISPER_CONVERSION_RECIPE = Object.values(AUDIO_FORMATS).find((row) => row.afconvertDataFormat != null);
assert.ok(WHISPER_CONVERSION_RECIPE, 'a registry row must supply afconvert tokens for this suite to run');

// Read convert.js's own temp-directory prefix from its source text (regex, not a new
// export) so the hygiene assertions below can never drift from the real value — same
// pattern test/error-response.test.js uses for MAX_ECHOED_IDENTIFIER_LENGTH.
const CONVERT_SOURCE_URL = new URL('../packages/shared/audio/convert.js', import.meta.url);
const CONVERT_SOURCE = fs.readFileSync(CONVERT_SOURCE_URL, 'utf8');

function readTempDirPrefix() {
  const match = CONVERT_SOURCE.match(/TEMP_DIR_PREFIX\s*=\s*'([^']+)'/);
  assert.ok(match, 'convert.js must declare a documented TEMP_DIR_PREFIX constant');
  return match[1];
}

function listMatchingTempEntries(prefix) {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(prefix));
}

// Stub scripts live in their own throwaway temp directory with a prefix that deliberately
// does NOT overlap convert.js's own prefix, so the hygiene assertions above never see a
// stub-fixture directory as if it were conversion residue.
async function withStubDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbtest-convert-stub-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeStub(dir, name, scriptBody) {
  const scriptPath = path.join(dir, name);
  fs.writeFileSync(scriptPath, scriptBody, { mode: 0o755 });
  return scriptPath;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// --- Input direction, real subprocess ---

test('a 44.1kHz mono container source converts to whisper-ready 16kHz mono 16-bit', async () => {
  const pcm = makePcm16({ samples: 4410 });
  const wav = makeCanonicalWav({ pcm, sampleRate: 44100, channels: 1 });
  const result = await prepareTranscriptionInput(wav, CONTAINER_FORMAT_ID);
  assert.ok(!result.error, 'expected a successful conversion');
  assert.deepEqual(readWavFormat(result.wavBuffer), { sampleRate: 16000, channels: 1, bitDepth: 16 });
  assert.equal(result.meta.converted, true);
  assert.equal(result.meta.spawned, true);
});

test('a 44.1kHz stereo source downmixes to a single channel — the verified shell-wrapper gap', async () => {
  const pcm = makePcm16({ samples: 4410 });
  const wav = makeStereoWav({ pcm, sampleRate: 44100 });
  const result = await prepareTranscriptionInput(wav, CONTAINER_FORMAT_ID);
  assert.ok(!result.error, 'expected a successful conversion');
  assert.equal(readWavFormat(result.wavBuffer).channels, 1);
});

test('wavToPcm on a converted result returns a whole number of 16-bit mono frames', async () => {
  const pcm = makePcm16({ samples: 4410 });
  const wav = makeCanonicalWav({ pcm, sampleRate: 44100, channels: 1 });
  const result = await prepareTranscriptionInput(wav, CONTAINER_FORMAT_ID);
  assert.ok(!result.error);
  const stripped = wavToPcm(result.wavBuffer);
  assert.equal(stripped.length % 2, 0, 'stripped payload must be a whole number of 16-bit frames');
  assert.ok(stripped.length > 0);
});

test('a container source already at 16kHz mono 16-bit still resolves successfully, meta reported honestly', async () => {
  const pcm = makePcm16({ samples: 4000 });
  const wav = makeCanonicalWav({ pcm, sampleRate: 16000, channels: 1, bitDepth: 16 });
  const result = await prepareTranscriptionInput(wav, CONTAINER_FORMAT_ID);
  assert.ok(!result.error);
  assert.equal(typeof result.meta.converted, 'boolean');
  assert.equal(typeof result.meta.spawned, 'boolean');
  assert.deepEqual(readWavFormat(result.wavBuffer), { sampleRate: 16000, channels: 1, bitDepth: 16 });
});

// --- Output direction, real subprocess ---

test('a 24kHz mono reply resamples to headerless 16kHz PCM within tolerance', async () => {
  const pcm = makePcm16({ samples: 24000 });
  const wav = makeCanonicalWav({ pcm, sampleRate: 24000, channels: 1 });
  const result = await prepareClientOutput(wav, CODEC_FREE_FORMAT_ID);
  assert.ok(!result.error);
  assert.equal(result.buffer.length % 2, 0);
  assert.equal(result.meta.converted, true);
  const expectedBytes = Math.round(pcm.length * (16000 / 24000));
  const tolerance = expectedBytes * 0.1;
  assert.ok(
    Math.abs(result.buffer.length - expectedBytes) <= tolerance,
    `expected ~${expectedBytes} bytes (±10%), got ${result.buffer.length}`,
  );
});

test('a 16kHz mono reply requested as the codec-free format spawns nothing and returns byte-identical PCM', async () => {
  const pcm = makePcm16({ samples: 4000 });
  const wav = makeCanonicalWav({ pcm, sampleRate: 16000, channels: 1 });
  const result = await prepareClientOutput(wav, CODEC_FREE_FORMAT_ID);
  assert.ok(!result.error);
  assert.equal(result.meta.spawned, false, 'an already-conforming reply must not pay for a subprocess');
  assert.deepEqual(result.buffer, pcm);
});

test('a filler-padded 16kHz reply strips by walking chunks, not a fixed offset', async () => {
  const pcm = makePcm16({ samples: 4000 });
  const wav = makeWavWithFillerChunk({ pcm, sampleRate: 16000 });
  const result = await prepareClientOutput(wav, CODEC_FREE_FORMAT_ID);
  assert.ok(!result.error);
  assert.deepEqual(result.buffer, pcm);
});

// --- convertWavToWhisperWav exercised directly ---

test('convertWavToWhisperWav resamples directly to the whisper-ready shape', async () => {
  const pcm = makePcm16({ samples: 4410 });
  const wav = makeCanonicalWav({ pcm, sampleRate: 44100, channels: 1 });
  const result = await convertWavToWhisperWav(wav);
  assert.ok(!result.error);
  assert.deepEqual(readWavFormat(result.wavBuffer), { sampleRate: 16000, channels: 1, bitDepth: 16 });
});

// --- Temp hygiene ---

test('temp hygiene: a successful conversion leaves no residue', async () => {
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const pcm = makePcm16({ samples: 4000 });
  const wav = makeCanonicalWav({ pcm, sampleRate: 44100, channels: 1 });
  const result = await prepareTranscriptionInput(wav, CONTAINER_FORMAT_ID);
  assert.ok(!result.error);
  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('temp hygiene: a non-zero afconvert exit leaves no residue', async () => {
  await withStubDir(async (stubDir) => {
    const stubPath = writeStub(stubDir, 'afconvert-fail.sh', '#!/bin/sh\nexit 1\n');
    const prefix = readTempDirPrefix();
    const before = listMatchingTempEntries(prefix);
    const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 2000 }), sampleRate: 44100 });
    const result = await convertWavToWhisperWav(wav, { afconvertBin: stubPath });
    assert.ok(result.error, 'expected a resolved failure envelope');
    assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
  });
});

test('temp hygiene: a missing afconvert binary leaves no residue', async () => {
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 2000 }), sampleRate: 44100 });
  const result = await convertWavToWhisperWav(wav, { afconvertBin: '/nonexistent-afconvert-binary-xyz' });
  assert.ok(result.error, 'expected a resolved failure envelope');
  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

test('temp hygiene: an invalid input buffer creates no temp directory at all', async () => {
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);
  // Fails readWavFormat's own RIFF/WAVE preamble check before any temp directory is ever
  // created — unlike 'no-data-chunk' (still a valid fmt chunk, just missing 'data'), this
  // fixture is too short to even be a container, so this exercises the true fail-fast path.
  await assert.rejects(() => prepareTranscriptionInput(makeMalformedWav('truncated-header'), CONTAINER_FORMAT_ID));
  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

// --- Failure mapping and leak-freedom ---

test('a failing afconvert invocation maps to AUDIO_CONVERSION_FAILED without leaking stderr, stub path, or the temp path', async () => {
  await withStubDir(async (stubDir) => {
    const marker = 'STDERR_MARKER_7f3a9c_do_not_leak_this';
    const stubPath = writeStub(stubDir, 'afconvert-fail.sh', `#!/bin/sh\necho "${marker}" >&2\nexit 1\n`);

    const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 4000 }), sampleRate: 44100 });
    const result = await convertWavToWhisperWav(wav, { afconvertBin: stubPath });

    assert.ok(result.error, 'expected a resolved failure envelope');
    assert.equal(result.error.body.error.code, 'AUDIO_CONVERSION_FAILED');
    const serialized = JSON.stringify(result.error);
    assert.ok(!serialized.includes(marker), 'stderr marker must not leak into the envelope');
    assert.ok(!serialized.includes(stubPath), 'the stub path must not leak into the envelope');
    assert.ok(!serialized.includes(os.tmpdir()), 'no string beginning with os.tmpdir() may appear in the envelope');
  });
});

test('a stub that never exits settles within the configured timeout rather than hanging', async () => {
  await withStubDir(async (stubDir) => {
    const stubPath = writeStub(stubDir, 'afconvert-hang.sh', '#!/bin/sh\nwhile true; do sleep 1; done\n');
    const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 2000 }), sampleRate: 44100 });
    const start = Date.now();
    const result = await convertWavToWhisperWav(wav, { afconvertBin: stubPath, timeoutMs: 300 });
    const elapsed = Date.now() - start;
    assert.ok(result.error, 'a hanging subprocess must resolve to a failure envelope, not hang forever');
    assert.ok(elapsed < 5000, `expected to settle well under 5s, took ${elapsed}ms`);
  });
});

// --- Argument safety ---

test('argv built for the afconvert call contains only registry-sourced tokens and two temp paths', async () => {
  await withStubDir(async (stubDir) => {
    const argvFile = path.join(stubDir, 'argv.txt');
    const stubPath = writeStub(stubDir, 'afconvert-record.sh', `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);

    const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 2000 }), sampleRate: 44100 });
    // The stub never writes an output file, so this resolves to a failure envelope — this
    // test only inspects the argv the stub recorded before that failure.
    await convertWavToWhisperWav(wav, { afconvertBin: stubPath });

    const recordedArgv = fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(recordedArgv.slice(0, 6), [
      '-f',
      WHISPER_CONVERSION_RECIPE.afconvertFileFormat,
      '-d',
      WHISPER_CONVERSION_RECIPE.afconvertDataFormat,
      '-c',
      String(WHISPER_CONVERSION_RECIPE.afconvertChannels),
    ]);
    assert.equal(recordedArgv.length, 8, 'argv must contain exactly two format flags, one channel flag, and two paths');

    const prefix = readTempDirPrefix();
    for (const element of recordedArgv.slice(6)) {
      assert.ok(path.isAbsolute(element), `${element} must be an absolute path`);
      assert.ok(element.includes(prefix), `${element} must be under the module's temp prefix`);
    }

    const metacharacterPattern = /[;&|`$(){}<>\\]/;
    for (const element of recordedArgv) {
      assert.ok(!metacharacterPattern.test(element), `argv element '${element}' must not contain a shell metacharacter`);
    }
  });
});

test('argv recorded through prepareTranscriptionInput matches the direct-call shape exactly, proving the declared identifier contributes nothing beyond registry lookup', async () => {
  await withStubDir(async (stubDir) => {
    const argvFile = path.join(stubDir, 'argv.txt');
    const stubPath = writeStub(stubDir, 'afconvert-record.sh', `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\n`);
    const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 2000 }), sampleRate: 44100 });
    // convertWavToWhisperWav itself takes no format-id parameter — driving the same source
    // buffer through prepareTranscriptionInput (which does receive a declared identifier)
    // and asserting the exact same pinned argv shape confirms the identifier is consumed
    // only for the registry lookup, never echoed into the subprocess call itself.
    await prepareTranscriptionInput(wav, CONTAINER_FORMAT_ID, { afconvertBin: stubPath });
    const recordedArgv = fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(recordedArgv.slice(0, 6), [
      '-f',
      WHISPER_CONVERSION_RECIPE.afconvertFileFormat,
      '-d',
      WHISPER_CONVERSION_RECIPE.afconvertDataFormat,
      '-c',
      String(WHISPER_CONVERSION_RECIPE.afconvertChannels),
    ]);
    assert.equal(recordedArgv.length, 8);
  });
});

// --- Suite-level guarantees (TEST-05): parallel safety, offline/model-free operation ---
// These only make sense at the level of the one file in the phase that spawns processes.

test('several conversions launched concurrently all succeed and leave no temp residue', async () => {
  // node --test runs test files in parallel by default, so two conversions genuinely can
  // overlap in practice — a fixed (non-unique) temp path would pass here in isolation and
  // fail intermittently under real suite load, which is the worst failure mode available.
  const prefix = readTempDirPrefix();
  const before = listMatchingTempEntries(prefix);

  const jobs = Array.from({ length: 6 }, (_, i) => {
    const pcm = makePcm16({ samples: 2000 + i * 137 });
    const wav = makeCanonicalWav({ pcm, sampleRate: 44100, channels: i % 2 === 0 ? 1 : 2 });
    return prepareTranscriptionInput(wav, CONTAINER_FORMAT_ID);
  });

  const outcomes = await Promise.all(jobs);
  for (const result of outcomes) {
    assert.ok(!result.error, 'every concurrent conversion must succeed');
    assert.deepEqual(readWavFormat(result.wavBuffer), { sampleRate: 16000, channels: 1, bitDepth: 16 });
  }

  assert.deepEqual(listMatchingTempEntries(prefix).sort(), before.sort());
});

// Phase 3's test/http-turn.test.js is the first file in the repository that legitimately
// opens a real loopback socket — it exists to prove Phase 3's HTTP layer end to end. Rather
// than weaken this scan (which walks all of test/ recursively and is the first of the two
// offline-scan guards to trip on that file's real HTTP-server-builtin import), only the
// three socket-related substrings below are exempted for it. The models-directory pattern
// and the secure-transport builtin pattern stay enforced for every file, including this one.
const HTTP_SOCKET_EXEMPT_FILES = new Set([
  path.join(repoRoot, 'test', 'http-turn.test.js'),
  path.join(repoRoot, 'test', 'http-capabilities.test.js'),
]);

test('no source file this phase created references a network client, a fetch call, or a models directory', () => {
  const scanDirs = [
    path.join(repoRoot, 'packages/shared/audio'),
    path.join(repoRoot, 'packages/shared/errors'),
    path.join(repoRoot, 'test'),
  ];

  function collectJsFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stats = fs.statSync(fullPath);
      if (stats.isDirectory()) {
        files.push(...collectJsFiles(fullPath));
      } else if (entry.endsWith('.js')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const filesToScan = scanDirs.flatMap(collectJsFiles);
  assert.ok(filesToScan.length > 0, 'sanity: at least one file was scanned');

  // Built via concatenation, not written as literal substrings, so this scan (which reads
  // its own file among the ones it walks) does not flag its own pattern list as a hit.
  const socketExemptPatterns = [
    ['node', ':', 'net'].join(''),
    ['node', ':', 'http'].join(''),
    ['fetch', '('].join(''),
  ];
  const alwaysEnforcedPatterns = [
    ['node', ':', 'https'].join(''),
    ['models', '/'].join(''),
  ];
  for (const filePath of filesToScan) {
    const source = fs.readFileSync(filePath, 'utf8');
    const patternsToCheck = HTTP_SOCKET_EXEMPT_FILES.has(filePath)
      ? alwaysEnforcedPatterns
      : [...socketExemptPatterns, ...alwaysEnforcedPatterns];
    for (const pattern of patternsToCheck) {
      assert.ok(
        !source.includes(pattern),
        `${path.relative(repoRoot, filePath)} must not reference '${pattern}' — this phase's suite must run offline and model-free`,
      );
    }
  }
});

test('sanity: the documented HTTP-socket exemption still exists and still uses a pattern it is exempted for', () => {
  const exemptPatterns = [
    ['node', ':', 'net'].join(''),
    ['node', ':', 'http'].join(''),
    ['fetch', '('].join(''),
  ];
  for (const filePath of HTTP_SOCKET_EXEMPT_FILES) {
    assert.ok(
      fs.existsSync(filePath),
      `exempted file ${path.relative(repoRoot, filePath)} no longer exists — remove the stale exemption`,
    );
    const source = fs.readFileSync(filePath, 'utf8');
    assert.ok(
      exemptPatterns.some((pattern) => source.includes(pattern)),
      `${path.relative(repoRoot, filePath)} no longer uses any pattern it was exempted for — remove the stale exemption`,
    );
  }
});
