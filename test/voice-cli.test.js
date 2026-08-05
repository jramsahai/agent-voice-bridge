// This file opens a real loopback socket — it exists to prove the reference CLI client
// (apps/voice-cli/cli.js) completes an actual HTTP turn against a live createRequestHandler
// server, end to end: real http.createServer(), real listen(0), a real client request driven
// through the CLI's own exported functions (never a duplicated local request helper). No
// whisper, no OpenClaw binary, no speech backend, no network beyond the loopback socket this
// file itself opens. Exempted from both offline-scan guards (test/convert.test.js,
// test/turn-suite-hygiene.test.js) via their documented HTTP_SOCKET_EXEMPT_FILES sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createRequestHandler } from '../apps/voice-bridge/request-handler.js';
import { wavToPcm, MAX_PCM_BYTES } from '../packages/shared/audio/wav.js';
import { makePcm16, makeCanonicalWav, makeStereoWav } from './helpers/fixtures.js';
import {
  parseCliArgs,
  assertConformingWav,
  splitTurnBody,
  runCliTurn,
  playReplyPcm,
  readCapabilities,
  main,
  DEFAULT_READ_TIMEOUT_MS,
  TOKEN_ENV_VAR,
  EXIT_CODES,
  MAX_RESPONSE_BYTES,
} from '../apps/voice-cli/cli.js';

function uniqueSessionId(label) {
  return `voice-cli-test-${label}-${randomUUID()}`;
}

function buildTestConfig(securityOverrides = {}) {
  return {
    security: {
      clients: {},
      expectedHost: null,
      allowedOrigins: [],
      rateLimitWindowMs: 15_000,
      rateLimitMaxRequests: 1000,
      ...securityOverrides,
    },
    stt: {},
    openclaw: { sessionId: uniqueSessionId('turn') },
    tts: {},
  };
}

function makeFakeAdapters({ transcript, reply, wavBuffer, onTranscribe }) {
  return {
    transcribe: async (audioPath) => {
      if (onTranscribe) onTranscribe(audioPath);
      return { text: transcript, meta: {} };
    },
    agent: async () => ({ text: reply, rawText: reply, meta: {} }),
    speak: async () => ({ audioBuffer: wavBuffer, mimeType: 'audio/wav', meta: {} }),
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Forces immediate teardown of every connection rather than waiting out Node's default 5s
// keepAliveTimeout — server.close() alone only resolves once every connection has ended.
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-cli-test-'));
}

// Same gate + waitUntil concurrency pattern test/http-turn.test.js uses to force two
// overlapping turns — forces the fake transcribe adapter's promise open until released, so a
// second turn can be driven while the first is provably still in flight.
function makeGate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitUntil(predicate, { timeoutMs = 5000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: timed out waiting for predicate');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Mirrors test/turn-log.test.js's own console-capture convention: monkeypatch console.log
// and console.error for the duration of fn(), then restore, so a test can assert on exactly
// what the CLI printed without spawning a child process.
async function captureConsole(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout = [];
  const stderr = [];
  console.log = (line) => stdout.push(String(line));
  console.error = (line) => stderr.push(String(line));
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function withEnvToken(value, fn) {
  const original = process.env[TOKEN_ENV_VAR];
  if (value === undefined) {
    delete process.env[TOKEN_ENV_VAR];
  } else {
    process.env[TOKEN_ENV_VAR] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (original === undefined) {
        delete process.env[TOKEN_ENV_VAR];
      } else {
        process.env[TOKEN_ENV_VAR] = original;
      }
    });
}

// =====================================================================================
// splitTurnBody — pure framing, driven directly since the live success response never sets
// a body-length header.
// =====================================================================================

test('splitTurnBody splits transcript/reply/audio using only the X-Voice-* framing headers, never a body-length header', () => {
  const transcript = 'hello there';
  const reply = 'general kenobi';
  const audio = Buffer.from([1, 2, 3, 4, 5]);
  const body = Buffer.concat([Buffer.from(transcript, 'utf8'), Buffer.from(reply, 'utf8'), audio]);
  const headers = {
    'x-voice-transcript-bytes': String(Buffer.byteLength(transcript, 'utf8')),
    'x-voice-reply-bytes': String(Buffer.byteLength(reply, 'utf8')),
    'x-voice-audio-present': '1',
  };

  const result = splitTurnBody(headers, body);
  assert.equal(result.transcript, transcript);
  assert.equal(result.reply, reply);
  assert.deepEqual(result.audioPcm, audio);
  assert.ok(!('content-length' in headers), 'sanity: this headers object carries no body-length header');
});

test('splitTurnBody returns a null audioPcm when x-voice-audio-present is not the string 1', () => {
  const transcript = 'hi';
  const reply = 'ok';
  const body = Buffer.concat([Buffer.from(transcript, 'utf8'), Buffer.from(reply, 'utf8')]);
  const headers = {
    'x-voice-transcript-bytes': String(Buffer.byteLength(transcript, 'utf8')),
    'x-voice-reply-bytes': String(Buffer.byteLength(reply, 'utf8')),
    'x-voice-audio-present': '0',
  };
  const result = splitTurnBody(headers, body);
  assert.equal(result.audioPcm, null);
});

// =====================================================================================
// CR-01: splitTurnBody must refuse a self-inconsistent framing declaration rather than let
// Buffer.prototype.subarray clamp an out-of-range end index into a silent mis-split.
// =====================================================================================

test('splitTurnBody refuses a response whose declared framing bytes exceed the received body length rather than silently clamping the split', () => {
  const headers = {
    'x-voice-transcript-bytes': '9999',
    'x-voice-reply-bytes': '0',
    'x-voice-audio-present': '0',
  };
  assert.throws(
    () => splitTurnBody(headers, Buffer.alloc(100)),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VIOLATION');
      assert.match(error.message, /9999/);
      assert.match(error.message, /100/);
      return true;
    },
  );
});

test('splitTurnBody accepts a body whose declared text bytes exactly equal its length, and accepts an all-zero declaration over an empty body', () => {
  const transcript = 'exact boundary';
  const reply = 'no audio here';
  const body = Buffer.concat([Buffer.from(transcript, 'utf8'), Buffer.from(reply, 'utf8')]);
  const headers = {
    'x-voice-transcript-bytes': String(Buffer.byteLength(transcript, 'utf8')),
    'x-voice-reply-bytes': String(Buffer.byteLength(reply, 'utf8')),
    'x-voice-audio-present': '0',
  };
  const result = splitTurnBody(headers, body);
  assert.equal(result.transcript, transcript);
  assert.equal(result.reply, reply);
  assert.equal(result.audioPcm, null);

  const zeroHeaders = {
    'x-voice-transcript-bytes': '0',
    'x-voice-reply-bytes': '0',
    'x-voice-audio-present': '0',
  };
  const zeroResult = splitTurnBody(zeroHeaders, Buffer.alloc(0));
  assert.equal(zeroResult.transcript, '');
  assert.equal(zeroResult.reply, '');
  assert.equal(zeroResult.audioPcm, null);
});

test('splitTurnBody refuses an absent, non-numeric, or negative framing byte count', () => {
  const body = Buffer.from('hello world', 'utf8');
  const baseHeaders = { 'x-voice-reply-bytes': '0', 'x-voice-audio-present': '0' };

  assert.throws(
    () => splitTurnBody({ ...baseHeaders }, body),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VIOLATION');
      return true;
    },
    'an absent x-voice-transcript-bytes header must be refused',
  );

  assert.throws(
    () => splitTurnBody({ ...baseHeaders, 'x-voice-transcript-bytes': 'not-a-number' }, body),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VIOLATION');
      return true;
    },
    'a non-numeric x-voice-transcript-bytes header must be refused',
  );

  assert.throws(
    () => splitTurnBody({ ...baseHeaders, 'x-voice-transcript-bytes': '-5' }, body),
    (error) => {
      assert.equal(error.code, 'CONTRACT_VIOLATION');
      return true;
    },
    'a negative x-voice-transcript-bytes header must be refused',
  );
});

// =====================================================================================
// assertConformingWav
// =====================================================================================

test('assertConformingWav throws a tagged INPUT_INVALID error naming the actual shape for a non-conforming WAV', () => {
  const wav = makeStereoWav({ pcm: makePcm16({ samples: 4410 }), sampleRate: 44100 });
  assert.throws(
    () => assertConformingWav(wav),
    (error) => {
      assert.equal(error.code, 'INPUT_INVALID');
      assert.match(error.message, /44100/);
      assert.match(error.message, /2 channel/);
      return true;
    },
  );
});

test('assertConformingWav returns the format for a conforming 16kHz mono 16-bit WAV', () => {
  const wav = makeCanonicalWav({ pcm: makePcm16({ samples: 1600 }) });
  const format = assertConformingWav(wav);
  assert.deepEqual(format, { sampleRate: 16000, channels: 1, bitDepth: 16 });
});

// =====================================================================================
// parseCliArgs — token sourcing precedence
// =====================================================================================

test('parseCliArgs resolves the token from the environment variable when no --token flag is given', async () => {
  await withEnvToken('env-token-value', () => {
    const parsed = parseCliArgs(['--input', 'x.wav']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.values.token, 'env-token-value');
  });
});

test('parseCliArgs lets the --token flag win when both the flag and the environment variable are present', async () => {
  await withEnvToken('env-token-value', () => {
    const parsed = parseCliArgs(['--input', 'x.wav', '--token', 'flag-token-value']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.values.token, 'flag-token-value');
  });
});

test('parseCliArgs never reads the operator config loader or config.local — reflected in required source-scan', () => {
  const source = fs.readFileSync(new URL('../apps/voice-cli/cli.js', import.meta.url), 'utf8');
  assert.ok(!/load-config|config\.local/.test(source));
});

// =====================================================================================
// main() — usage/help exit codes
// =====================================================================================

test('main() exits with the usage code and prints a usage line when --input is missing', async () => {
  await withEnvToken('some-token', async () => {
    const { result, stderr } = await captureConsole(() => main([]));
    assert.equal(result, EXIT_CODES.USAGE);
    assert.ok(stderr.length > 0);
  });
});

test('main() exits with the usage code when no token is available from either source', async () => {
  await withEnvToken(undefined, async () => {
    const { result } = await captureConsole(() => main(['--input', 'somefile.wav']));
    assert.equal(result, EXIT_CODES.USAGE);
  });
});

test('main() redacts a --token flag value from its usage-rejection output even on an argv shape parseCliArgs rejects outright', async () => {
  const distinctiveToken = 'DISTINCTIVE-USAGE-PATH-TOKEN-99887766';
  const { result, stderr } = await captureConsole(() =>
    main(['--input', 'x.wav', '--token', distinctiveToken, '--bogus-flag']),
  );
  assert.equal(result, EXIT_CODES.USAGE);
  assert.ok(!stderr.join('\n').includes(distinctiveToken));
});

test('main() --help exits OK and its output names the environment variable', async () => {
  const { result, stdout } = await captureConsole(() => main(['--help']));
  assert.equal(result, EXIT_CODES.OK);
  const combined = stdout.join('\n');
  assert.ok(combined.includes(TOKEN_ENV_VAR));
});

// =====================================================================================
// Real-socket integration: a full CLI turn against a live fake-adapter server.
// =====================================================================================

test('a full CLI turn against a real fake-adapter server returns the fake transcript and reply, and the reply PCM round-trips byte-for-byte', async () => {
  const fakeTranscript = 'what is the weather today';
  const fakeReply = 'it is sunny and seventy two degrees';
  const clientToken = 'cli-test-token-full-turn';
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 4000 }) });
  const fixtureWav = makeCanonicalWav({ pcm: makePcm16({ samples: 8000 }) });

  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const adapters = makeFakeAdapters({ transcript: fakeTranscript, reply: fakeReply, wavBuffer: replyWav });
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = path.join(tmpDir, 'input.wav');
  fs.writeFileSync(inputPath, fixtureWav);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result, stdout } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: clientToken, inputPath, outPath }),
    );

    assert.equal(result, EXIT_CODES.OK);
    assert.ok(stdout.some((line) => line.includes(fakeTranscript)));
    assert.ok(stdout.some((line) => line.includes(fakeReply)));
    assert.deepEqual(fs.readFileSync(outPath), wavToPcm(replyWav));
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('the request body received server-side is byte-identical to wavToPcm(fixtureWav), no RIFF preamble on the wire', async () => {
  const clientToken = 'cli-test-token-body-check';
  const fixtureWav = makeCanonicalWav({ pcm: makePcm16({ samples: 6000 }) });
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) });

  let capturedWavBuffer = null;
  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const adapters = makeFakeAdapters({
    transcript: 'hi',
    reply: 'ok',
    wavBuffer: replyWav,
    // Read synchronously inside the adapter call, before the pipeline's own withTempDir
    // cleanup runs — the file would be gone by the time runCliTurn resolves.
    onTranscribe: (audioPath) => {
      capturedWavBuffer = fs.readFileSync(audioPath);
    },
  });
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = path.join(tmpDir, 'input.wav');
  fs.writeFileSync(inputPath, fixtureWav);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: clientToken, inputPath, outPath }),
    );
    assert.equal(result, EXIT_CODES.OK);
    assert.ok(capturedWavBuffer, 'sanity: the fake transcribe adapter must have been invoked');
    // The server wraps the raw pcm16-declared body in a fresh canonical WAV header
    // (prepareTranscriptionInput -> pcmToWav) before handing it to transcribe — stripping
    // that header back off must yield exactly the same PCM bytes the CLI sent, proving no
    // RIFF preamble and no resampling happened anywhere on the wire.
    assert.deepEqual(wavToPcm(capturedWavBuffer), wavToPcm(fixtureWav));
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a stereo 44100 Hz input file is rejected before any request reaches the server, exiting with the input-invalid code', async () => {
  const clientToken = 'cli-test-token-nonconforming';
  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const adapters = makeFakeAdapters({ transcript: 'unused', reply: 'unused', wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }) });

  let requestCount = 0;
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const countingHandler = (req, res) => {
    requestCount += 1;
    return handler(req, res);
  };
  const server = await startServer(countingHandler);
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = path.join(tmpDir, 'stereo.wav');
  fs.writeFileSync(inputPath, makeStereoWav({ pcm: makePcm16({ samples: 4410 }), sampleRate: 44100 }));
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: clientToken, inputPath, outPath }),
    );
    assert.equal(result, EXIT_CODES.INPUT_INVALID);
    assert.equal(requestCount, 0, 'the server must never see a request for a non-conforming input file');
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =====================================================================================
// Token redaction — no diagnostic path ever prints the bearer token value.
// =====================================================================================

test('no CLI output path ever prints the bearer token value, on a successful turn or a 401 rejection', async () => {
  const distinctiveToken = 'DISTINCTIVE-TOKEN-VALUE-xyz789ABC';
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) });
  const adapters = makeFakeAdapters({ transcript: 'hi', reply: 'ok', wavBuffer: replyWav });

  const tmpDir = makeTmpDir();
  const inputPath = path.join(tmpDir, 'input.wav');
  fs.writeFileSync(inputPath, makeCanonicalWav({ pcm: makePcm16({ samples: 8000 }) }));
  const outPath = path.join(tmpDir, 'reply.pcm');

  // Success path: the distinctive token IS the configured client's own token.
  const acceptingConfig = buildTestConfig({ clients: { cliClient: distinctiveToken } });
  const acceptingHandler = createRequestHandler({ config: acceptingConfig, adapters, webDir: process.cwd() });
  const acceptingServer = await startServer(acceptingHandler);
  const acceptingPort = acceptingServer.address().port;

  // 401 path: the distinctive token is sent, but the server only accepts a different one.
  const rejectingConfig = buildTestConfig({ clients: { cliClient: 'some-other-real-token' } });
  const rejectingHandler = createRequestHandler({ config: rejectingConfig, adapters, webDir: process.cwd() });
  const rejectingServer = await startServer(rejectingHandler);
  const rejectingPort = rejectingServer.address().port;

  try {
    const success = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port: acceptingPort, token: distinctiveToken, inputPath, outPath }),
    );
    assert.equal(success.result, EXIT_CODES.OK);
    const successCombined = [...success.stdout, ...success.stderr].join('\n');
    assert.ok(!successCombined.includes(distinctiveToken));

    const rejected = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port: rejectingPort, token: distinctiveToken, inputPath, outPath }),
    );
    assert.equal(rejected.result, EXIT_CODES.HTTP_ERROR);
    const rejectedCombined = [...rejected.stdout, ...rejected.stderr].join('\n');
    assert.ok(!rejectedCombined.includes(distinctiveToken));
  } finally {
    await closeServer(acceptingServer);
    await closeServer(rejectingServer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Sanity: the module never references node:http timeout constants outside DEFAULT_READ_TIMEOUT_MS
// itself, i.e. the exported constant is the same value Pattern 1 in 05-RESEARCH.md locks in.
test('DEFAULT_READ_TIMEOUT_MS is the locked 30 second default', () => {
  assert.equal(DEFAULT_READ_TIMEOUT_MS, 30000);
});

// =====================================================================================
// CLI-02: embedded-client transport posture, proven against a bare http.createServer stub
// deliberately violating each constraint — a permissive client passes against a broken
// contract, so every assertion below is on the client's refusal, never its tolerance.
// =====================================================================================

function waitForSocketClose(socket, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.destroyed) return resolve();
    const timer = setTimeout(() => reject(new Error('waitForSocketClose: timed out')), timeoutMs);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function makeConformingInput(tmpDir) {
  const inputPath = path.join(tmpDir, 'input.wav');
  fs.writeFileSync(inputPath, makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }));
  return inputPath;
}

// A controllable stand-in for a real player binary — array-form execFile invokes it as
// `playerBin <wavPath>`, so a `/bin/sh` script that records or copies its own `$1` is enough
// to observe exactly what playReplyPcm handed it, without ever producing sound and without the
// racy shared-os.tmpdir()-listing-diff pattern test/turn-suite-hygiene.test.js's own regression
// guard forbids (05-02's own precedent: capture a deterministic handle on the thing under test
// instead of diffing a shared resource every concurrently-running test file also touches).
function makeFakePlayerScript(dir, { recordInvokedPathTo, copyReceivedFileTo, exitCode = 0 } = {}) {
  const scriptPath = path.join(dir, 'fake-player.sh');
  const lines = ['#!/bin/sh'];
  if (recordInvokedPathTo) {
    lines.push(`echo "$1" > "${recordInvokedPathTo}"`);
  }
  if (copyReceivedFileTo) {
    lines.push(`cp "$1" "${copyReceivedFileTo}"`);
  }
  lines.push(`exit ${exitCode}`);
  fs.writeFileSync(scriptPath, lines.join('\n') + '\n');
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test('a server that accepts the connection and never responds causes the CLI to fail with a timeout, not hang until a server-side ceiling', async () => {
  let serverSocket = null;
  const server = http.createServer(() => {
    // Deliberately writes nothing and never ends the response — a hung backend.
  });
  server.on('connection', (socket) => {
    serverSocket = socket;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');
  const timeoutMs = 200;

  try {
    const start = Date.now();
    const { result, stderr } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath, timeoutMs }),
    );
    const elapsed = Date.now() - start;

    assert.equal(result, EXIT_CODES.TIMEOUT);
    assert.ok(stderr.some((line) => /timeout/i.test(line)));
    // Well under the server-side adapter ceiling sum (420,000ms) — proves the client aborted
    // on its own inactivity window rather than waiting out the pipeline.
    assert.ok(elapsed < 5000, `expected a client-side abort well under the adapter ceilings, took ${elapsed}ms`);
    await waitForSocketClose(serverSocket);
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('the inactivity timeout resets on every received byte — a slow but steadily-arriving response is not killed', async () => {
  const transcript = 'hello there friend';
  const reply = 'this reply arrives in several slow chunks spread out over the whole window';
  const transcriptBuf = Buffer.from(transcript, 'utf8');
  const replyBuf = Buffer.from(reply, 'utf8');
  const bodyBuf = Buffer.concat([transcriptBuf, replyBuf]);
  const timeoutMs = 300;

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, {
        'x-voice-transcript-bytes': String(transcriptBuf.length),
        'x-voice-reply-bytes': String(replyBuf.length),
        'x-voice-audio-present': '0',
      });
      const sliceCount = 4;
      const sliceSize = Math.ceil(bodyBuf.length / sliceCount);
      for (let offset = 0; offset < bodyBuf.length; offset += sliceSize) {
        // Each gap is well under the inactivity window; the sum of gaps is well over it —
        // only a total-duration cap (which this must not be) would kill this turn.
        await new Promise((resolve) => setTimeout(resolve, timeoutMs / 2));
        res.write(bodyBuf.subarray(offset, offset + sliceSize));
      }
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result, stdout } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath, timeoutMs }),
    );
    assert.equal(result, EXIT_CODES.OK);
    assert.ok(stdout.some((line) => line.includes(transcript)));
    assert.ok(stdout.some((line) => line.includes(reply)));
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a 3xx response carrying a Location header is a contract violation, and the CLI issues no second request to the redirect target', async () => {
  let redirectTargetRequestCount = 0;
  const targetServer = http.createServer((req, res) => {
    redirectTargetRequestCount += 1;
    res.writeHead(200, {});
    res.end();
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const targetPort = targetServer.address().port;

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result, stderr } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath }),
    );
    assert.equal(result, EXIT_CODES.CONTRACT_VIOLATION);
    assert.ok(stderr.some((line) => /redirect/i.test(line)));
    // Give any errant follow-up request a moment to land before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(redirectTargetRequestCount, 0, 'the CLI must never issue a second request to the redirect target');
  } finally {
    await closeServer(server);
    await closeServer(targetServer);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a response carrying a content-encoding header is a contract violation, not a silent decompression, and the request sent accept-encoding: identity', async () => {
  let receivedAcceptEncoding = null;
  const transcript = 'hi';
  const reply = 'ok';
  const bodyBuf = Buffer.concat([Buffer.from(transcript, 'utf8'), Buffer.from(reply, 'utf8')]);

  const server = http.createServer((req, res) => {
    receivedAcceptEncoding = req.headers['accept-encoding'];
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-encoding': 'gzip',
        'x-voice-transcript-bytes': String(Buffer.byteLength(transcript, 'utf8')),
        'x-voice-reply-bytes': String(Buffer.byteLength(reply, 'utf8')),
        'x-voice-audio-present': '0',
      });
      res.end(bodyBuf);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result, stderr } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath }),
    );
    assert.equal(result, EXIT_CODES.CONTRACT_VIOLATION);
    assert.ok(stderr.some((line) => /gzip/i.test(line)));
    assert.equal(receivedAcceptEncoding, 'identity');
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a truncated turn response whose framing headers over-declare exits with the contract-violation code and prints no transcript', async () => {
  const transcript = 'this transcript never fully arrives';
  const reply = 'nor does this reply';
  const bodyBuf = Buffer.concat([Buffer.from(transcript, 'utf8'), Buffer.from(reply, 'utf8')]);
  // The framing headers declare far more bytes than the server actually sends — a truncated
  // or tampered response, the exact scenario CR-01 exists to catch.
  const declaredTranscriptBytes = Buffer.byteLength(transcript, 'utf8') + 5000;

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'x-voice-transcript-bytes': String(declaredTranscriptBytes),
        'x-voice-reply-bytes': String(Buffer.byteLength(reply, 'utf8')),
        'x-voice-audio-present': '0',
      });
      res.end(bodyBuf);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result, stdout, stderr } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath }),
    );
    assert.equal(result, EXIT_CODES.CONTRACT_VIOLATION);
    assert.ok(stderr.some((line) => /declare/i.test(line)), 'stderr must name the mismatch');
    assert.ok(
      !stdout.some((line) => line.startsWith('transcript:')),
      'the silent-mis-split symptom must be provably absent: no transcript line may be printed',
    );
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a set-cookie response header is never stored and never echoed on a subsequent request', async () => {
  let firstRequestServed = false;
  let secondRequestHeaders = null;
  const transcript = 'hi';
  const reply = 'ok';
  const bodyBuf = Buffer.concat([Buffer.from(transcript, 'utf8'), Buffer.from(reply, 'utf8')]);
  const framingHeaders = {
    'x-voice-transcript-bytes': String(Buffer.byteLength(transcript, 'utf8')),
    'x-voice-reply-bytes': String(Buffer.byteLength(reply, 'utf8')),
    'x-voice-audio-present': '0',
  };

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (!firstRequestServed) {
        firstRequestServed = true;
        res.writeHead(200, { ...framingHeaders, 'set-cookie': 'sessionid=abc123; Path=/' });
        res.end(bodyBuf);
      } else {
        secondRequestHeaders = req.headers;
        res.writeHead(200, framingHeaders);
        res.end(bodyBuf);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const first = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath }),
    );
    assert.equal(first.result, EXIT_CODES.OK);

    const second = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath }),
    );
    assert.equal(second.result, EXIT_CODES.OK);
    assert.ok(secondRequestHeaders, 'sanity: the second request must have reached the server');
    const hasCookieHeader = Object.keys(secondRequestHeaders).some((key) => key.toLowerCase().includes('cookie'));
    assert.equal(hasCookieHeader, false, 'the second request must carry no cookie header of any kind');
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a chunked success response with no declared body-length header is consumed to the stream end and split correctly by the X-Voice-* byte counts', async () => {
  const transcript = 'what time is it';
  const reply = 'it is three in the afternoon and sunny';
  const audio = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const transcriptBuf = Buffer.from(transcript, 'utf8');
  const replyBuf = Buffer.from(reply, 'utf8');
  const bodyBuf = Buffer.concat([transcriptBuf, replyBuf, audio]);

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'x-voice-transcript-bytes': String(transcriptBuf.length),
        'x-voice-reply-bytes': String(replyBuf.length),
        'x-voice-audio-present': '1',
      });
      const third = Math.ceil(bodyBuf.length / 3);
      res.write(bodyBuf.subarray(0, third));
      res.write(bodyBuf.subarray(third, third * 2));
      res.write(bodyBuf.subarray(third * 2));
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result, stdout } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath }),
    );
    assert.equal(result, EXIT_CODES.OK);
    assert.ok(stdout.some((line) => line.includes(transcript)));
    assert.ok(stdout.some((line) => line.includes(reply)));
    assert.deepEqual(fs.readFileSync(outPath), audio);
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Deliberately does not diff the shared, process-wide os.tmpdir() listing — that pattern is
// racy the moment more than one test file drives real runTurn() calls concurrently under
// `node --test`'s parallel file execution (test/turn-suite-hygiene.test.js's own regression
// guard forbids reintroducing it). Instead this test captures the in-flight turn's own
// pipeline temp directory straight from the transcribe adapter's recorded audioPath — a
// deterministic, non-racy handle on exactly this turn's own directory, not the shared
// resource every other concurrently-running test file also touches.
test('two CLI turns started in parallel against one service yield exactly one success and one busy exit, with no leaked pipeline temp directory', async () => {
  const gate = makeGate();
  const clientToken = 'cli-test-token-parallel';
  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) });
  let transcribeCallCount = 0;
  const capturedTempDirs = [];
  const adapters = {
    transcribe: async (audioPath) => {
      transcribeCallCount += 1;
      capturedTempDirs.push(path.dirname(audioPath));
      if (transcribeCallCount === 1) {
        await gate.promise;
      }
      return { text: 'hi', meta: {} };
    },
    agent: async () => ({ text: 'ok', rawText: 'ok', meta: {} }),
    speak: async () => ({ audioBuffer: replyWav, mimeType: 'audio/wav', meta: {} }),
  };
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath1 = path.join(tmpDir, 'reply1.pcm');
  const outPath2 = path.join(tmpDir, 'reply2.pcm');

  try {
    const firstPromise = captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: clientToken, inputPath, outPath: outPath1 }),
    );
    await waitUntil(() => transcribeCallCount === 1);

    const firstTurnTempDir = capturedTempDirs[0];
    assert.ok(fs.existsSync(firstTurnTempDir), "sanity: the in-flight turn's own temp dir must exist while it is gated open");

    const second = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: clientToken, inputPath, outPath: outPath2 }),
    );
    assert.equal(second.result, EXIT_CODES.BUSY, 'the second, concurrent turn must be refused with the busy exit code');
    // runTurn() acquires the lock before its first await (a locked Phase 2 ordering guarantee
    // this repo's own regression tests enforce) — the busy-refused turn is rejected before the
    // pipeline ever creates a temp dir for it, so the transcribe adapter above is never
    // invoked a second time and no second directory is ever created to leak.
    assert.equal(transcribeCallCount, 1, 'the busy-refused turn must never reach the transcribe adapter');

    gate.release();
    const first = await firstPromise;
    assert.equal(first.result, EXIT_CODES.OK, 'the first turn must still succeed once the gate releases');

    assert.equal(fs.existsSync(firstTurnTempDir), false, "the first turn's own pipeline temp dir must be removed once it completes");
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =====================================================================================
// playReplyPcm — local WAV wrapping and degradable playback (05-03, Task 1). Every test here
// drives an injectable player binary; none spawns a real audio player or produces sound.
// =====================================================================================

test('playReplyPcm wraps the raw PCM in a WAV file it built itself, hands it to the player, and removes the temp dir once playback resolves', async () => {
  const tmpDir = makeTmpDir();
  const recordInvokedPathTo = path.join(tmpDir, 'invoked-with.txt');
  const copyReceivedFileTo = path.join(tmpDir, 'received.wav');
  const playerBin = makeFakePlayerScript(tmpDir, { recordInvokedPathTo, copyReceivedFileTo });
  const pcm = makePcm16({ samples: 1600 });

  try {
    const result = await playReplyPcm(pcm, { playerBin });
    assert.equal(result.played, true);

    const invokedWith = fs.readFileSync(recordInvokedPathTo, 'utf8').trim();
    assert.ok(
      invokedWith.includes('voice-cli-playback-'),
      'the player must receive a path inside the withTempDir-created playback directory',
    );
    assert.equal(
      fs.existsSync(path.dirname(invokedWith)),
      false,
      'the temporary playback directory must be removed once playback resolves',
    );

    const receivedWav = fs.readFileSync(copyReceivedFileTo);
    assert.deepEqual(
      wavToPcm(receivedWav),
      pcm,
      'the WAV handed to the player must round-trip back to the exact same raw PCM bytes',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('playReplyPcm degrades rather than throws when the player binary does not exist', async () => {
  const tmpDir = makeTmpDir();
  const missingPlayerBin = path.join(tmpDir, 'does-not-exist-binary');
  const pcm = makePcm16({ samples: 1600 });

  try {
    const result = await playReplyPcm(pcm, { playerBin: missingPlayerBin });
    assert.equal(result.played, false);
    assert.ok(result.error, 'a failed playback must report the failure as data, not throw');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('playReplyPcm with enabled: false spawns nothing and touches no temporary directory', async () => {
  const tmpDir = makeTmpDir();
  const recordInvokedPathTo = path.join(tmpDir, 'invoked-with.txt');
  const playerBin = makeFakePlayerScript(tmpDir, { recordInvokedPathTo });
  const pcm = makePcm16({ samples: 1600 });

  try {
    const result = await playReplyPcm(pcm, { playerBin, enabled: false });
    assert.equal(result.played, false);
    assert.equal(result.skipped, true);
    assert.equal(fs.existsSync(recordInvokedPathTo), false, 'a disabled playback must never invoke the player binary');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// =====================================================================================
// runCliTurn wired to playback — a real fake-adapter server, real HTTP round trip, playback
// only ever exercised through the injectable playerBin, never a real player.
// =====================================================================================

test('a full CLI turn with audio plays through an injectable player binary and writes --out bytes identical to wavToPcm(fakeSpeakWavBuffer)', async () => {
  const clientToken = 'cli-test-token-playback-success';
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 4000 }) });
  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const adapters = makeFakeAdapters({ transcript: 'what is the weather', reply: 'sunny and warm', wavBuffer: replyWav });
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');
  const recordInvokedPathTo = path.join(tmpDir, 'invoked-with.txt');
  const playerBin = makeFakePlayerScript(tmpDir, { recordInvokedPathTo });

  try {
    const { result } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: clientToken, inputPath, outPath, playerBin }),
    );
    assert.equal(result, EXIT_CODES.OK);
    assert.deepEqual(fs.readFileSync(outPath), wavToPcm(replyWav));
    assert.ok(fs.existsSync(recordInvokedPathTo), 'the injectable player binary must have been invoked');

    const invokedWith = fs.readFileSync(recordInvokedPathTo, 'utf8').trim();
    assert.equal(
      fs.existsSync(path.dirname(invokedWith)),
      false,
      'the playback temp dir must be gone once the turn completes',
    );
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a turn whose player binary does not exist still exits 0, prints the saved reply-audio path, and warns about the failed playback', async () => {
  const clientToken = 'cli-test-token-playback-missing-binary';
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 4000 }) });
  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const adapters = makeFakeAdapters({ transcript: 'what is the weather', reply: 'sunny and warm', wavBuffer: replyWav });
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');
  const missingPlayerBin = path.join(tmpDir, 'does-not-exist-binary');

  try {
    const { result, stdout, stderr } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: clientToken, inputPath, outPath, playerBin: missingPlayerBin }),
    );
    assert.equal(result, EXIT_CODES.OK);
    assert.ok(stdout.some((line) => line.includes(outPath)), 'stdout must contain the saved reply-audio path');
    assert.ok(stderr.some((line) => /playback failed/i.test(line)), 'a warning line naming the failed playback must be printed');
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--no-play spawns no player process at all and only writes the reply audio to disk', async () => {
  const clientToken = 'cli-test-token-no-play';
  const replyWav = makeCanonicalWav({ pcm: makePcm16({ samples: 4000 }) });
  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const adapters = makeFakeAdapters({ transcript: 'what is the weather', reply: 'sunny and warm', wavBuffer: replyWav });
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');
  const recordInvokedPathTo = path.join(tmpDir, 'invoked-with.txt');
  const playerBin = makeFakePlayerScript(tmpDir, { recordInvokedPathTo });

  try {
    const { result } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: clientToken, inputPath, outPath, playerBin, noPlay: true }),
    );
    assert.equal(result, EXIT_CODES.OK);
    assert.deepEqual(fs.readFileSync(outPath), wavToPcm(replyWav));
    assert.equal(fs.existsSync(recordInvokedPathTo), false, '--no-play must never invoke the player binary');
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseCliArgs sets noPlay true when --no-play is given', async () => {
  await withEnvToken('some-token', () => {
    const parsed = parseCliArgs(['--input', 'x.wav', '--no-play']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.values.noPlay, true);
  });
});

// =====================================================================================
// readCapabilities / --capabilities — line-based discovery, no JSON parser anywhere
// (05-03, Task 2).
// =====================================================================================

test('parseCliArgs sets capabilities true and does not require --input in that mode', async () => {
  await withEnvToken('some-token', () => {
    const parsed = parseCliArgs(['--capabilities']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.values.capabilities, true);
  });
});

test('readCapabilities returns a Map with the expected capability keys against a real server', async () => {
  const clientToken = 'cli-test-token-capabilities';
  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const adapters = makeFakeAdapters({
    transcript: 'unused',
    reply: 'unused',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  try {
    const capabilities = await readCapabilities({ host: '127.0.0.1', port, token: clientToken });
    assert.ok(capabilities instanceof Map);
    for (const key of ['api-version', 'input-formats', 'reply-formats', 'max-audio-bytes']) {
      assert.ok(capabilities.has(key), `capabilities must include the '${key}' key`);
    }
    assert.ok(
      capabilities.get('reply-formats').split(',').includes('pcm16'),
      'reply-formats must include the default headerless format id',
    );
  } finally {
    await closeServer(server);
  }
});

test("a line whose value itself contains ': ' splits on the first separator only, preserving the remainder verbatim", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = 'weird-key: value: with: colons\nother-key: plain\n';
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const capabilities = await readCapabilities({ host: '127.0.0.1', port, token: 'unused' });
    assert.equal(capabilities.get('weird-key'), 'value: with: colons');
    assert.equal(capabilities.get('other-key'), 'plain');
  } finally {
    await closeServer(server);
  }
});

test('an unauthenticated capabilities probe exits with the HTTP-error code and prints the error code from the line body', async () => {
  const config = buildTestConfig({ clients: { cliClient: 'the-real-token' } });
  const adapters = makeFakeAdapters({
    transcript: 'unused',
    reply: 'unused',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  try {
    const { result, stderr } = await captureConsole(() =>
      main(['--capabilities', '--host', '127.0.0.1', '--port', String(port), '--token', 'wrong-token']),
    );
    assert.equal(result, EXIT_CODES.HTTP_ERROR);
    assert.ok(stderr.some((line) => /UNAUTHORIZED/.test(line)));
  } finally {
    await closeServer(server);
  }
});

test('main() --capabilities prints each capability pair as key: value and exits 0 without requiring --input', async () => {
  const clientToken = 'cli-test-token-capabilities-main';
  const config = buildTestConfig({ clients: { cliClient: clientToken } });
  const adapters = makeFakeAdapters({
    transcript: 'unused',
    reply: 'unused',
    wavBuffer: makeCanonicalWav({ pcm: makePcm16({ samples: 10 }) }),
  });
  const handler = createRequestHandler({ config, adapters, webDir: process.cwd() });
  const server = await startServer(handler);
  const port = server.address().port;

  try {
    const { result, stdout } = await captureConsole(() =>
      main(['--capabilities', '--host', '127.0.0.1', '--port', String(port), '--token', clientToken]),
    );
    assert.equal(result, EXIT_CODES.OK);
    assert.ok(stdout.some((line) => line.startsWith('api-version: ')));
  } finally {
    await closeServer(server);
  }
});

test('the CLI source contains no JSON.parse call anywhere', () => {
  const source = fs.readFileSync(new URL('../apps/voice-cli/cli.js', import.meta.url), 'utf8');
  assert.ok(!/JSON\.parse/.test(source));
});

// =====================================================================================
// CR-02: a self-imposed response ceiling on both CLI HTTP call sites — a misbehaving
// backend or proxy sending an oversized or endlessly-streaming body must be refused, not
// buffered without bound.
// =====================================================================================

// Streams one-mebibyte chunks at `res` in a loop until the response's own 'close' event
// fires (the client destroyed the request once it breached the ceiling) — never runs
// unbounded itself, and never depends on the client ever calling res.end() on its side.
function streamPastCeiling(res) {
  let stopped = false;
  res.on('close', () => {
    stopped = true;
  });
  const chunk = Buffer.alloc(1024 * 1024, 1);
  const writeLoop = () => {
    if (stopped) return;
    res.write(chunk, () => {
      if (!stopped) setImmediate(writeLoop);
    });
  };
  writeLoop();
}

test('MAX_RESPONSE_BYTES is derived from the shared MAX_PCM_BYTES cap with headroom for the text segments', () => {
  assert.ok(MAX_RESPONSE_BYTES > MAX_PCM_BYTES, 'MAX_RESPONSE_BYTES must be strictly greater than MAX_PCM_BYTES');
  assert.equal(MAX_RESPONSE_BYTES, MAX_PCM_BYTES + 1024 * 1024);
});

test('postTurn refuses a response that streams past the response ceiling instead of buffering it', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'x-voice-transcript-bytes': '0',
        'x-voice-reply-bytes': '0',
        'x-voice-audio-present': '0',
      });
      streamPastCeiling(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const tmpDir = makeTmpDir();
  const inputPath = makeConformingInput(tmpDir);
  const outPath = path.join(tmpDir, 'reply.pcm');

  try {
    const { result, stderr } = await captureConsole(() =>
      runCliTurn({ host: '127.0.0.1', port, token: 'unused', inputPath, outPath }),
    );
    assert.equal(result, EXIT_CODES.CONTRACT_VIOLATION);
    assert.ok(
      stderr.some((line) => line.includes(String(MAX_RESPONSE_BYTES))),
      'stderr must name the ceiling that was exceeded',
    );
  } finally {
    await closeServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readCapabilities refuses a capabilities response that streams past the response ceiling', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {});
      streamPastCeiling(res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    await assert.rejects(
      () => readCapabilities({ host: '127.0.0.1', port, token: 'unused' }),
      (error) => {
        assert.equal(error.code, 'CONTRACT_VIOLATION');
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});
