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
import { wavToPcm } from '../packages/shared/audio/wav.js';
import { makePcm16, makeCanonicalWav, makeStereoWav } from './helpers/fixtures.js';
import {
  parseCliArgs,
  assertConformingWav,
  splitTurnBody,
  runCliTurn,
  main,
  DEFAULT_READ_TIMEOUT_MS,
  TOKEN_ENV_VAR,
  EXIT_CODES,
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
