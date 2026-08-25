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
// every *.test.js file under test/ — not just PHASE_TEST_FILES.
//
// This guard formerly carried one documented exemption: test/convert.test.js, a Phase 1 file
// that was out of scope for Phase 2 to modify. That exemption was retired on 2026-08-06, when
// the file's temp-hygiene tests were finally fixed — they had been failing roughly 1 run in 8
// for exactly the reason predicted here. They no longer diff the shared namespace at all: each
// points $TMPDIR at a private root for the duration of the test (convert.js resolves
// os.tmpdir() per call), which both removes the race and buys a stronger assertion — the
// private root must be *empty*, not merely unchanged. The guard now runs with zero exemptions.
//
// A future file reintroducing the listing-read pattern must instead use a call-count, an
// already-returned meta flag (as format-contract.test.js now does), or a private $TMPDIR root
// (as convert.test.js now does).

test('no test file in the suite proves temp hygiene by reading the shared os.tmpdir() listing directly', () => {
  const racyListingRead = /fs\.readdirSync\(\s*os\.tmpdir\(\)\s*\)/;
  const allTestFiles = fs
    .readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => path.join(TEST_DIR, name))
    .filter((filePath) => filePath !== THIS_FILE);
  assert.ok(allTestFiles.length > 0, 'sanity: expected at least one test file under test/');
  for (const filePath of allTestFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    assert.ok(
      !racyListingRead.test(source),
      `${path.relative(repoRoot, filePath)}: reads os.tmpdir()'s own listing directly — this is the racy shared-prefix diff pattern this phase already fixed once; capture a turn's own directory from the transcribe adapter's recorded audioPath instead, or assert a deterministic call-count/meta flag proving nothing was spawned`,
    );
  }
});

// Replaces the former "the one exemption is still live" sanity check, which existed so a stale
// exemption could not outlive the file it covered. With the exemption retired there is nothing
// left to go stale, so the check that earns its place now is the positive one: the file that
// used to need the exemption really does isolate its temp namespace, rather than having simply
// deleted the assertions that were failing.
test('sanity: convert.test.js proves temp hygiene against a private $TMPDIR root, not the shared namespace', () => {
  const convertTest = path.join(TEST_DIR, 'convert.test.js');
  assert.ok(fs.existsSync(convertTest), 'expected test/convert.test.js to exist');
  const source = fs.readFileSync(convertTest, 'utf8');
  assert.match(
    source,
    /process\.env\.TMPDIR\s*=/,
    'convert.test.js must point $TMPDIR at a private root for its temp-hygiene tests',
  );
  assert.match(
    source,
    /listMatchingTempEntries\(prefix,\s*root\)/,
    'convert.test.js must list its own isolated root, never an implicit shared default',
  );
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

// =====================================================================================
// API-08 (T-3-04): Wire hygiene — service half (compression, cookies, redirects)
// =====================================================================================

// Built via concatenation to avoid literal substrings that would trip the file's own
// offline-scan guard. These checks target the voice-bridge service, its shared packages, and
// apps/voice-web — the browser client, which is held to the same no-encoding-negotiation rule
// so a turn it drives stays as inspectable on the wire as one a device drives.
//
// apps/voice-cli is the one deliberate exclusion: test/voice-cli.test.js asserts that the CLI
// sends `accept-encoding: identity` on purpose and treats a content-encoding response header
// as a contract violation, so the string is load-bearing there rather than a regression.
//
// The encoding entries forbid the header names outright rather than only a non-identity value:
// the service's API-08 guarantee is that it never negotiates or sets transfer encoding at all,
// which is a structural property a substring scan can actually hold. A future phase that needs
// to emit an explicit identity value adds a named exemption using this file's existing idiom.
const COMPRESSION_COOKIE_REDIRECT_PATTERNS = [
  ['node', ':', 'zlib'].join(''),
  'Set-Cookie',
  'set-cookie',
  ['Accept', '-Encoding'].join(''),
  ['accept', '-encoding'].join(''),
  ['Content', '-Encoding'].join(''),
  ['content', '-encoding'].join(''),
];

test('no file in the voice-bridge service, shared packages, or the browser client imports zlib, sets Set-Cookie, branches on or sets a transfer encoding, or calls writeHead with 3xx — API-08 service half (T-3-04)', () => {
  const filesToScan = [
    ...collectJsFiles(path.join(repoRoot, 'packages')),
    ...collectJsFiles(path.join(repoRoot, 'apps/voice-bridge')),
    ...collectJsFiles(path.join(repoRoot, 'apps/voice-web')),
  ];
  const scanned = new Set(filesToScan.map((filePath) => path.relative(repoRoot, filePath)));
  const mustCover = [
    'apps/voice-bridge/request-handler.js',
    'packages/shared/transport/turn-response.js',
    'apps/voice-web/app.js',
  ];
  for (const required of mustCover) {
    assert.ok(scanned.has(required), `sanity: the scan must cover ${required} — a scan that silently stops covering a file reports clean for the wrong reason`);
  }

  for (const filePath of filesToScan) {
    const source = fs.readFileSync(filePath, 'utf8');
    const relPath = path.relative(repoRoot, filePath);

    // Check for zlib/Set-Cookie/transfer-encoding patterns
    for (const pattern of COMPRESSION_COOKIE_REDIRECT_PATTERNS) {
      assert.ok(
        !source.includes(pattern),
        `${relPath} must not reference '${pattern}' — API-08 requires the service to add no compression, cookie, or transfer encoding of its own`,
      );
    }

    // Check for 3xx writeHead calls: look for patterns like writeHead(3\d\d, ...)
    // without false-positives on comments or strings — only flag unquoted literals
    const writeHeadCalls = source.match(/writeHead\s*\(\s*3\d{2}/g);
    assert.ok(
      !writeHeadCalls,
      `${relPath} must not call writeHead with a 3xx status code — API-08 prohibits redirects`,
    );
  }

  // The walk above collects .js files only, so an inline <script> block in the browser
  // client's page would carry encoding logic straight past it. Keep the page script-free
  // apart from its module src, and the .js-only scan stays a complete account of voice-web.
  const pageSource = fs.readFileSync(path.join(repoRoot, 'apps/voice-web/index.html'), 'utf8');
  for (const tag of pageSource.match(/<script\b[^>]*>/g) ?? []) {
    assert.ok(
      /\ssrc\s*=/.test(tag),
      `apps/voice-web/index.html must not carry an inline script block (${tag}) — it would bypass this test's .js-only walk`,
    );
  }
});

// =====================================================================================
// T-3-03 (03-01 deliverable D4): Adapter provenance — factory construction only, never
// request-derived. D4 was signed off on code review alone; this is the source-scan regression
// guard its own rationale called for.
// =====================================================================================

test('adapters argument to createRequestHandler is destructured once from the factory parameter and never reassigned, and no request-derived value is assigned into it (T-3-03)', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'apps/voice-bridge/request-handler.js'), 'utf8');

  // Assert adapters is destructured in the factory signature by checking for the
  // parameter list and the presence of adapters within it
  const factoryStartIndex = source.indexOf('export function createRequestHandler(');
  assert.ok(factoryStartIndex >= 0, 'expected createRequestHandler export');

  const openBraceIndex = source.indexOf('{', factoryStartIndex);
  const closeBraceIndex = source.indexOf('})', openBraceIndex);
  assert.ok(openBraceIndex > factoryStartIndex && closeBraceIndex > openBraceIndex, 'expected destructuring block');

  const paramBlock = source.slice(openBraceIndex, closeBraceIndex);
  assert.ok(
    paramBlock.includes('adapters'),
    'adapters must be destructured in createRequestHandler\'s own parameter object',
  );

  // Assert adapters is never reassigned anywhere after the factory's own parameter block —
  // not in the returned handler, not in handleTurn. Scanning from the end of the parameter
  // block leaves a legitimate destructuring default in the signature alone while still
  // catching every real reassignment in the body. The leading (?<![.\w]) rejects `.adapters =`
  // (a property write, covered by the request-derived check below) and `turnAdapters =`.
  const factoryBody = source.slice(closeBraceIndex);
  const directReassignmentMatches = factoryBody.match(/(?<![.\w])adapters\s*=(?![=>])/g);
  assert.ok(
    !directReassignmentMatches,
    `adapters must never be reassigned to a new value — it only flows unchanged to runTurn (found ${directReassignmentMatches?.length ?? 0})`,
  );

  // Assert turnAdapters (inside handleTurn) spreads adapters rather than mutating it
  const handleTurnIndex = source.indexOf('async function handleTurn(');
  assert.ok(handleTurnIndex > factoryStartIndex, 'expected handleTurn function inside the factory');

  // Find turnAdapters construction (which must come after handleTurn)
  const turnAdaptersIndex = source.indexOf('const turnAdapters = {', handleTurnIndex);
  assert.ok(
    turnAdaptersIndex > handleTurnIndex,
    'expected turnAdapters constructed inside handleTurn as a wrapper composition',
  );

  const turnAdaptersEndIndex = source.indexOf('};', turnAdaptersIndex);
  const turnAdaptersConstruction = source.slice(turnAdaptersIndex, turnAdaptersEndIndex + 2);

  assert.ok(
    /\.\.\.adapters/.test(turnAdaptersConstruction),
    'turnAdapters must be built via spread of the factory-provided adapters',
  );

  // Assert turnAdapters is passed to runTurn, not adapters directly
  const runTurnMatch = source.match(/runTurn\(\s*\{[^}]*adapters:\s*(\w+)/);
  assert.ok(
    runTurnMatch && runTurnMatch[1] === 'turnAdapters',
    'runTurn must be called with turnAdapters (the wrapper), never with the original adapters',
  );

  // Assert no request-derived value (req.headers, req.url, body, etc.) reaches adapters
  // Check that adapters properties are never assigned from req.* values
  const factoryToReturnSection = source.slice(factoryStartIndex, source.indexOf('return async function requestHandler'));
  assert.ok(
    !factoryToReturnSection.match(/adapters\.[\w]+\s*=.*req\./),
    'no request-derived value (req.headers, req.url, etc.) must be assigned into adapters',
  );
});

// =====================================================================================
// DEBT-10: test/http-turn.test.js must wait on observable conditions, never on a fixed
// wall-clock duration. A guard that scans a file cannot live inside that same file and
// still be RED-capturable — replacing the scanned file with its historical version would
// carry the guard away with it, scanning the new content instead of the old — so this
// guard lives here, this suite's established file-scanning home (directory walk plus
// explicit path reads elsewhere in this file), rather than inside http-turn.test.js itself.
// =====================================================================================

const HTTP_TURN_TEST_FILE = path.join(TEST_DIR, 'http-turn.test.js');

// Built via concatenation, matching this file's own FORBIDDEN_NETWORK_MODEL_PATTERNS
// convention above, so neither pattern can appear as a plain literal substring inside this
// file and trip the self-scan test below.
const SET_TIMEOUT_CALL_REGEX_SAFE = ['setTimeout', '\\('].join('');
// Extracts every timer call's delay argument, not only one anticipated bad form (WR-02,
// 10-REVIEW.md): a named constant, a variable, or a wrapped callback are all real
// fixed-duration sleeps that would defeat this guard's purpose while passing the narrower,
// digit-only pattern silently. The callback argument is consumed as a non-comma run so this
// still matches a resolver name or a wrapped arrow callback alike.
const DELAY_ARGUMENT_PATTERN = [SET_TIMEOUT_CALL_REGEX_SAFE, '[^,]+', ',\\s*', '([^)]+)', '\\)'].join('');
const POLLING_TICK_PATTERN = [SET_TIMEOUT_CALL_REGEX_SAFE, '\\s*resolve\\s*,\\s*', 'intervalMs'].join('');

test(
  "test/http-turn.test.js waits on observable conditions — no fixed-duration timer delay survives outside " +
    "the polling helper's own interval tick",
  () => {
    const source = fs.readFileSync(HTTP_TURN_TEST_FILE, 'utf8');
    assert.ok(source.length > 0, 'sanity: expected test/http-turn.test.js to be non-empty');
    assert.match(
      source,
      /async function waitUntil\(/,
      "sanity premise: expected test/http-turn.test.js to declare the waitUntil polling helper — if it was " +
        'renamed or removed, this premise is what needs updating',
    );

    const delayMatches = [...source.matchAll(new RegExp(DELAY_ARGUMENT_PATTERN, 'g'))];
    const badDelayArguments = delayMatches
      .map((match) => match[1].trim())
      .filter((delayArgument) => delayArgument !== 'intervalMs');
    assert.equal(
      badDelayArguments.length,
      0,
      'test/http-turn.test.js must schedule no timer whose delay argument is anything but the polling helper\'s ' +
        'own intervalMs identifier — a numeric literal, a named constant, or a variable all make the test pass ' +
        'or fail on machine load rather than on the condition it is meant to wait for. Offending delay ' +
        `argument(s): ${badDelayArguments.join(', ')}`,
    );

    const requiredMatches = source.match(new RegExp(POLLING_TICK_PATTERN, 'g')) ?? [];
    assert.equal(
      requiredMatches.length,
      1,
      "expected exactly one identifier-delay timer tick — the polling helper's own intervalMs tick. Its " +
        'disappearance means this scan has stopped measuring anything.',
    );
  },
);

// WR-02's non-vacuity control: fixtures, not the scanned file, so a later edit that narrows
// DELAY_ARGUMENT_PATTERN back to digits-only or widens it into matching nothing fails this
// test rather than the guard above silently reporting clean. Every fixture is built by
// concatenation, this file's own array-join convention, so a future extension pointing the
// delay scan at this file cannot flag its own negative controls.
const DELAY_PATTERN_FIXTURES = [
  {
    label: 'a resolver with a numeric-literal delay',
    source: ['setTimeout', '(', 'resolve', ', ', '500', ')'].join(''),
    expectPollingIdentifier: false,
  },
  {
    label: 'a resolver with a named-constant delay',
    source: ['setTimeout', '(', 'resolve', ', ', 'DELAY_MS', ')'].join(''),
    expectPollingIdentifier: false,
  },
  {
    label: 'a wrapped callback with a numeric-literal delay',
    source: ['setTimeout', '(', '() => resolve()', ', ', '500', ')'].join(''),
    expectPollingIdentifier: false,
  },
  {
    label: 'a resolver with the polling identifier as its delay',
    source: ['setTimeout', '(', 'resolve', ', ', 'intervalMs', ')'].join(''),
    expectPollingIdentifier: true,
  },
];

test(
  'the no-fixed-sleep guard flags a delay argument written in any form, not only as a numeric literal',
  () => {
    for (const fixture of DELAY_PATTERN_FIXTURES) {
      const match = new RegExp(DELAY_ARGUMENT_PATTERN).exec(fixture.source);
      assert.ok(match, `sanity: expected the delay pattern to match a call written as ${fixture.label}`);
      const delayArgument = match[1].trim();
      if (fixture.expectPollingIdentifier) {
        assert.equal(
          delayArgument,
          'intervalMs',
          `a call written as ${fixture.label} must extract exactly the polling identifier`,
        );
      } else {
        assert.notEqual(
          delayArgument,
          'intervalMs',
          `a call written as ${fixture.label} is a real fixed-duration sleep — the pattern must extract a ` +
            'delay argument other than the polling identifier so the guard above flags it',
        );
      }
    }
  },
);
