// Pure source-contract test for the browser client: reads apps/voice-web/app.js and
// apps/voice-web/index.html off disk and asserts properties of their text. Opens no
// socket, starts no server — needs no entry in either HTTP_SOCKET_EXEMPT_FILES set.
//
// This file lives under test/, which test/convert.test.js's own offline-and-model-free
// scan (Phase 1) and test/turn-suite-hygiene.test.js's suite-wide temp-hygiene scan both
// walk recursively. The network-call substring this test needs to assert on (the global
// fetch function's call syntax) is one of those scans' own forbidden patterns, so it is
// built here by array-join concatenation — exactly the way both guard files build their
// own pattern lists — never written as a plain literal, so this file does not trip
// either scan on itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES } from '../packages/shared/errors/error-codes.js';
import { MIN_CLIENT_READ_TIMEOUT_MS } from '../packages/shared/transport/read-timeout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const appJsPath = path.join(repoRoot, 'apps/voice-web/app.js');
const indexHtmlPath = path.join(repoRoot, 'apps/voice-web/index.html');
const requestHandlerPath = path.join(repoRoot, 'apps/voice-bridge/request-handler.js');

const appJsSource = fs.readFileSync(appJsPath, 'utf8');
const indexHtmlSource = fs.readFileSync(indexHtmlPath, 'utf8');

// Built by concatenation, never as a plain literal — see file header. The regex-escaped
// form is what feeds RegExp construction below; the display form is used in assertion
// messages only.
const FETCH_CALL_TOKEN = ['fetch', '('].join('');
const FETCH_CALL_TOKEN_REGEX_SAFE = ['fetch', '\\('].join('');

test('sanity: both client fixture files were read off disk and are non-empty', () => {
  assert.ok(appJsSource.length > 0, 'apps/voice-web/app.js must be non-empty');
  assert.ok(indexHtmlSource.length > 0, 'apps/voice-web/index.html must be non-empty');
});

test('sanity: the client source makes at least one network call this suite can extract', () => {
  assert.ok(appJsSource.includes(FETCH_CALL_TOKEN), 'expected apps/voice-web/app.js to contain a network call');
});

test('the page targets the versioned turn endpoint and contains no reference to the deleted /api/turn route', () => {
  assert.ok(appJsSource.includes('/v1/turn'), "expected apps/voice-web/app.js to reference '/v1/turn'");
  assert.ok(!appJsSource.includes('/api/turn'), "apps/voice-web/app.js must not reference the deleted '/api/turn' route");
});

test('the page declares its input format via the input-format header with the wav container value', () => {
  assert.match(
    appJsSource,
    /x-voice-input-format['"]?\s*:\s*['"`]wav['"`]/i,
    "expected the x-voice-input-format request header set to 'wav', the container format the browser records",
  );
});

test('the page reads all three X-Voice-* response framing headers', () => {
  for (const header of ['x-voice-transcript-bytes', 'x-voice-reply-bytes', 'x-voice-audio-present']) {
    assert.ok(appJsSource.includes(header), `expected apps/voice-web/app.js to read the '${header}' response header`);
  }
});

test('the page never reads a body-length response header', () => {
  assert.ok(
    !/content-length/i.test(appJsSource),
    "apps/voice-web/app.js must not read a body-length header — the success response is chunked and sets none",
  );
});

test('rendered transcript/reply text is assigned through .textContent, and no markup-parsing DOM sink is present', () => {
  assert.ok(
    appJsSource.includes('.textContent'),
    'expected transcript/reply rendering to assign through the .textContent property',
  );
  for (const sink of ['innerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!appJsSource.includes(sink), `apps/voice-web/app.js must not use the markup-parsing DOM sink '${sink}'`);
  }
});

test('the page references the busy element id and the TURN_BUSY code', () => {
  assert.ok(appJsSource.includes('busy-pill'), "expected a reference to the 'busy-pill' element id");
  assert.ok(appJsSource.includes('TURN_BUSY'), "expected a reference to the 'TURN_BUSY' error code");
});

test("the page's error-handling switch mentions every code name exported by the shared error catalogue", () => {
  const codes = Object.keys(ERROR_CODES);
  assert.ok(codes.length > 0, 'sanity: the catalogue must export at least one code');
  for (const code of codes) {
    assert.ok(
      appJsSource.includes(code),
      `expected apps/voice-web/app.js's error handling to mention catalogue code '${code}' — a future catalogue ` +
        'row must fail this test until the page handles it',
    );
  }
});

test('index.html defines the busy element together with the hidden-attribute rule that keeps it hideable', () => {
  assert.ok(indexHtmlSource.includes('id="busy-pill"'), 'expected an element with id="busy-pill" in index.html');
  assert.match(
    indexHtmlSource,
    /\.pill\[hidden\]\s*\{[^}]*display:\s*none/,
    "expected a '.pill[hidden] { display: none; }' rule — the plain .pill class sets display: inline-block, " +
      "which overrides the hidden attribute's own user-agent styling without this rule",
  );
});

// Derives the service's published route surface structurally from request-handler.js's own
// router (every `req.url === '/…'` branch), rather than duplicating a hardcoded route list
// here — the same structural-resolution technique this repo's other contract tests use.
function extractPublishedRoutes(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const pattern = /req\.url\s*===\s*'([^']+)'/g;
  const routes = [...source.matchAll(pattern)].map((m) => m[1]);
  assert.ok(routes.length > 0, `expected at least one route branch in ${path.relative(repoRoot, sourcePath)}`);
  return new Set(routes);
}

test('WEB-01: every path the page fetches is a subset of the routes the service exposes to every client', () => {
  const fetchPattern = new RegExp(`${FETCH_CALL_TOKEN_REGEX_SAFE}\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  const fetchedPaths = [...appJsSource.matchAll(fetchPattern)].map((m) => m[1]);
  assert.ok(fetchedPaths.length > 0, 'sanity: expected at least one fetched path in apps/voice-web/app.js');

  const publishedRoutes = extractPublishedRoutes(requestHandlerPath);
  for (const fetchedPath of fetchedPaths) {
    assert.ok(
      publishedRoutes.has(fetchedPath),
      `apps/voice-web/app.js fetches '${fetchedPath}', which is outside the service's published route surface ` +
        `(${[...publishedRoutes].join(', ')})`,
    );
  }
});

// =====================================================================================
// CR-01 (browser half): splitTurnResponse must refuse a self-inconsistent framing
// declaration, and the catch path around its call site must actually surface that refusal
// to the user rather than leaving a dead UI. Both proven here without opening a socket or
// touching the DOM — the extracted function's own source text is evaluated in-process.
// =====================================================================================

// Returns a top-level function declaration's source text out of appJsSource: from the line
// beginning `function <name>(` or `async function <name>(` through the next line that is
// exactly a single closing brace at column zero — the codebase indents every nested block
// by two spaces, so that line is unambiguously the function's own terminator.
function extractFunctionSource(name) {
  const startPattern = new RegExp(`^(?:async )?function ${name}\\(`, 'm');
  const startMatch = startPattern.exec(appJsSource);
  assert.ok(startMatch, `expected a top-level function declaration named '${name}' in apps/voice-web/app.js`);

  const remainder = appJsSource.slice(startMatch.index);
  const lines = remainder.split('\n');
  let endLineIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '}') {
      endLineIndex = i;
      break;
    }
  }
  assert.ok(endLineIndex !== -1, `expected a closing brace at column zero terminating function '${name}'`);

  const source = lines.slice(0, endLineIndex + 1).join('\n');
  assert.ok(source.trim().length > 0, `extracted source for function '${name}' must be non-empty`);
  return source;
}

// Walks brace depth forward from an opening brace and returns the index of the closing
// brace that matches it — the OUTER close of a nested block, never the first closing
// brace encountered. Raw-text walk, no lexer: a brace inside a string, template, regex
// or comment in the scanned region would desynchronize the depth counter, which is why
// every call site pairs this with a region-purity check rather than trusting it alone.
// Throws rather than returning a fallback index on unbalanced input — a wrong index here
// would silently produce exactly the class of false certificate WR-04 exists to remove.
function findMatchingClose(source, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced braces: no matching close found for the opening brace at index ${openBraceIndex}`);
}

// Builds a callable out of a function's own extracted source, injecting `deps` as
// parameter names so each shadows the module-scope binding the extracted function refers
// to by name — no import is added; new Function needs none.
function loadBrowserFunction(name, deps = {}) {
  const source = extractFunctionSource(name);
  const paramNames = Object.keys(deps);
  const paramValues = Object.values(deps);
  const factory = new Function(...paramNames, `'use strict';\n${source}\nreturn ${name};`);
  return factory(...paramValues);
}

test('the browser splitter refuses a response whose declared framing bytes exceed the received body length', () => {
  const splitTurnResponse = loadBrowserFunction('splitTurnResponse');
  const headers = new Map([
    ['x-voice-transcript-bytes', '9999'],
    ['x-voice-reply-bytes', '0'],
    ['x-voice-audio-present', '0'],
  ]);
  assert.throws(
    () => splitTurnResponse(headers, new Uint8Array(10)),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VIOLATION');
      return true;
    },
  );
});

test('the browser splitter accepts the exactly-equal boundary and an all-zero declaration over an empty Uint8Array', () => {
  const splitTurnResponse = loadBrowserFunction('splitTurnResponse');
  const decoder = new TextDecoder('utf8');
  const transcript = 'exact boundary';
  const reply = 'no audio here';
  const bytes = new Uint8Array(Buffer.concat([Buffer.from(transcript, 'utf8'), Buffer.from(reply, 'utf8')]));
  const headers = new Map([
    ['x-voice-transcript-bytes', String(Buffer.byteLength(transcript, 'utf8'))],
    ['x-voice-reply-bytes', String(Buffer.byteLength(reply, 'utf8'))],
    ['x-voice-audio-present', '0'],
  ]);
  const result = splitTurnResponse(headers, bytes);
  assert.equal(result.transcript, transcript);
  assert.equal(result.reply, reply);
  assert.equal(result.audioPcm, null);

  const zeroHeaders = new Map([
    ['x-voice-transcript-bytes', '0'],
    ['x-voice-reply-bytes', '0'],
    ['x-voice-audio-present', '0'],
  ]);
  const zeroResult = splitTurnResponse(zeroHeaders, new Uint8Array(0));
  assert.equal(zeroResult.transcript, '');
  assert.equal(zeroResult.reply, '');
  assert.equal(zeroResult.audioPcm, null);
  assert.ok(decoder, 'sanity: decoder constructed without throwing');
});

test('the browser splitter refuses an absent, non-numeric, or negative framing byte count', () => {
  const splitTurnResponse = loadBrowserFunction('splitTurnResponse');
  const bytes = new Uint8Array(Buffer.from('hello world', 'utf8'));

  assert.throws(
    () => splitTurnResponse(new Map([['x-voice-reply-bytes', '0'], ['x-voice-audio-present', '0']]), bytes),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VIOLATION');
      return true;
    },
    'an absent x-voice-transcript-bytes header must be refused',
  );

  assert.throws(
    () =>
      splitTurnResponse(
        new Map([
          ['x-voice-transcript-bytes', 'not-a-number'],
          ['x-voice-reply-bytes', '0'],
          ['x-voice-audio-present', '0'],
        ]),
        bytes,
      ),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VIOLATION');
      return true;
    },
    'a non-numeric x-voice-transcript-bytes header must be refused',
  );

  assert.throws(
    () =>
      splitTurnResponse(
        new Map([
          ['x-voice-transcript-bytes', '-5'],
          ['x-voice-reply-bytes', '0'],
          ['x-voice-audio-present', '0'],
        ]),
        bytes,
      ),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VIOLATION');
      return true;
    },
    'a negative x-voice-transcript-bytes header must be refused',
  );
});

test('a refused framing declaration reaches the user as error text through the page\'s own humanizeErrorCode, and clears the busy state', () => {
  const humanizeErrorCode = loadBrowserFunction('humanizeErrorCode');
  const busyStateCalls = [];
  const statusCalls = [];
  const hintCalls = [];
  const consoleErrorCalls = [];
  const fakeConsole = { error: (...args) => consoleErrorCalls.push(args) };
  let resetPlayerCalls = 0;

  const reportTurnError = loadBrowserFunction('reportTurnError', {
    setTurnBusyState: (active) => busyStateCalls.push(active),
    setStatus: (text) => statusCalls.push(text),
    setHint: (text) => hintCalls.push(text),
    humanizeErrorCode,
    resetPlayer: () => { resetPlayerCalls++; },
    console: fakeConsole,
  });

  const message =
    'response framing headers declare 9999 text bytes, but only 10 bytes were received — refusing to guess a split';
  reportTurnError('CONTRACT_VIOLATION', message, 'The response could not be trusted — nothing was rendered.');

  assert.deepEqual(busyStateCalls, [false], 'reportTurnError must clear the busy state as its first action');
  assert.ok(statusCalls.length > 0, 'reportTurnError must call setStatus');
  assert.ok(
    statusCalls[0].includes(message),
    "the status text must contain the thrown error's own message verbatim — humanizeErrorCode's default: " +
      'branch must surface it rather than swallowing it into a generic fallback',
  );
  assert.ok(hintCalls.length > 0 && hintCalls[0].length > 0, 'reportTurnError must call setHint with a non-empty string');
  assert.deepEqual(consoleErrorCalls, [['CONTRACT_VIOLATION', message]], 'the fake console must record the code and message');
  assert.equal(
    resetPlayerCalls,
    1,
    'G-05-4 (sibling path): a failed turn renders no transcript or reply, so reportTurnError must detach the ' +
      "player — otherwise the previous turn's audio sits next to the error message as if it belonged to the " +
      'turn that just failed. Every error path (HTTP error, framing refusal, timeout, network) routes through here.',
  );
});

test('the splitTurnResponse call site in stopAndSend is wrapped in a catch that calls the turn-error handler', () => {
  const stopAndSendSource = extractFunctionSource('stopAndSend');
  const callIndex = stopAndSendSource.indexOf('splitTurnResponse(');
  assert.ok(callIndex !== -1, "sanity: stopAndSend must call 'splitTurnResponse('");

  const beforeCall = stopAndSendSource.slice(0, callIndex);
  assert.ok(
    /\btry\b/.test(beforeCall),
    'a try token must occur before the splitTurnResponse( call index — a bare catch with no try cannot satisfy this',
  );

  const afterCall = stopAndSendSource.slice(callIndex);
  assert.match(
    afterCall,
    /catch\s*\(\s*error\s*\)\s*\{\s*reportTurnError\(/,
    "the remainder from the splitTurnResponse( call to the end of the function must match a catch clause whose " +
      "body's first call is reportTurnError( — this fails on a swallowing empty catch, a catch wrapping some " +
      "other statement, or the pre-existing player.play().catch(() => {}), which has no reportTurnError in its body",
  );
});

// =====================================================================================
// G-05-4 (05-UAT.md): a 200 can carry no audio segment — request-handler.js derives
// audioPresent from Boolean(result.speech), so the shipped page reaches this whenever the
// speak stage yields no speech. The player must be detached on that path, or it stays
// enabled over the PREVIOUS turn's blob URL and offers the prior reply's audio as if it
// were this one (and over an empty src its play() aborts into an uncaught DOMException).
// =====================================================================================

test('a turn carrying no audio detaches the player rather than leaving the previous reply loaded', () => {
  const playerCalls = [];
  const fakePlayer = {
    hidden: false,
    pause() { playerCalls.push('pause'); },
    removeAttribute(name) { playerCalls.push(`removeAttribute:${name}`); },
    load() { playerCalls.push('load'); },
  };
  const revoked = [];
  const resetPlayer = loadBrowserFunction('resetPlayer', {
    player: fakePlayer,
    URL: { revokeObjectURL(url) { revoked.push(url); } },
    lastPlayerObjectUrl: 'blob:the-previous-reply',
  });

  resetPlayer();

  assert.deepEqual(
    revoked,
    ['blob:the-previous-reply'],
    'the prior turn\'s object URL must be revoked, not left allocated and reachable',
  );
  assert.ok(
    playerCalls.includes('removeAttribute:src'),
    'the src attribute must be removed — assigning src = "" resolves against the page URL instead of detaching',
  );
  assert.ok(
    playerCalls.includes('load'),
    'load() is what actually detaches the media resource after the src attribute is gone',
  );
  assert.equal(fakePlayer.hidden, true, 'the player must be hidden so there is no dead control to click');
});

test('the no-audio branch of stopAndSend calls resetPlayer, and index.html ships the player hidden', () => {
  const stopAndSendSource = extractFunctionSource('stopAndSend');
  const branchIndex = stopAndSendSource.indexOf('if (audioPcm)');
  assert.ok(branchIndex !== -1, "sanity: stopAndSend must branch on 'if (audioPcm)'");

  assert.match(
    stopAndSendSource.slice(branchIndex),
    /\}\s*else\s*\{[\s\S]*?resetPlayer\(\)/,
    'the if (audioPcm) block must carry an else branch that calls resetPlayer() — without it a no-audio ' +
      'turn leaves whatever the last audio turn loaded sitting in the player',
  );

  assert.match(
    indexHtmlSource,
    /<audio[^>]*\bid="player"[^>]*\bhidden\b[^>]*>/,
    'the player must ship hidden, so it is not a dead clickable control before the first audio reply',
  );
  assert.match(
    indexHtmlSource,
    /audio\[hidden\]\s*\{\s*display:\s*none;\s*\}/,
    'an audio[hidden] display rule must back the hidden attribute, matching the .pill[hidden] precedent',
  );
});

// docs/API.md's "Client read timeout" section records this client as a deliberate opt-out that
// runs tighter than the published floor, and its "Consuming the response body" section makes the
// same opt-out claim about buffering. Raising this value to the floor — the plausible "make the
// browser compliant" edit — would silently falsify both statements. Asserting the documented
// *relationship* rather than the literal, so retuning the browser's own UX value stays free.
test('the browser client stays deliberately below the published client read-timeout floor', () => {
  const declared = appJsSource.match(/const REQUEST_TIMEOUT_MS = (\d+);/);
  assert.ok(declared, 'apps/voice-web/app.js must declare REQUEST_TIMEOUT_MS');
  const browserTimeoutMs = Number(declared[1]);
  assert.ok(
    browserTimeoutMs < MIN_CLIENT_READ_TIMEOUT_MS,
    `the browser's REQUEST_TIMEOUT_MS (${browserTimeoutMs}) must stay below the published floor (${MIN_CLIENT_READ_TIMEOUT_MS}) — docs/API.md records this client as a deliberate sub-floor opt-out, and raising it to the floor makes that published claim false`,
  );
});

// Phase 7 SC2+SC5: WR-05's mic-permission guards (05-REVIEW.md) landed at both call sites with
// no test, so either could be deleted or emptied silently — and a denied microphone is the
// single most common real-world failure mode for a mic app. Both call sites live inside inline
// arrow event listeners (pointerdown and keydown), which extractFunctionSource/loadBrowserFunction
// cannot reach — they anchor on a top-level `function name(` declaration — so this is a
// source-shape assertion by necessity, not by preference.
// WR-01 (10-REVIEW.md) / Success Criterion 3 (10-VERIFICATION.md), Plan 10-05: this test's
// subject moved from "each of two inline listener bodies" to "the single beginRecording()
// choke point plus each listener's delegation to it" — the consolidation collapses what were
// two await ensureRecorder() call sites into one, so the sanity premise below now asserts
// exactly one rather than at least two.
test('every awaited ensureRecorder() call site is wrapped in a catch that surfaces the failure and stops', () => {
  const callSites = appJsSource.match(/await ensureRecorder\(\)/g) ?? [];
  assert.equal(
    callSites.length,
    1,
    `Plan 10-05 consolidated the pointer and keyboard trigger paths into the single beginRecording() choke ` +
      `point, so exactly one await ensureRecorder() call site is expected; found ${callSites.length}. A second ` +
      'call site reappearing means a path bypassed the choke point.',
  );

  const beginRecordingSource = extractFunctionSource('beginRecording');
  assert.ok(
    beginRecordingSource.includes('await ensureRecorder()'),
    'the sole await ensureRecorder() call site must live inside beginRecording()',
  );

  // Plan 10-09 moved the recorder start call inside this same guarded block, so the try body
  // now carries statements after the awaited acquisition. The inserted (?:[^{}]*) segment is
  // non-capturing (existing capture indices for the catch-binding name and catch body below
  // are unshifted) and deliberately brace-free: a nested block, an if, or a second try added
  // to the guarded body drops the match count to zero and fails loudly rather than passing,
  // which is what keeps this guard's teeth after the body was allowed to grow.
  const guardPattern = /try\s*\{\s*await ensureRecorder\(\);(?:[^{}]*)\}\s*catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([^{}]*)\}/g;
  const guarded = [...appJsSource.matchAll(guardPattern)];

  assert.equal(
    guarded.length,
    callSites.length,
    `every awaited ensureRecorder() call must sit inside a try/catch: ${callSites.length} call sites but ` +
      `${guarded.length} guarded ones. A removed guard, or a newly added second call site left unguarded, fails here ` +
      'rather than passing silently — a getUserMedia rejection with no catch is an unhandled rejection the user never sees.',
  );

  for (const [index, match] of guarded.entries()) {
    const body = match[2];
    const statusCall = /setStatus\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/.exec(body);
    assert.ok(
      statusCall,
      `ensureRecorder guard #${index + 1} must call setStatus with a quoted string literal — an emptied catch body ` +
        'swallows a denied microphone into silence, which is the exact defect WR-05 closed.',
    );
    assert.ok(
      statusCall[2].length > 0,
      `ensureRecorder guard #${index + 1} must pass a non-empty message to setStatus — a blank status line tells the ` +
        'user nothing.',
    );
    assert.match(
      body,
      /setHint\(/,
      `ensureRecorder guard #${index + 1} must call setHint so the user is told what to do about the failure, not just ` +
        'that it happened.',
    );
    assert.match(
      body,
      /\breturn\b/,
      `ensureRecorder guard #${index + 1} must return rather than fall through — proceeding past a failed ` +
        'ensureRecorder() starts a recording against a mediaRecorder that does not exist.',
    );
  }
});

// =====================================================================================
// DEBT-08: hasToken() and its two call sites. This is a UX convenience, not the
// access-control boundary — a tokenless request still receives a real 401 from the
// server's own request validation (AUTH-04 / validateRequest()), enforced independently
// of anything this page does. These tests exist to stop the browser from attempting a
// request it already knows will be refused, and to give the user a clearer message than a
// round-trip 401 would. Do not read them as proof of an access-control boundary; the
// server enforces that, not this file (RESEARCH.md Pitfall 4).
// =====================================================================================

// WR-01 (10-REVIEW.md) / Success Criterion 3 (10-VERIFICATION.md), Plan 10-05: this test's
// subject moved from "each of two inline listener bodies" to "the single beginRecording()
// choke point plus each listener's delegation to it" — mediaRecorder.start() now has exactly
// one call site (inside beginRecording()), so the recording-start *paths* this test walks are
// the two await beginRecording() call sites, not two mediaRecorder.start() sites.
test('every path that starts a recording is preceded by a token-presence refusal in the same listener', () => {
  const recordingStarts = [...appJsSource.matchAll(/mediaRecorder\.start\(\)/g)];
  assert.equal(
    recordingStarts.length,
    1,
    `Plan 10-05 consolidated the pointer and keyboard trigger paths into the single beginRecording() choke ` +
      `point, so exactly one mediaRecorder.start() call is expected; found ${recordingStarts.length}.`,
  );

  const beginRecordingSource = extractFunctionSource('beginRecording');
  assert.ok(
    beginRecordingSource.includes('mediaRecorder.start()'),
    'the sole mediaRecorder.start() call must live inside beginRecording()',
  );

  const chokePointCalls = [...appJsSource.matchAll(/await beginRecording\(\)/g)];
  assert.ok(
    chokePointCalls.length >= 2,
    `sanity premise: apps/voice-web/app.js must await beginRecording() at least twice (the pointer path and ` +
      `the keyboard path); found ${chokePointCalls.length}. If a path was deliberately removed, this premise is ` +
      'what needs updating — do not weaken the guarded-count equality below.',
  );

  const refusals = [...appJsSource.matchAll(/if\s*\(\s*!hasToken\(\)\s*\)/g)];
  assert.equal(
    refusals.length,
    chokePointCalls.length,
    `every path reaching beginRecording() must be preceded by a token-presence refusal: ${chokePointCalls.length} ` +
      `choke-point call site(s) but ${refusals.length} refusal(s). A newly added third trigger path left ` +
      'unguarded fails here rather than shipping silently.',
  );

  const listenerRegistrationPattern = /addEventListener\(/g;
  for (const startMatch of chokePointCalls) {
    let nearestListenerIndex = -1;
    listenerRegistrationPattern.lastIndex = 0;
    let listenerMatch;
    while ((listenerMatch = listenerRegistrationPattern.exec(appJsSource)) !== null) {
      if (listenerMatch.index > startMatch.index) break;
      nearestListenerIndex = listenerMatch.index;
    }
    assert.ok(
      nearestListenerIndex !== -1,
      `expected an addEventListener( registration preceding the beginRecording() call at index ${startMatch.index}`,
    );
    const slice = appJsSource.slice(nearestListenerIndex, startMatch.index);
    assert.match(
      slice,
      /if\s*\(\s*!hasToken\(\)\s*\)/,
      'the token-presence refusal must sit inside the same listener that reaches beginRecording() — this is ' +
        'what proves the guard is inside the same listener, not merely somewhere else in the file',
    );
  }
});

test('each token-presence refusal tells the user what to do and stops rather than falling through', () => {
  const guardPattern = /if\s*\(\s*!hasToken\(\)\s*\)\s*\{([^{}]*)\}/g;
  const guarded = [...appJsSource.matchAll(guardPattern)];
  assert.ok(
    guarded.length >= 2,
    `sanity premise: expected at least two hasToken() refusal bodies to inspect; found ${guarded.length}`,
  );

  for (const [index, match] of guarded.entries()) {
    const body = match[1];
    const statusCall = /setStatus\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/.exec(body);
    assert.ok(
      statusCall,
      `hasToken refusal #${index + 1} must call setStatus with a quoted string literal — a refusal with no message ` +
        'tells the user nothing about why nothing happened.',
    );
    assert.ok(
      statusCall[2].length > 0,
      `hasToken refusal #${index + 1} must pass a non-empty message to setStatus.`,
    );
    assert.match(
      body,
      /setHint\(/,
      `hasToken refusal #${index + 1} must call setHint so the user is told what to do about the refusal, not just ` +
        'that it happened.',
    );
    assert.match(
      body,
      /\breturn\b/,
      `hasToken refusal #${index + 1} must return rather than fall through — proceeding past a missing token ` +
        'starts a request the server will reject anyway.',
    );
  }
});

test('hasToken treats a whitespace-only token as absent', () => {
  const fakeTokenEl = { value: '   ' };
  const hasToken = loadBrowserFunction('hasToken', { tokenEl: fakeTokenEl });

  assert.equal(hasToken(), false, 'a whitespace-only token must be treated as absent');

  fakeTokenEl.value = '  abc  ';
  assert.equal(hasToken(), true, 'a token with non-whitespace content must be treated as present after trimming');

  fakeTokenEl.value = '';
  assert.equal(hasToken(), false, 'an empty token must be treated as absent');
});

// =====================================================================================
// DEBT-09: the microphone stream is released after every turn rather than held for the
// page's lifetime. The operating system's mic-in-use indicator is the user's only signal
// that audio *could* be captured — holding the stream open makes that signal misreport.
// releaseMicStream() stops every track (never mutes — a muted track keeps the indicator
// lit while silencing audio) and clears both module-scope bindings, which is what lets
// ensureRecorder()'s existing early-return guard fall through and re-acquire on the next
// turn (RESEARCH.md Pitfall 2). This defect is live at HEAD, so its RED direction needs no
// historical worktree — the five tests below were run against the unfixed file first.
// =====================================================================================

test('releaseMicStream stops every track on the acquired stream', () => {
  const stopCalls = [];
  const fakeTrackA = { stop() { stopCalls.push('a'); } };
  const fakeTrackB = { stop() { stopCalls.push('b'); } };
  const fakeStream = { getTracks: () => [fakeTrackA, fakeTrackB] };

  const releaseMicStream = loadBrowserFunction('releaseMicStream', {
    stream: fakeStream,
    mediaRecorder: {},
  });

  releaseMicStream();

  assert.deepEqual(
    stopCalls,
    ['a', 'b'],
    'every track returned by getTracks() must receive a stop() call, regardless of order',
  );
  assert.ok(
    !('enabled' in fakeTrackA) && !('enabled' in fakeTrackB),
    'the release must stop each track, never mute it — setting track.enabled silences audio while leaving ' +
      'the operating system indicator lit, which would make the code claim a release it did not perform',
  );
});

test('releaseMicStream is a no-op rather than a throw when no stream was ever acquired', () => {
  const releaseWithUndefinedStream = loadBrowserFunction('releaseMicStream', {
    stream: undefined,
    mediaRecorder: undefined,
  });
  assert.doesNotThrow(
    () => releaseWithUndefinedStream(),
    'releaseMicStream must not throw when no stream was ever acquired',
  );

  const releaseWithEmptyStream = loadBrowserFunction('releaseMicStream', {
    stream: { getTracks: () => [] },
    mediaRecorder: undefined,
  });
  assert.doesNotThrow(
    () => releaseWithEmptyStream(),
    'releaseMicStream must not throw when the acquired stream reports zero tracks',
  );
});

test('releaseMicStream clears both module bindings so the next turn re-acquires the microphone', () => {
  // loadBrowserFunction injects deps as function parameters, so an assignment the extracted
  // function makes to `stream` or `mediaRecorder` rebinds the parameter and is invisible to
  // the caller. The nulling is asserted on the function's own source text instead — do not
  // "improve" this into an injection-based assertion; it cannot fail if rewritten that way.
  const releaseMicStreamSource = extractFunctionSource('releaseMicStream');
  assert.match(
    releaseMicStreamSource,
    /\bstream\s*=\s*null\s*;/,
    'releaseMicStream must assign null to the stream binding',
  );
  assert.match(
    releaseMicStreamSource,
    /\bmediaRecorder\s*=\s*null\s*;/,
    'releaseMicStream must assign null to the mediaRecorder binding',
  );

  const ensureRecorderSource = extractFunctionSource('ensureRecorder');
  assert.match(
    ensureRecorderSource,
    /^\s*if\s*\(\s*mediaRecorder\s*\)\s*return\s*;/m,
    'ensureRecorder must still open with its early-return guard on mediaRecorder — the release depends on ' +
      'that guard falling through on the next turn once mediaRecorder is null',
  );
});

test('findMatchingClose returns the brace closing the block it was given, not the first closing brace it meets', () => {
  const flatBlock = '{ a; b; }';
  assert.equal(
    findMatchingClose(flatBlock, 0),
    flatBlock.length - 1,
    'a flat block with no nesting must resolve to its own single closing brace',
  );

  const nestedBlock = '{ if (x) { y(); } z(); }';
  const naiveFirstClose = nestedBlock.indexOf('}');
  const trueOuterClose = nestedBlock.length - 1;
  assert.notEqual(
    naiveFirstClose,
    trueOuterClose,
    'sanity premise: this fixture must make a first-match scan wrong, or the test proves nothing',
  );
  assert.equal(
    findMatchingClose(nestedBlock, 0),
    trueOuterClose,
    'a block containing a nested block must resolve to the OUTER close, not the first closing brace a naive scan meets',
  );

  assert.throws(
    () => findMatchingClose('{ a; b;', 0),
    /unbalanced braces/,
    'unbalanced input must throw rather than return a wrong index',
  );
});

test('stopAndSend releases the microphone in its finally block, so the release survives the error path', () => {
  const stopAndSendSource = extractFunctionSource('stopAndSend');
  // Located by the keyword form, not a bare-word search: IN-01 (10-REVIEW.md) documents how
  // a bare-substring search for the finally keyword can be defeated by a comment mentioning
  // that word after the real block header — matching the convention Plan 10-05's newer test
  // (`the acquisition guard is read and set synchronously, before the first await`) already uses.
  // WR-02 (10-REVIEW.md): the keyword form alone was insufficient, because stopAndSend()
  // contains TWO `} finally {` blocks — the inner one guarding clearTimeout around the fetch
  // call, and the outer one that actually contains releaseMicStream() — and a non-global
  // `.exec()` returns only the first (inner) match, so the old comparison held regardless of
  // which block the call was really in. The locator now walks every occurrence and takes the
  // last, on the premise that textually-last-is-outermost holds at this one level of nesting;
  // the exact-count assertion below is what makes a future third `finally` fail loudly instead
  // of silently re-opening the same hole.
  // WR-01 (10-REVIEW.md), tracked as WR-04 in this gap-closure round's own numbering
  // (10-VERIFICATION.md): the last-match retarget fixed which block the check anchors on but
  // left the check one-sided, proving only that the call is after the block's opening brace —
  // a release moved past the block's own closing brace passed that check on a source carrying
  // the exact regression this test names. The check below is now a containment check bounded
  // by the block's own matching braces, located by findMatchingClose.
  const finallyMatches = [...stopAndSendSource.matchAll(/\}\s*finally\s*\{/g)];
  assert.equal(
    finallyMatches.length,
    2,
    `expected exactly two '} finally {' blocks in stopAndSend — the inner one guarding clearTimeout around ` +
      `the fetch call, and the outer one containing releaseMicStream(); found ${finallyMatches.length}. A ` +
      'third occurrence means the nesting changed and the textually-last-is-outermost assumption this test ' +
      'rests on must be re-derived, not simply bumped.',
  );
  const outerFinallyIndex = finallyMatches[finallyMatches.length - 1].index;

  const callMatches = [...stopAndSendSource.matchAll(/releaseMicStream\(\)/g)];
  assert.equal(
    callMatches.length,
    1,
    `expected exactly one releaseMicStream() call in stopAndSend; found ${callMatches.length}`,
  );

  const outerFinallyOpenBrace = stopAndSendSource.indexOf('{', outerFinallyIndex);
  const outerFinallyCloseBrace = findMatchingClose(stopAndSendSource, outerFinallyOpenBrace);

  // findMatchingClose is a lexer-free scan: a brace inside a string, template, regex or
  // comment within the scanned region would desynchronize the depth counter. Today's outer
  // finally body holds three bare statements and no such literal, so the hazard is not live —
  // guarded anyway, because a pin must fail loudly when its premise stops holding rather than
  // mis-locate silently. Sound rather than circular: a stray opening brace inside a literal
  // only extends the computed region, and a stray closing brace inside a literal only
  // truncates it to a point still after that literal's own opening delimiter — so in either
  // desync direction the computed region still contains the offending quote or comment
  // marker, and this assertion fires. If it ever does fire, re-derive the locator against the
  // new body; do not relax this guard.
  const outerFinallyRegion = stopAndSendSource.slice(outerFinallyOpenBrace, outerFinallyCloseBrace + 1);
  assert.ok(
    !/['"`]/.test(outerFinallyRegion) && !outerFinallyRegion.includes('//') && !outerFinallyRegion.includes('/*'),
    'the outer finally region must contain no quote character and no comment-opening sequence — a brace ' +
      'inside a string, template, regex or comment here would desynchronize findMatchingClose\'s raw-text walk',
  );

  assert.ok(
    callMatches[0].index > outerFinallyOpenBrace && callMatches[0].index < outerFinallyCloseBrace,
    'releaseMicStream() must be called strictly inside the OUTERMOST finally block\'s own braces: a call ' +
      'placed after that block closes is skipped by every early return inside the try body (the TURN_BUSY ' +
      'branch, the non-ok branch, and the splitter catch), and a call placed in the try body before the ' +
      'block is skipped by a thrown error',
  );
});

test('the comment above ensureRecorder describes releasing the stream rather than holding it', () => {
  const declarationPattern = /^(?:async )?function ensureRecorder\(/m;
  const declarationMatch = declarationPattern.exec(appJsSource);
  assert.ok(declarationMatch, 'sanity premise: expected a top-level ensureRecorder( declaration in apps/voice-web/app.js');

  const precedingLines = appJsSource.slice(0, declarationMatch.index).split('\n');
  // The slice ends with the newline separating the last comment line from the declaration
  // line, so the final split entry is an empty artifact of that boundary, not a blank line
  // in the source — drop it before walking backwards over actual comment lines.
  if (precedingLines[precedingLines.length - 1] === '') precedingLines.pop();
  const commentLines = [];
  for (let i = precedingLines.length - 1; i >= 0; i--) {
    const line = precedingLines[i];
    if (line.trim() === '') break;
    if (!/^\s*\/\//.test(line)) break;
    commentLines.unshift(line);
  }
  const commentBlock = commentLines.join('\n');
  assert.ok(commentBlock.length > 0, 'sanity premise: expected a contiguous // comment block preceding ensureRecorder');

  assert.match(
    commentBlock,
    /releaseMicStream/,
    'the comment above ensureRecorder must name releaseMicStream so it describes what the code now does',
  );
  assert.ok(
    !commentBlock.includes('is intentional, not an oversight'),
    'the comment must no longer carry the pre-fix claim that holding the stream open is deliberate — that ' +
      'trade is no longer real (RESEARCH.md assumption A1)',
  );
});

// =====================================================================================
// WR-01 (10-REVIEW.md) / Success Criterion 3 (10-VERIFICATION.md), Plan 10-05: DEBT-09's own
// fix reopened a cross-input-path TOCTOU race on every turn. releaseMicStream() nulls
// mediaRecorder after each turn, so ensureRecorder()'s `if (mediaRecorder) return;` guard —
// which used to short-circuit synchronously for the whole life of the page after the first
// turn — can be passed concurrently by the pointer and the keyboard path on every single
// turn. beginRecording() closes that window with a synchronous isAcquiring flag read and set
// before the first await. This defect is live at HEAD (beginRecording does not exist yet), so
// its RED direction needs no historical worktree — all seven assertions below (five new, two
// retargeted above) were run against the unfixed file first.
// =====================================================================================

test('beginRecording acquires exactly one microphone stream when both trigger paths fire inside one acquisition window', () => {
  // This file's loadBrowserFunction builds its factory once and calls it once, so the
  // injected deps live in that factory's own scope and the returned function closes over
  // them — two calls to the returned beginRecording function share one isAcquiring binding.
  // That property is what makes this a real concurrent-execution assertion rather than a
  // structural one; a later "improvement" that rebuilds the function per call would silently
  // make it unable to fail. (The caller still cannot read the flag's value back — that
  // limitation, recorded in the DEBT-09 bindings test above, is unchanged.)
  let acquisitionCount = 0;
  let releaseAcquisition;
  const gate = new Promise((resolve) => { releaseAcquisition = resolve; });
  const fakeMediaRecorder = { startCalls: 0, start() { fakeMediaRecorder.startCalls++; } };

  const beginRecording = loadBrowserFunction('beginRecording', {
    isBusy: false,
    isRecording: false,
    isAcquiring: false,
    async ensureRecorder() {
      acquisitionCount++;
      await gate;
    },
    setStatus: () => {},
    setHint: () => {},
    releaseMicStream: () => {},
    recordedChunks: [],
    mediaRecorder: fakeMediaRecorder,
  });

  const firstCall = beginRecording();
  const secondCall = beginRecording();
  releaseAcquisition();

  return Promise.all([firstCall, secondCall]).then(([firstResult, secondResult]) => {
    assert.equal(
      acquisitionCount,
      1,
      'exactly one ensureRecorder() acquisition must occur when two triggers fire inside one acquisition window',
    );
    assert.equal(firstResult, true, 'the first (winning) trigger must resolve true');
    assert.equal(secondResult, false, 'the second (losing) trigger must be refused (resolve false), not queued');
    assert.equal(fakeMediaRecorder.startCalls, 1, 'mediaRecorder.start() must be called exactly once');
  });
});

test('beginRecording clears its acquisition flag when the microphone is refused, so a later trigger is not locked out', async () => {
  let ensureRecorderCallCount = 0;
  const fakeMediaRecorder = { startCalls: 0, start() { fakeMediaRecorder.startCalls++; } };

  const beginRecording = loadBrowserFunction('beginRecording', {
    isBusy: false,
    isRecording: false,
    isAcquiring: false,
    async ensureRecorder() {
      ensureRecorderCallCount++;
      if (ensureRecorderCallCount === 1) throw new Error('denied');
    },
    setStatus: () => {},
    setHint: () => {},
    releaseMicStream: () => {},
    recordedChunks: [],
    mediaRecorder: fakeMediaRecorder,
  });

  const firstResult = await beginRecording();
  assert.equal(firstResult, false, 'a denied microphone must resolve false');

  const secondResult = await beginRecording();
  assert.equal(
    secondResult,
    true,
    'a later trigger must not be locked out by a flag left set from the thrown path — the flag must be cleared ' +
      'in a finally, not only on the successful path',
  );
  assert.equal(
    fakeMediaRecorder.startCalls,
    1,
    'the acquisition counter (recorder starts) must reach exactly 1 on the successful path — proving the flag ' +
      'was cleared by the finally rather than left set by the thrown path, which would have refused this second call too',
  );
});

test('a microphone acquisition that fails part-way releases the stream it already took', async () => {
  const releaseCalls = [];

  const beginRecording = loadBrowserFunction('beginRecording', {
    isBusy: false,
    isRecording: false,
    isAcquiring: false,
    async ensureRecorder() {
      throw new Error('recorder construction failed');
    },
    setStatus: () => {},
    setHint: () => {},
    releaseMicStream: () => releaseCalls.push('release'),
    recordedChunks: [],
    mediaRecorder: {},
  });

  const result = await beginRecording();

  assert.equal(result, false, 'a part-way acquisition failure must resolve false');
  assert.equal(
    releaseCalls.length,
    1,
    'ensureRecorder() assigns stream before it constructs the MediaRecorder, so a construction failure leaves a ' +
      'live stream unreachable from every binding releaseMicStream() reads unless beginRecording() releases it ' +
      'itself right here',
  );
});

test('the acquisition guard is read and set synchronously, before the first await', () => {
  const beginRecordingSource = extractFunctionSource('beginRecording');

  const guardIndex = beginRecordingSource.indexOf('isAcquiring');
  assert.ok(guardIndex !== -1, "sanity premise: expected 'isAcquiring' to occur in beginRecording()'s source");

  const setIndex = beginRecordingSource.indexOf('isAcquiring = true');
  assert.ok(setIndex !== -1, "expected an 'isAcquiring = true' assignment in beginRecording()");
  assert.ok(
    guardIndex < setIndex,
    'the guard condition naming the acquisition flag must occur before the assignment that sets it true',
  );

  const awaitIndex = beginRecordingSource.indexOf('await');
  assert.ok(awaitIndex !== -1, "sanity premise: expected an 'await' in beginRecording()'s source");
  assert.ok(
    setIndex < awaitIndex,
    'a flag set after the await is exactly the check-then-act window this gap closed — the assignment must ' +
      'occur before the first await',
  );

  // Located by the keyword form, not a bare-word search: IN-01 (10-REVIEW.md) documents how
  // a bare-substring search for the finally keyword can match the word inside a comment.
  // That correction is Plan 10-08's; this new test must not reproduce the pattern it corrects.
  const finallyMatch = /\}\s*finally\s*\{/.exec(beginRecordingSource);
  assert.ok(finallyMatch, "expected a '} finally {' block in beginRecording()");

  const clearIndex = beginRecordingSource.indexOf('isAcquiring = false', finallyMatch.index);
  assert.ok(
    clearIndex !== -1 && clearIndex > finallyMatch.index,
    'the assignment that clears the acquisition flag must occur after the finally keyword',
  );
});

test('neither trigger listener runs its recording UI after beginRecording refuses', () => {
  const refusalPattern = /if\s*\(\s*!\s*\(\s*await beginRecording\(\)\s*\)\s*\)\s*return;/g;
  const refusals = [...appJsSource.matchAll(refusalPattern)];
  const chokePointCalls = [...appJsSource.matchAll(/await beginRecording\(\)/g)];

  assert.equal(
    refusals.length,
    2,
    `expected exactly two refusal-and-return sites of the form 'if (!(await beginRecording())) return;'; found ` +
      `${refusals.length}`,
  );
  assert.equal(
    refusals.length,
    chokePointCalls.length,
    'every await beginRecording() call site must be a negated refusal-and-return — a call site that does not ' +
      'check the result would run its recording UI even after beginRecording() refused',
  );
});

// =====================================================================================
// WR-03 (10-REVIEW.md, this gap-closure run's numbering) / Success Criterion 3
// (10-VERIFICATION.md): Plan 10-05's beginRecording() choke point closed the
// cross-input-path acquisition race, but its own mediaRecorder.start() call still sat
// outside the try/catch/finally it introduced. Per the MediaRecorder specification,
// start() throws InvalidStateError when the stream carries no live track — reachable if
// the track stops being live in the narrow window between getUserMedia() resolving
// (inside ensureRecorder()) and this call: an external microphone disconnecting, the OS
// revoking a grant, another process claiming exclusive access. Before this fix, that
// throw escaped as an unhandled promise rejection with no user feedback, left
// mediaRecorder/stream non-null forever, and never set isRecording — wedging every later
// trigger into ensureRecorder()'s own `if (mediaRecorder) return;` silent no-op for the
// rest of the page's life.
//
// What the two executing tests below can and cannot observe: loadBrowserFunction builds
// its factory once and calls it once, so injected deps live in that factory's scope and
// the returned function closes over them — an injected releaseMicStream is a fake, and an
// assignment the *real* releaseMicStream makes to stream/mediaRecorder rebinds a
// parameter and is invisible to the caller. These two tests prove releaseMicStream() WAS
// CALLED on the start-throw path; the pre-existing "releaseMicStream clears both module
// bindings" test above proves that function nulls both bindings. It is the two together
// that close the wedge — neither half alone is the whole argument.
// =====================================================================================

test('a recorder start that throws after a successful acquisition releases the stream and refuses instead of rejecting', async () => {
  const releaseCalls = [];
  const statusCalls = [];
  const hintCalls = [];
  const fakeMediaRecorder = {
    startCalls: 0,
    start() {
      fakeMediaRecorder.startCalls++;
      const error = new Error('The associated MediaStream has no live tracks.');
      error.name = 'InvalidStateError';
      throw error;
    },
  };

  const beginRecording = loadBrowserFunction('beginRecording', {
    isBusy: false,
    isRecording: false,
    isAcquiring: false,
    async ensureRecorder() {},
    setStatus: (message) => statusCalls.push(message),
    setHint: (message) => hintCalls.push(message),
    releaseMicStream: () => releaseCalls.push('release'),
    recordedChunks: [],
    mediaRecorder: fakeMediaRecorder,
  });

  const result = await beginRecording();

  assert.equal(result, false, 'a recorder start that throws must resolve false, not reject');
  assert.equal(releaseCalls.length, 1, 'releaseMicStream() must be called exactly once on the start-throw path');
  assert.equal(statusCalls.length, 1, 'setStatus must be called exactly once with feedback about the failure');
  assert.ok(statusCalls[0] && statusCalls[0].length > 0, 'the setStatus message must be non-empty');
  assert.equal(hintCalls.length, 1, 'setHint must be called exactly once with feedback about the failure');
  assert.ok(hintCalls[0] && hintCalls[0].length > 0, 'the setHint message must be non-empty');
  assert.equal(
    fakeMediaRecorder.startCalls,
    1,
    'the fake recorder start counter must read 1, proving the throw came from the real start() call site and ' +
      'this assertion is not vacuous',
  );
});

test('a recorder start that throws does not lock the page out of the next acquisition', async () => {
  const releaseCalls = [];
  let ensureRecorderCallCount = 0;
  const fakeMediaRecorder = {
    startCalls: 0,
    start() {
      fakeMediaRecorder.startCalls++;
      if (fakeMediaRecorder.startCalls === 1) {
        const error = new Error('The associated MediaStream has no live tracks.');
        error.name = 'InvalidStateError';
        throw error;
      }
    },
  };

  const beginRecording = loadBrowserFunction('beginRecording', {
    isBusy: false,
    isRecording: false,
    isAcquiring: false,
    async ensureRecorder() {
      ensureRecorderCallCount++;
    },
    setStatus: () => {},
    setHint: () => {},
    releaseMicStream: () => releaseCalls.push('release'),
    recordedChunks: [],
    mediaRecorder: fakeMediaRecorder,
  });

  const firstResult = await beginRecording();
  const secondResult = await beginRecording();

  assert.equal(firstResult, false, 'the first call, whose start throws, must resolve false');
  // The second call succeeding is what proves the acquisition flag was cleared in the
  // finally rather than left set by the thrown path — the module-binding half of the
  // no-wedge argument (that releaseMicStream actually nulls the bindings) is carried by
  // the pre-existing bindings test, not by this one.
  assert.equal(secondResult, true, 'the second call, whose start succeeds, must resolve true — not locked out');
  assert.equal(fakeMediaRecorder.startCalls, 2, 'the start counter must reach 2');
  assert.equal(ensureRecorderCallCount, 2, 'ensureRecorder must have been entered twice');
  assert.equal(
    releaseCalls.length,
    1,
    'releaseMicStream() must still have been called only once — only the first call threw',
  );
});

test("the recorder start call sits inside beginRecording's guarded block, not after it", () => {
  const beginRecordingSource = extractFunctionSource('beginRecording');

  const catchMatch = /\}\s*catch\s*\(/.exec(beginRecordingSource);
  assert.ok(catchMatch, "sanity premise: expected a '} catch (' in beginRecording()'s source");

  const startMatches = [...beginRecordingSource.matchAll(/mediaRecorder\.start\(\)/g)];
  assert.equal(startMatches.length, 1, 'expected exactly one recorder start call in beginRecording()');

  assert.ok(
    startMatches[0].index < catchMatch.index,
    'the recorder start call must occur before the catch that closes its guarded try block — a start call ' +
      'after the guard throws into nothing: no user feedback, no release, and a recorder binding left ' +
      'non-null that makes every later press a silent no-op',
  );

  const chunksResetIndex = beginRecordingSource.indexOf('recordedChunks = []');
  assert.ok(chunksResetIndex !== -1, "expected a 'recordedChunks = []' assignment in beginRecording()");
  assert.ok(
    chunksResetIndex < catchMatch.index,
    'the recordedChunks reset must also occur before the catch that closes the guarded try block',
  );

  const recordingFlagIndex = beginRecordingSource.indexOf('isRecording = true');
  assert.ok(recordingFlagIndex !== -1, "expected an 'isRecording = true' assignment in beginRecording()");
  assert.ok(
    recordingFlagIndex > startMatches[0].index,
    'the recorder-active flag must be set only after the start call — setting it before would leave it set ' +
      "after a throw and strand finishRecording()'s own isRecording guard",
  );
});
