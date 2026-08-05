// Plan 02-04: closes this phase at the level of the suite rather than the module. This file
// asserts properties of the phase as a whole — zero dependencies, offline/model-free, distinct
// per-file session-id namespaces, and suite-level temp/lock hygiene — and drives no production
// behaviour of its own beyond spawning the phase's own five test files as an isolated check;
// every fake-adapter turn and every real-process proof already lives in those five files.
//
// This file lives under test/, which test/convert.test.js's own offline-and-model-free scan
// (Phase 1) already walks recursively. Every forbidden substring below is therefore built by
// concatenation, exactly as that scan builds its own, so this file does not trip over itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const THIS_FILE = fileURLToPath(import.meta.url);

// Built via concatenation, not written as literal substrings, so this scan (which reads its
// own file among the ones it walks, and is itself walked by test/convert.test.js's Phase 1
// scan) never flags its own pattern list as a hit.
const FORBIDDEN_NETWORK_MODEL_PATTERNS = [
  ['node', ':', 'net'].join(''),
  ['node', ':', 'https'].join(''),
  ['node', ':', 'http'].join(''),
  ['fetch', '('].join(''),
  ['models', '/'].join(''),
];

// --- File discovery: every list below comes from a directory read, never a hardcoded array,
// so a file added later to one of these locations is covered automatically. ---

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

// The three source directories this phase created (session/ — the turn lock, lifecycle/ — the
// temp-directory primitive, pipeline/ — the orchestrator). Named explicitly because they *are*
// this phase's own footprint, not discovered; the directory-read guarantee applies to their
// *contents* below, so a file added inside one of them later is scanned without editing this
// file. packages/shared/errors/turn-errors.js is this phase's one additional created file,
// living inside an existing (partly Phase 1) directory, so it is named explicitly rather than
// pulled in by a directory walk that would also sweep in Phase 1's own error-catalogue files.
const PHASE_SOURCE_DIRS = [
  path.join(repoRoot, 'packages/shared/session'),
  path.join(repoRoot, 'packages/shared/lifecycle'),
  path.join(repoRoot, 'packages/shared/pipeline'),
];
const PHASE_EXTRA_SOURCE_FILES = [path.join(repoRoot, 'packages/shared/errors/turn-errors.js')];
const PHASE_SOURCE_FILES = [...PHASE_SOURCE_DIRS.flatMap(collectJsFiles), ...PHASE_EXTRA_SOURCE_FILES];

// This phase's test files, derived from a directory read of test/ itself rather than named
// literally: any .test.js file that imports from one of the three directories above is a file
// this phase's tests drive real pipeline/lock/tempfile behaviour through, whichever plan added
// it and whatever it happens to be called.
const TEST_DIR = path.join(repoRoot, 'test');

function importsFromPhaseSourceDirs(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return PHASE_SOURCE_DIRS.some((dir) => {
    const relDir = path.relative(repoRoot, dir).split(path.sep).join('/');
    return source.includes(`${relDir}/`);
  });
}

const PHASE_TEST_FILES = fs
  .readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => path.join(TEST_DIR, name))
  .filter((filePath) => filePath !== THIS_FILE && importsFromPhaseSourceDirs(filePath));

// Phase 3's test/http-turn.test.js legitimately opens a real loopback socket to prove
// Phase 3's HTTP layer end to end — exempted here too (test/convert.test.js's own Phase 1
// scan, which walks all of test/ recursively, is the guard that actually trips on it today;
// this exemption is kept in step so a future PHASE_TEST_FILES membership change can never
// silently reintroduce this guard's own flag against that file's real socket). Only the
// three socket-related substrings below are exempted; the secure-transport builtin pattern
// and the models-directory pattern stay enforced for every file, including this one.
const HTTP_SOCKET_EXEMPT_FILES = new Set([
  path.join(TEST_DIR, 'http-turn.test.js'),
  path.join(TEST_DIR, 'http-capabilities.test.js'),
  path.join(TEST_DIR, 'http-health.test.js'),
  // Phase 5 (05-01): test/voice-cli.test.js legitimately opens a real loopback socket to
  // prove the reference CLI client against a live createRequestHandler server.
  path.join(TEST_DIR, 'voice-cli.test.js'),
]);
const HTTP_SOCKET_EXEMPT_PATTERNS = [
  ['node', ':', 'net'].join(''),
  ['node', ':', 'http'].join(''),
  ['fetch', '('].join(''),
];

test('sanity: this phase\'s source-directory walk and test-file discovery both found something', () => {
  assert.ok(PHASE_SOURCE_FILES.length > 0, 'expected at least one source file under session/, lifecycle/ or pipeline/');
  assert.ok(
    PHASE_TEST_FILES.length > 0,
    'expected at least one test file importing from this phase\'s own source directories',
  );
});

// =====================================================================================
// Zero dependencies, structurally
// =====================================================================================

function extractImportSpecifiers(source) {
  const fromSpecifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const dynamicSpecifiers = [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const sideEffectSpecifiers = [...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  return [...fromSpecifiers, ...dynamicSpecifiers, ...sideEffectSpecifiers];
}

test('every import specifier across this phase\'s own source directories and test files is a Node builtin or a relative path', () => {
  const filesToScan = [...PHASE_SOURCE_FILES, ...PHASE_TEST_FILES];
  assert.ok(filesToScan.length > 0, 'sanity: at least one file was scanned');
  let sawAtLeastOneSpecifier = false;
  for (const filePath of filesToScan) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const specifier of extractImportSpecifiers(source)) {
      sawAtLeastOneSpecifier = true;
      const isBuiltin = specifier.startsWith('node:');
      const isRelative = specifier.startsWith('.');
      assert.ok(
        isBuiltin || isRelative,
        `${path.relative(repoRoot, filePath)} imports '${specifier}', which is neither a node: builtin nor a relative path`,
      );
    }
  }
  assert.ok(sawAtLeastOneSpecifier, 'sanity: expected at least one import specifier across the scanned files');
});

test('package.json declares no runtime dependency section of any kind, and its test script is the plain runner invocation', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.ok(!(key in pkg), `package.json must not declare a '${key}' section`);
  }
  assert.equal(pkg.scripts?.test, 'node --test', 'package.json\'s test script must be the plain runner invocation');
});

// =====================================================================================
// Offline and model-free
// =====================================================================================

test('no file across this phase\'s own source directories or test files references a network client, a request call, or a model directory', () => {
  const filesToScan = [...PHASE_SOURCE_FILES, ...PHASE_TEST_FILES];
  for (const filePath of filesToScan) {
    const source = fs.readFileSync(filePath, 'utf8');
    const patternsToCheck = HTTP_SOCKET_EXEMPT_FILES.has(filePath)
      ? FORBIDDEN_NETWORK_MODEL_PATTERNS.filter((pattern) => !HTTP_SOCKET_EXEMPT_PATTERNS.includes(pattern))
      : FORBIDDEN_NETWORK_MODEL_PATTERNS;
    for (const pattern of patternsToCheck) {
      assert.ok(
        !source.includes(pattern),
        `${path.relative(repoRoot, filePath)} must not reference '${pattern}' — this phase's suite must run offline and model-free`,
      );
    }
  }
});

test('sanity: the documented HTTP-socket exemption still exists and still uses a pattern it is exempted for', () => {
  for (const filePath of HTTP_SOCKET_EXEMPT_FILES) {
    assert.ok(
      fs.existsSync(filePath),
      `exempted file ${path.relative(repoRoot, filePath)} no longer exists — remove the stale exemption`,
    );
    const source = fs.readFileSync(filePath, 'utf8');
    assert.ok(
      HTTP_SOCKET_EXEMPT_PATTERNS.some((pattern) => source.includes(pattern)),
      `${path.relative(repoRoot, filePath)} no longer uses any pattern it was exempted for — remove the stale exemption`,
    );
  }
});

test('this file itself contains no forbidden substring written as a literal', () => {
  const source = fs.readFileSync(THIS_FILE, 'utf8');
  for (const pattern of FORBIDDEN_NETWORK_MODEL_PATTERNS) {
    assert.ok(!source.includes(pattern), `this file must not contain the literal substring '${pattern}'`);
  }
});

// =====================================================================================
// Parallel safety: this phase's five test files share one real filesystem lock root, so a
// shared session-id namespace or a lock never released from a finally is a race the suite
// would introduce on itself the moment two of these files happen to run at once.
// =====================================================================================

function extractSessionIdGenerator(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const match = source.match(/function\s+uniqueSessionId\s*\([^)]*\)\s*\{\s*return\s*`([^$]*)\$\{/);
  assert.ok(
    match,
    `${path.relative(repoRoot, filePath)}: expected a uniqueSessionId(label) generator with a literal template prefix`,
  );
  const prefix = match[1];
  assert.ok(prefix.length > 0, `${path.relative(repoRoot, filePath)}: uniqueSessionId's literal prefix must be non-empty`);
  assert.ok(
    source.includes('randomUUID('),
    `${path.relative(repoRoot, filePath)}: uniqueSessionId must mix in a high-entropy generator so two calls with the same label never collide`,
  );
  // Recognised by the argument position they occupy at the one place every real session id
  // this file constructs is born — a call to its own uniqueSessionId(label). Fails loudly
  // (via the assertion below) rather than passing vacuously if a file that plainly acquires a
  // lock yields no such call.
  const labels = [...source.matchAll(/uniqueSessionId\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.ok(
    labels.length > 0,
    `${path.relative(repoRoot, filePath)}: found a uniqueSessionId generator but no uniqueSessionId('label') call site — an extraction that matches nothing must fail loudly, not pass vacuously`,
  );
  return { prefix, labels };
}

const SESSION_ID_GENERATORS = new Map(PHASE_TEST_FILES.map((filePath) => [filePath, extractSessionIdGenerator(filePath)]));
const SESSION_ID_PREFIXES = [...SESSION_ID_GENERATORS.values()].map((g) => g.prefix);

test('every one of this phase\'s test files generates session ids from its own uniquely-prefixed generator', () => {
  assert.equal(
    new Set(SESSION_ID_PREFIXES).size,
    SESSION_ID_PREFIXES.length,
    'two of this phase\'s test files share the same uniqueSessionId literal prefix',
  );
});

test('no session id constructed by this phase\'s test files can collide across files', () => {
  const identityToFile = new Map();
  for (const [filePath, { prefix, labels }] of SESSION_ID_GENERATORS) {
    for (const label of labels) {
      const identity = `${prefix}${label}`;
      const owner = identityToFile.get(identity);
      assert.ok(
        !owner || owner === filePath,
        `session-id identity '${identity}' is constructed in both ${path.relative(repoRoot, owner ?? '')} and ${path.relative(repoRoot, filePath)}`,
      );
      identityToFile.set(identity, filePath);
    }
  }
});

// Excludes a match immediately preceded by a quote character — a source-index regression test
// elsewhere in this phase searches another file's source text for this exact substring, which
// is not a real call site in the file being scanned here.
function realCallSites(source, name) {
  const pattern = new RegExp(`(?<!['"\`])\\b${name}\\(`, 'g');
  return source.match(pattern) || [];
}

test('every one of this phase\'s test files that directly acquires the lock also releases it, with cleanup reachable from a finally', () => {
  for (const filePath of PHASE_TEST_FILES) {
    const source = fs.readFileSync(filePath, 'utf8');
    const acquireCount = realCallSites(source, 'acquireTurnLock').length;
    if (acquireCount === 0) continue;
    assert.ok(
      /\bfinally\s*\{/.test(source),
      `${path.relative(repoRoot, filePath)}: directly acquires the lock but declares no finally block anywhere in the file`,
    );
    const releaseLikeCount = realCallSites(source, 'releaseTurnLock').length + realCallSites(source, 'rmSync').length;
    assert.ok(
      releaseLikeCount >= acquireCount,
      `${path.relative(repoRoot, filePath)}: ${acquireCount} direct lock-acquiring entry point(s) but only ${releaseLikeCount} release-like call(s) (releaseTurnLock/rmSync) — releases must not be outnumbered by acquisitions`,
    );
  }
});

// Regression guard for the exact class of bug deferred-items.md documents: a before/after
// diff of the shared, process-wide os.tmpdir() listing is safe only when one file is the sole
// writer under a prefix. Once more than one file drives real runTurn() calls concurrently
// under `node --test`'s parallel file execution, that diff can catch another file's own
// transient, legitimately-cleaned-up entry and fail for a reason unrelated to the test itself.
// Plan 02-03 fixed this once (test/turn-pipeline.test.js, test/tempfiles.test.js) and this
// plan fixed the one remaining instance (test/turn-pipeline-abort.test.js); this test exists
// so a future file cannot silently reintroduce the pattern.
//
// Widened per WR-04 (02-REVIEW.md): the pattern reappeared in test/format-contract.test.js, a
// file PHASE_TEST_FILES above never covered, because it imports from packages/shared/audio and
// packages/shared/errors rather than this phase's own session/lifecycle/pipeline directories.
// The hazard is suite-wide, not scoped to this phase's own source, so this specific guard scans
// every *.test.js file under test/ — not just PHASE_TEST_FILES — with one documented exemption:
// test/convert.test.js is a Phase 1 file, out of scope for this phase to modify, and its use of
// the pattern is a different claim than the one that broke here ("a real afconvert subprocess
// invocation left no residue behind," measured after a real spawn actually happened) rather than
// format-contract.test.js's broken claim ("no subprocess was ever spawned at all," which has a
// deterministic, non-racy proof available — see the fix below). A future file reintroducing the
// listing-read pattern for that latter kind of claim must use a call-count or an
// already-returned meta flag instead, exactly as format-contract.test.js now does.
const RACY_LISTING_READ_EXEMPT_FILES = new Set([path.join(TEST_DIR, 'convert.test.js')]);

test('no test file in the suite proves temp hygiene by reading the shared os.tmpdir() listing directly, aside from the one documented, out-of-scope exemption', () => {
  const racyListingRead = /fs\.readdirSync\(\s*os\.tmpdir\(\)\s*\)/;
  const allTestFiles = fs
    .readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(TEST_DIR, name))
    .filter((filePath) => filePath !== THIS_FILE);
  assert.ok(allTestFiles.length > 0, 'sanity: expected at least one test file under test/');
  for (const filePath of allTestFiles) {
    if (RACY_LISTING_READ_EXEMPT_FILES.has(filePath)) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    assert.ok(
      !racyListingRead.test(source),
      `${path.relative(repoRoot, filePath)}: reads os.tmpdir()'s own listing directly — this is the racy shared-prefix diff pattern this phase already fixed once; capture a turn's own directory from the transcribe adapter's recorded audioPath instead, or assert a deterministic call-count/meta flag proving nothing was spawned`,
    );
  }
});

test('sanity: the one documented exemption to the listing-read guard above still exists and still uses the pattern it is exempted for', () => {
  for (const filePath of RACY_LISTING_READ_EXEMPT_FILES) {
    assert.ok(fs.existsSync(filePath), `exempted file ${path.relative(repoRoot, filePath)} no longer exists — remove the stale exemption`);
    const source = fs.readFileSync(filePath, 'utf8');
    assert.ok(
      /fs\.readdirSync\(\s*os\.tmpdir\(\)\s*\)/.test(source),
      `${path.relative(repoRoot, filePath)} no longer uses the pattern it was exempted for — remove the stale exemption`,
    );
  }
});

// =====================================================================================
// Suite self-cleaning
//
// Deliberately structural, not a live before/after directory-listing diff: this file's own
// intro states it drives no production behaviour, and a live diff against the shared,
// process-wide os.tmpdir() prefix — even one bracketing an isolated child run of just this
// phase's own files — was tried while authoring this test and failed on every one of 20
// consecutive `npm test` runs the moment it ran alongside its own naturally-parallel siblings
// (including test/convert.test.js, a Phase 1 file with no relationship to this phase, sharing
// nothing but os.tmpdir() itself). That is the identical race deferred-items.md already
// documents once removed — a live diff cannot be made safe by retrying, only by not diffing a
// shared resource at all. The structural proof below instead shows the four repo-wide temp
// prefixes and the lock root can never leak *by construction*, which holds regardless of how
// many files touch them at once.
// =====================================================================================

// Read this phase's own prefix out of the pipeline module's source by regex rather than
// duplicating it, exactly as this phase's own test files already do for the same constant.
function extractPrefixFromConstant(sourcePath, constantName) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const pattern = new RegExp(`${constantName}\\s*=\\s*'([^']+)'`);
  const match = source.match(pattern);
  assert.ok(match, `${path.relative(repoRoot, sourcePath)} must declare a documented ${constantName} constant`);
  return match[1];
}

function extractPrefixesFromWithTempDirCallSites(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const matches = [...source.matchAll(/withTempDir\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(matches.length > 0, `${path.relative(repoRoot, sourcePath)} must call withTempDir with a literal prefix`);
  return matches;
}

const REPO_TEMP_PREFIXES = [
  ...new Set([
    extractPrefixFromConstant(path.join(repoRoot, 'packages/shared/pipeline/turn-pipeline.js'), 'TEMP_DIR_PREFIX'),
    extractPrefixFromConstant(path.join(repoRoot, 'packages/shared/audio/convert.js'), 'TEMP_DIR_PREFIX'),
    ...extractPrefixesFromWithTempDirCallSites(path.join(repoRoot, 'packages/shared/adapters/tts-macos-say.js')),
    ...extractPrefixesFromWithTempDirCallSites(path.join(repoRoot, 'packages/shared/adapters/tts-kokoro-onnx.js')),
  ]),
];

test('sanity: at least the four documented repo-wide temp prefixes were found in their declaring source files', () => {
  assert.ok(
    REPO_TEMP_PREFIXES.length >= 4,
    `expected at least 4 distinct temp-directory prefixes across the repository, found ${REPO_TEMP_PREFIXES.length}: ${REPO_TEMP_PREFIXES.join(', ')}`,
  );
});

// The primitive backing this phase's own prefix, and (via withTempDir) two of the other
// three: exactly one mkdtempSync( call, immediately followed by a try block, with a finally
// that force-removes the directory it created. Any caller of withTempDir inherits this
// guarantee regardless of how it fails.
function assertMkdtempHasGuaranteedCleanup(sourcePath) {
  const label = path.relative(repoRoot, sourcePath);
  const source = fs.readFileSync(sourcePath, 'utf8');

  const createSites = [...source.matchAll(/mkdtempSync\(/g)];
  assert.equal(createSites.length, 1, `${label}: expected exactly one mkdtempSync( call site, found ${createSites.length}`);

  const createIndex = createSites[0].index;
  const afterCreate = source.slice(createIndex);
  assert.ok(
    /^mkdtempSync\([^;]*;\s*try\s*\{/.test(afterCreate),
    `${label}: the mkdtempSync( call must be immediately followed by a try block, so nothing between creation and the try can skip cleanup`,
  );

  const finallyIndex = afterCreate.indexOf('finally');
  assert.ok(finallyIndex >= 0, `${label}: expected a finally block guarding the directory this call created`);
  const finallyBody = afterCreate.slice(finallyIndex);
  assert.ok(/rmSync\(/.test(finallyBody), `${label}: the finally block must remove the temp directory (rmSync)`);
  assert.ok(/recursive:\s*true/.test(finallyBody), `${label}: cleanup must be recursive`);
  assert.ok(
    /force:\s*true/.test(finallyBody),
    `${label}: cleanup must force-remove so a partially-failed removal never turns cleanup into a second failure`,
  );
}

test('withTempDir — the primitive backing this phase\'s own temp prefix and two of the other three — cleans up on every path, structurally', () => {
  assertMkdtempHasGuaranteedCleanup(path.join(repoRoot, 'packages/shared/lifecycle/tempfiles.js'));
});

test('convert.js — the one remaining repo-wide temp prefix\'s own independent primitive — cleans up on every path, structurally', () => {
  assertMkdtempHasGuaranteedCleanup(path.join(repoRoot, 'packages/shared/audio/convert.js'));
});

test('turn-pipeline.js creates no temp directory of its own outside withTempDir', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'packages/shared/pipeline/turn-pipeline.js'), 'utf8');
  assert.ok(
    !source.includes('mkdtempSync('),
    'turn-pipeline.js must not call mkdtempSync directly — every temp directory it creates must flow through withTempDir',
  );
});

// Read this phase's own lock-root name out of the lock module's source by regex rather than
// duplicating it.
function extractLockRoot() {
  const source = fs.readFileSync(path.join(repoRoot, 'packages/shared/session/turn-lock.js'), 'utf8');
  const match = source.match(/LOCK_ROOT\s*=\s*path\.join\(os\.tmpdir\(\),\s*'([^']+)'\)/);
  assert.ok(match, 'turn-lock.js must declare a documented LOCK_ROOT constant built from os.tmpdir()');
  return match[1];
}

test('sanity: turn-lock.js declares a documented lock-root name', () => {
  assert.ok(extractLockRoot().length > 0);
});

test('releaseTurnLock swallows a failed removal rather than throwing, so it is always safe to call from a finally', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'packages/shared/session/turn-lock.js'), 'utf8');
  const releaseIndex = source.indexOf('export function releaseTurnLock(');
  assert.ok(releaseIndex >= 0, 'expected an exported releaseTurnLock function');
  const nextExportIndex = source.indexOf('\nexport ', releaseIndex + 1);
  const releaseBody = nextExportIndex >= 0 ? source.slice(releaseIndex, nextExportIndex) : source.slice(releaseIndex);
  assert.ok(
    /try\s*\{[\s\S]*rmSync\([\s\S]*\}\s*catch/.test(releaseBody),
    'releaseTurnLock must wrap its removal in a try/catch that swallows a failure — release must never throw',
  );
});

test('runTurn releases the lock from its own outer finally, regardless of outcome (regression guard on plan 02-01\'s span invariant)', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'packages/shared/pipeline/turn-pipeline.js'), 'utf8');
  const finallyIndex = source.lastIndexOf('finally');
  assert.ok(finallyIndex >= 0, 'expected a finally block in runTurn');
  const finallyBody = source.slice(finallyIndex);
  assert.ok(/releaseTurnLock\(/.test(finallyBody), 'runTurn must release the lock inside its outer finally');
});
