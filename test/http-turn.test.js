// The first test file in this repository to open a real loopback socket — it exists to
// prove Phase 3's HTTP layer end to end (a real http.createServer, a real listen(0), a real
// client request) against fake adapters, no whisper, no OpenClaw binary, no speech backend
// and no network beyond the loopback socket this file itself opens. Exempted from both
// offline-scan guards (test/convert.test.js, test/turn-suite-hygiene.test.js) via their
// documented HTTP_SOCKET_EXEMPT_FILES sets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { createRequestHandler } from '../apps/voice-bridge/request-handler.js';
import { buildTurnResponseHead } from '../packages/shared/transport/turn-response.js';
import { defaultOutputFormatId } from '../packages/shared/transport/negotiate.js';
import { wavToPcm } from '../packages/shared/audio/wav.js';
import { makePcm16, makeCanonicalWav } from './helpers/fixtures.js';

function uniqueSessionId(label) {
  return `http-turn-test-${label}-${randomUUID()}`;
}

function buildTestConfig() {
  return {
    security: {
      token: '',
      expectedHost: null,
      allowedOrigins: [],
      maxJsonBytes: 50_000_000,
      rateLimitWindowMs: 15_000,
      rateLimitMaxRequests: 1000,
    },
    stt: {},
    openclaw: { sessionId: uniqueSessionId('turn') },
    tts: {},
  };
}

function makeFakeAdapters({ transcript, reply, wavBuffer }) {
  return {
    transcribe: async () => ({ text: transcript, meta: {} }),
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

function postTurn(port, { body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/turn',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test('a real client POSTs raw pcm16 bytes to /v1/turn and receives transcript, reply, and audio bytes in one chunked response', async () => {
  const requestPcm = makePcm16({ samples: 8000 });
  const replyPcm = makePcm16({ samples: 4000 });
  const replyWav = makeCanonicalWav({ pcm: replyPcm });

  const fakeTranscript = 'what time is it';
  // Contains a multi-byte UTF-8 character ('°') so byte length must exceed character length.
  const fakeReply = 'The temperature is 22°C today.';

  const adapters = makeFakeAdapters({ transcript: fakeTranscript, reply: fakeReply, wavBuffer: replyWav });
  const config = buildTestConfig();
  const handler = createRequestHandler({ config, adapters, webDir: '/nonexistent' });

  const server = await startServer(handler);
  try {
    const port = server.address().port;
    const response = await postTurn(port, {
      body: requestPcm,
      headers: { 'X-Voice-Input-Format': 'pcm16' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.headers['cache-control'], 'no-transform');
    assert.equal(response.headers['x-api-version'], '1');
    assert.equal(response.headers['transfer-encoding'], 'chunked');
    assert.equal(response.headers['content-length'], undefined);

    const transcriptBytes = Number(response.headers['x-voice-transcript-bytes']);
    const replyBytes = Number(response.headers['x-voice-reply-bytes']);
    assert.equal(transcriptBytes, Buffer.byteLength(fakeTranscript, 'utf8'));
    assert.equal(replyBytes, Buffer.byteLength(fakeReply, 'utf8'));
    assert.ok(replyBytes > fakeReply.length, 'a multi-byte reply must declare more bytes than its character length');

    const body = response.body;
    const transcriptSegment = body.subarray(0, transcriptBytes);
    const replySegment = body.subarray(transcriptBytes, transcriptBytes + replyBytes);
    const audioSegment = body.subarray(transcriptBytes + replyBytes);

    assert.equal(transcriptSegment.toString('utf8'), fakeTranscript);
    assert.equal(replySegment.toString('utf8'), fakeReply);
    assert.deepEqual(audioSegment, wavToPcm(replyWav));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('buildTurnResponseHead returns a plain, socket-free object with no ServerResponse or res in scope', () => {
  const head = buildTurnResponseHead({
    transcript: 'a',
    reply: 'b',
    outputFormatId: defaultOutputFormatId(),
    audioPresent: true,
  });

  assert.equal(head.status, 200);
  assert.ok(head.headers);
  assert.ok(Buffer.isBuffer(head.transcriptBuffer));
  assert.ok(Buffer.isBuffer(head.replyBuffer));
  assert.equal(head.transcriptBuffer.toString('utf8'), 'a');
  assert.equal(head.replyBuffer.toString('utf8'), 'b');
});
