// IN-02 regression pin: speakWithKokoroFast resolves the speed once and threads it
// into speakWithFastApi via { signal, speed } instead of speakWithFastApi recomputing
// it. This test opens a real loopback HTTP server to verify the threaded speed value
// reaches the FastAPI request body and is included in the returned meta.speed.
//
// This file legitimately opens a real loopback socket — the same hermetic in-process
// pattern as test/http-health.test.js and test/api-spec-contract.test.js — and is
// exempted from the offline-scan guards via HTTP_SOCKET_EXEMPT_FILES.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { speakWithKokoroFast } from '../packages/shared/adapters/tts-kokoro-onnx.js';
import { resetBackendHealthCache } from '../packages/shared/health/backend-health-cache.js';

const UNREACHABLE_SERVICE_URL = 'http://127.0.0.1:1';

// IN-02: speakWithKokoroFast keeps the resolved speed and threads it into speakWithFastApi via
// { signal, speed } instead of speakWithFastApi recomputing it. The threaded value must reach
// the FastAPI request body and be included in the returned meta.speed.
test('IN-02: speed is resolved once in speakWithKokoroFast and threaded through to speakWithFastApi, reaching the request body and meta', async () => {
  resetBackendHealthCache();

  // Create a minimal loopback HTTP server that echoes back the request body
  let receivedSpeed = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/generate' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const requestBody = JSON.parse(body);
        receivedSpeed = requestBody.speed;

        // Return a minimal valid WAV file (44-byte header + silent data)
        const wavHeader = Buffer.from([
          0x52, 0x49, 0x46, 0x46, // RIFF
          0x24, 0x00, 0x00, 0x00, // file size - 8
          0x57, 0x41, 0x56, 0x45, // WAVE
          0x66, 0x6d, 0x74, 0x20, // fmt
          0x10, 0x00, 0x00, 0x00, // fmt chunk size
          0x01, 0x00, 0x01, 0x00, // PCM, 1 channel
          0x80, 0x3e, 0x00, 0x00, // 16000 Hz sample rate
          0x00, 0x7d, 0x00, 0x00, // bytes per second
          0x02, 0x00, 0x10, 0x00, // block align, bits per sample
          0x64, 0x61, 0x74, 0x61, // data
          0x00, 0x00, 0x00, 0x00, // data size
        ]);

        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(wavHeader);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  try {
    await new Promise((resolve) => server.listen(0, 'localhost', resolve));
    const { port } = server.address();
    const serviceUrl = `http://localhost:${port}`;

    const configuredSpeed = 0.85;
    const result = await speakWithKokoroFast(
      'test speech',
      { serviceUrl, speed: configuredSpeed, voice: 'af_heart' },
      {},
    );

    assert.equal(
      receivedSpeed,
      configuredSpeed,
      'the FastAPI request body must carry the resolved speed from speakWithKokoroFast',
    );
    assert.equal(
      result.meta.speed,
      configuredSpeed,
      'the returned meta.speed must match the requested speed',
    );
  } finally {
    server.close();
  }
});

test('IN-02: the threaded speed is used even with non-default values', async () => {
  resetBackendHealthCache();

  let receivedSpeed = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    if (req.url === '/generate' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const requestBody = JSON.parse(body);
        receivedSpeed = requestBody.speed;

        // Return minimal WAV
        const wavHeader = Buffer.from([
          0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
          0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
          0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
          0x80, 0x3e, 0x00, 0x00, 0x00, 0x7d, 0x00, 0x00,
          0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
          0x00, 0x00, 0x00, 0x00,
        ]);
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(wavHeader);
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  try {
    await new Promise((resolve) => server.listen(0, 'localhost', resolve));
    const { port } = server.address();
    const serviceUrl = `http://localhost:${port}`;

    // Test with a much faster speed
    const fastSpeed = 2.5;
    const result = await speakWithKokoroFast(
      'test speech',
      { serviceUrl, speed: fastSpeed, voice: 'af_heart' },
      {},
    );

    assert.equal(
      receivedSpeed,
      fastSpeed,
      'the FastAPI request body must carry the faster speed',
    );
    assert.equal(
      result.meta.speed,
      fastSpeed,
      'the returned meta.speed must match the faster speed',
    );
  } finally {
    server.close();
  }
});
