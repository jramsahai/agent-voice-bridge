// Hygiene test for the planning-document references carried in source comments.
//
// This codebase deliberately cites its own planning artifacts from code comments — the note
// that explains why a declaration order is fixed, or why a timeout is derived rather than
// typed, points at the document that settled it. Those citations are load-bearing: they are
// what stops a later reader from re-litigating a decision the code no longer explains on its
// own. They are also the only part of a comment that can rot silently, because nothing else
// in the suite reads them.
//
// Two failure modes, one check each.
//
// (1) A citation written as a repository-relative PATH breaks the moment the planning tree is
//     reorganised. Completed phases get archived into a milestone directory, which moves every
//     file under them; a path-form citation then resolves nowhere while still looking precise.
//     This is not hypothetical — it is exactly how the reference in
//     packages/shared/transport/read-timeout.js came to point at a file that no longer existed.
//     A citation written as a BARE FILENAME survives the same move untouched, because it is
//     found by name rather than by location. So the path form is banned outright.
//
// (2) A bare-filename citation still rots if the document itself is renamed or deleted. Check 2
//     resolves every cited filename against the planning tree and fails on the first one that
//     does not exist. It is skipped when the planning tree is absent, which is the normal state
//     of the filtered public mirror — the mirror strips those directories by design, so an
//     unresolvable citation there is expected rather than a defect.
//
// Both scans walk this file among their inputs, and test/convert.test.js's own recursive scan
// walks it too. Every pattern literal below is therefore assembled by concatenation rather than
// written out, following the convention test/turn-suite-hygiene.test.js established for exactly
// this reason: a scan that reads its own pattern list must not flag itself. For the same reason
// no comment in this file spells out an example citation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Assembled, never written literally — see the header note on self-flagging.
const PLANNING_DIR = ['.', 'planning'].join('');
const AGENT_DIR = ['.', 'claude'].join('');
const FORBIDDEN_PATH_PREFIXES = [`${PLANNING_DIR}/`, `${AGENT_DIR}/`];

// Directories holding first-party JavaScript. Read from disk rather than hardcoded per-file,
// so a module added later is covered without editing this test.
const SCAN_ROOTS = ['apps', 'packages', 'test'];

const DOC_SUFFIXES = ['PLAN', 'UAT', 'SPEC', 'SUMMARY', 'VERIFICATION', 'RESEARCH', 'REVIEW', 'PATTERNS', 'LINEAGE'];
const CITATION_PATTERN = new RegExp(
  ['\\b\\d{2}-[A-Za-z0-9-]*(?:', DOC_SUFFIXES.join('|'), ')\\', '.md\\b'].join(''),
  'g',
);

function collectJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      files.push(...collectJsFiles(fullPath));
    } else if (entry.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function scannedFiles() {
  return SCAN_ROOTS.flatMap((root) => {
    const dir = path.join(repoRoot, root);
    return fs.existsSync(dir) ? collectJsFiles(dir) : [];
  });
}

test('no source comment cites a planning document by repository path', () => {
  const offenders = [];
  for (const file of scannedFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      for (const prefix of FORBIDDEN_PATH_PREFIXES) {
        if (line.includes(prefix)) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        }
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'Path-form citations break when the planning tree is reorganised. Cite the document by ' +
      'bare filename instead, which survives archiving, or point at a document that ships ' +
      `publicly (docs/API.md). Offending lines: ${offenders.join(', ')}`,
  );
});

test('every planning document cited by filename still exists', (t) => {
  const planningRoot = path.join(repoRoot, PLANNING_DIR);
  if (!fs.existsSync(planningRoot)) {
    t.skip('planning tree absent — expected in the filtered public mirror');
    return;
  }

  const present = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      if (fs.statSync(fullPath).isDirectory()) walk(fullPath);
      else present.add(entry);
    }
  };
  walk(planningRoot);

  const cited = new Map();
  for (const file of scannedFiles()) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const match of contents.matchAll(CITATION_PATTERN)) {
      if (!cited.has(match[0])) cited.set(match[0], path.relative(repoRoot, file));
    }
  }

  assert.ok(cited.size > 0, 'citation scan found nothing — the scan itself is broken');

  const dangling = [...cited.entries()]
    .filter(([name]) => !present.has(name))
    .map(([name, file]) => `${name} (cited in ${file})`);

  assert.deepEqual(
    dangling,
    [],
    `Cited planning documents no longer exist: ${dangling.join(', ')}. Either restore the ` +
      'document, update the citation to its new name, or inline the reasoning into the comment.',
  );
});
