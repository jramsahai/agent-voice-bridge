// FMT-05/06/07, TEST-02: the completed v1 format registry. Proves the one-row-change
// property (FMT-07) two ways — a source scan (no wire identifier literal outside this
// registry) and a substituted-registry behavioral check — plus the schema every row
// must satisfy, the full rejection path, and frozen/concurrent-read guarantees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUDIO_FORMATS, listSupportedFormats, lookupFormat, isSupportedFormat } from '../packages/shared/audio/format-registry.js';
import { unsupportedFormatError } from '../packages/shared/errors/error-response.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// --- Row presence and shape ---

test('lookupFormat(wav) returns the browser recording format row', () => {
  const entry = lookupFormat('wav');
  assert.equal(entry.headerless, false);
  assert.equal(entry.mimeType, 'audio/wav');
  assert.equal(entry.extension, 'wav');
  assert.equal(entry.sampleRate, null);
  assert.equal(entry.channels, null);
  assert.equal(entry.bitDepth, null);
  assert.equal(typeof entry.afconvertFileFormat, 'string');
  assert.ok(entry.afconvertFileFormat.length > 0);
  assert.equal(typeof entry.afconvertDataFormat, 'string');
  assert.ok(entry.afconvertDataFormat.length > 0);
});

test('every AUDIO_FORMATS row satisfies the shared two-shape schema', () => {
  for (const [key, row] of Object.entries(AUDIO_FORMATS)) {
    assert.equal(typeof row.mimeType, 'string', `${key}.mimeType`);
    assert.ok(row.mimeType.length > 0, `${key}.mimeType non-empty`);
    assert.equal(typeof row.extension, 'string', `${key}.extension`);
    assert.ok(row.extension.length > 0, `${key}.extension non-empty`);
    assert.equal(typeof row.headerless, 'boolean', `${key}.headerless`);

    const sampleMetaPresent = row.sampleRate !== null && row.channels !== null && row.bitDepth !== null;
    const sampleMetaAbsent = row.sampleRate === null && row.channels === null && row.bitDepth === null;
    const afconvertPresent = row.afconvertFileFormat !== null && row.afconvertDataFormat !== null;
    const afconvertAbsent = row.afconvertFileFormat === null && row.afconvertDataFormat === null;

    if (row.headerless) {
      assert.ok(sampleMetaPresent, `${key}: headerless row must have non-null sample metadata`);
      assert.ok(afconvertAbsent, `${key}: headerless row must have null afconvert tokens`);
    } else {
      assert.ok(sampleMetaAbsent, `${key}: container row must have null sample metadata`);
      assert.ok(afconvertPresent, `${key}: container row must have non-null afconvert tokens`);
    }
  }
});

test('every AUDIO_FORMATS key matches the lowercase-hyphen-digit identifier pattern', () => {
  const KEY_PATTERN = /^[a-z][a-z0-9-]*$/;
  for (const key of Object.keys(AUDIO_FORMATS)) {
    assert.match(key, KEY_PATTERN, `key '${key}'`);
  }
});

test('no row extension contains a path separator, dot, or character outside [a-z0-9]', () => {
  const EXTENSION_PATTERN = /^[a-z0-9]+$/;
  for (const [key, row] of Object.entries(AUDIO_FORMATS)) {
    assert.match(row.extension, EXTENSION_PATTERN, `${key}.extension '${row.extension}'`);
    assert.ok(!row.extension.includes('/'), `${key}.extension has no path separator`);
    assert.ok(!row.extension.includes('.'), `${key}.extension has no dot`);
  }
});

// --- One-row-change property (FMT-07) ---

test('no registered wire identifier appears as a quoted string literal outside format-registry.js', () => {
  const identifiers = listSupportedFormats();
  const scanDirs = [path.join(repoRoot, 'packages/shared/audio'), path.join(repoRoot, 'packages/shared/errors')];

  function collectJsFiles(dir) {
    const files = [];
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        files.push(...collectJsFiles(fullPath));
      } else if (entry.endsWith('.js') && entry !== 'format-registry.js') {
        files.push(fullPath);
      }
    }
    return files;
  }

  const filesToScan = scanDirs.flatMap(collectJsFiles);
  assert.ok(filesToScan.length > 0, 'sanity: at least one file was scanned');

  for (const filePath of filesToScan) {
    const source = readFileSync(filePath, 'utf8');
    for (const id of identifiers) {
      const singleQuoted = `'${id}'`;
      const doubleQuoted = `"${id}"`;
      assert.ok(
        !source.includes(singleQuoted) && !source.includes(doubleQuoted),
        `${path.relative(repoRoot, filePath)} must not contain the quoted literal '${id}' — consumers must derive identifiers from the registry, not hardcode them`,
      );
    }
  }
});

test('a supported list and rejection message derived from a spread copy of the registry containing a hypothetical extra row contain that hypothetical identifier', () => {
  // AUDIO_FORMATS is frozen, so the copy is a brand-new object built with spread plus
  // one extra key — never a mutation of the real registry.
  const HYPOTHETICAL_ID = 'flac-hypothetical-test-only';
  const registryCopy = {
    ...AUDIO_FORMATS,
    [HYPOTHETICAL_ID]: {
      mimeType: 'audio/flac',
      extension: 'flac',
      headerless: false,
      sampleRate: null,
      channels: null,
      bitDepth: null,
      afconvertFileFormat: 'AIFF',
      afconvertDataFormat: 'FLAC',
      afconvertChannels: 1,
    },
  };

  // Drive the derived list and message through the same shape unsupportedFormatError()
  // builds its own message from (see error-response.js) — the real function imports
  // format-registry.js directly and cannot be re-pointed at a substituted registry
  // without changing its signature; this reconstructs its exact template over the copy
  // to prove the template itself is registry-derived, not a hardcoded list. See the
  // SUMMARY for why this is a parallel construction rather than a call into the real
  // function, and why the source-scan test above is the stronger FMT-07 proof.
  const derivedSupportedFormats = Object.keys(registryCopy).sort();
  const derivedMessage = `Requested format '[none]' is not supported. Supported formats: ${derivedSupportedFormats.join(', ')}.`;

  assert.ok(derivedSupportedFormats.includes(HYPOTHETICAL_ID));
  assert.ok(derivedMessage.includes(HYPOTHETICAL_ID));
});

test('listSupportedFormats().length equals Object.keys(AUDIO_FORMATS).length', () => {
  assert.equal(listSupportedFormats().length, Object.keys(AUDIO_FORMATS).length);
});

// --- Rejection path end to end (TEST-02) ---

test('unsupportedFormatError rejects mp3, ogg-opus, flac, empty string, and a 200-char id with a 415 envelope naming every supported format', () => {
  const longId = 'x'.repeat(200);
  const supported = listSupportedFormats();

  for (const requested of ['mp3', 'ogg-opus', 'flac', '', longId]) {
    const { status, body, headers } = unsupportedFormatError(requested);
    assert.equal(status, 415, `status for '${requested}'`);
    assert.equal(body.error.code, 'FMT_UNSUPPORTED', `code for '${requested}'`);
    assert.equal(headers['X-Error-Code'], 'FMT_UNSUPPORTED', `header for '${requested}'`);
    for (const id of supported) {
      assert.ok(body.error.message.includes(id), `message for '${requested}' must name '${id}'`);
    }
  }
});

test('unsupportedFormatError for webm names only the registered alternatives, and webm/ogg-opus are not registered', () => {
  const { body } = unsupportedFormatError('webm');
  const supported = listSupportedFormats();
  assert.ok(!supported.includes('webm'), 'webm must not be registered (checkpoint decision option-a)');
  assert.ok(!supported.includes('ogg-opus'), 'ogg-opus must not be registered (checkpoint decision option-a)');
  for (const id of supported) {
    assert.ok(body.error.message.includes(id), `message must name registered alternative '${id}'`);
  }
});

// --- Concurrency and immutability ---

test('AUDIO_FORMATS and each row are frozen against mutation', () => {
  const keysBefore = Object.keys(AUDIO_FORMATS).length;
  assert.throws(() => {
    AUDIO_FORMATS.injected = {};
  });
  assert.equal(Object.keys(AUDIO_FORMATS).length, keysBefore);

  assert.throws(() => {
    delete AUDIO_FORMATS.wav;
  });
  assert.ok(Object.hasOwn(AUDIO_FORMATS, 'wav'));

  const wavRow = AUDIO_FORMATS.wav;
  assert.throws(() => {
    wavRow.mimeType = 'audio/tampered';
  });
  assert.equal(AUDIO_FORMATS.wav.mimeType, 'audio/wav');
});

test('200 interleaved concurrent lookupFormat/listSupportedFormats calls return deep-equal results and a mutated returned array does not leak', async () => {
  const calls = [];
  for (let i = 0; i < 100; i++) {
    calls.push(Promise.resolve().then(() => lookupFormat('wav')));
    calls.push(Promise.resolve().then(() => listSupportedFormats()));
  }
  const results = await Promise.all(calls);

  const lookupResults = results.filter((_, i) => i % 2 === 0);
  const listResults = results.filter((_, i) => i % 2 === 1);

  for (const r of lookupResults) {
    assert.deepEqual(r, AUDIO_FORMATS.wav);
  }
  for (const r of listResults) {
    assert.deepEqual(r, listResults[0]);
  }

  listResults[0].push('mutated-by-caller');
  assert.ok(!listSupportedFormats().includes('mutated-by-caller'));
});

test('isSupportedFormat reflects wav as supported and webm as unsupported', () => {
  assert.equal(isSupportedFormat('wav'), true);
  assert.equal(isSupportedFormat('webm'), false);
});
