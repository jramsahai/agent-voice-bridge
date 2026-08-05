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

  const reportTurnError = loadBrowserFunction('reportTurnError', {
    setTurnBusyState: (active) => busyStateCalls.push(active),
    setStatus: (text) => statusCalls.push(text),
    setHint: (text) => hintCalls.push(text),
    humanizeErrorCode,
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
