// Filesystem-hygiene primitive only: node:fs, node:os and node:path, nothing else. This is
// the extraction of the mkdtemp-plus-guaranteed-finally cleanup contract
// packages/shared/audio/convert.js already documents inline, not a new invention.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    // force: true so a partially-removed directory never turns cleanup into a second
    // failure — every caller of this function relies on the finally never throwing.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
