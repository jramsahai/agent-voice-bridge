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
