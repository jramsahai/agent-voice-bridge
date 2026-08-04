// Server-free unit suite for packages/shared/security/rate-limit.js (TEST-01, AUTH-05).
// No server, no socket, no sleep — every timing assertion passes an explicit `now`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkRateLimitBucket,
  FAILED_AUTH_BUCKET_KEY,
  FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS,
  FAILED_AUTH_RATE_LIMIT_WINDOW_MS,
} from '../packages/shared/security/rate-limit.js';

test('the boundary: with maxRequests of 3 and a fixed injected now, calls 1-3 return true and call 4 returns false', () => {
  const buckets = new Map();
  const now = 1_000_000;
  assert.equal(checkRateLimitBucket(buckets, 3, 60_000, 'k', now), true);
  assert.equal(checkRateLimitBucket(buckets, 3, 60_000, 'k', now), true);
  assert.equal(checkRateLimitBucket(buckets, 3, 60_000, 'k', now), true);
  assert.equal(checkRateLimitBucket(buckets, 3, 60_000, 'k', now), false);
});

test('a call at injected now === firstTimestamp + windowMs is admitted (strict less-than evicts a timestamp exactly windowMs old); a call at windowMs - 1 is still refused', () => {
  const windowMs = 60_000;
  const firstTimestamp = 1_000_000;

  const atBoundary = new Map();
  checkRateLimitBucket(atBoundary, 1, windowMs, 'k', firstTimestamp);
  assert.equal(checkRateLimitBucket(atBoundary, 1, windowMs, 'k', firstTimestamp + windowMs), true);

  const justBefore = new Map();
  checkRateLimitBucket(justBefore, 1, windowMs, 'k', firstTimestamp);
  assert.equal(checkRateLimitBucket(justBefore, 1, windowMs, 'k', firstTimestamp + windowMs - 1), false);
});

test('refusal does not consume budget: repeated refusals do not extend the window, and the bucket array never grows past maxRequests', () => {
  const buckets = new Map();
  const now = 2_000_000;
  checkRateLimitBucket(buckets, 2, 60_000, 'k', now);
  checkRateLimitBucket(buckets, 2, 60_000, 'k', now);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(checkRateLimitBucket(buckets, 2, 60_000, 'k', now + i), false);
    assert.equal(buckets.get('k').length, 2, 'the bucket array must never grow past maxRequests');
  }
});

test('boundedness: 1000 calls whose keys are drawn from a three-element key set leave the buckets Map holding exactly 3 entries', () => {
  const buckets = new Map();
  const keys = ['alpha', 'beta', 'gamma'];
  const now = 3_000_000;
  for (let i = 0; i < 1000; i += 1) {
    checkRateLimitBucket(buckets, 6, 60_000, keys[i % keys.length], now + i);
  }
  assert.equal(buckets.size, 3);
});

test('the failed-auth constants exist and the fixed key is a single string, so the failed-auth bucket can only ever hold one entry no matter how many distinct callers present a bad token', () => {
  assert.equal(typeof FAILED_AUTH_BUCKET_KEY, 'string');
  assert.equal(typeof FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS, 'number');
  assert.equal(typeof FAILED_AUTH_RATE_LIMIT_WINDOW_MS, 'number');

  const buckets = new Map();
  const now = 4_000_000;
  for (let i = 0; i < 500; i += 1) {
    checkRateLimitBucket(buckets, FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS, FAILED_AUTH_RATE_LIMIT_WINDOW_MS, FAILED_AUTH_BUCKET_KEY, now + i);
  }
  assert.equal(buckets.size, 1);
});

test('exactly FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS calls at the fixed key are admitted before the next is refused', () => {
  const buckets = new Map();
  const now = 5_000_000;
  for (let i = 0; i < FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS; i += 1) {
    assert.equal(
      checkRateLimitBucket(buckets, FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS, FAILED_AUTH_RATE_LIMIT_WINDOW_MS, FAILED_AUTH_BUCKET_KEY, now),
      true,
      `call ${i + 1} must be admitted`,
    );
  }
  assert.equal(
    checkRateLimitBucket(buckets, FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS, FAILED_AUTH_RATE_LIMIT_WINDOW_MS, FAILED_AUTH_BUCKET_KEY, now),
    false,
  );
});

test('checkRateLimitBucket defaults now to the real clock when omitted (no explicit now argument), and still admits within budget', () => {
  const buckets = new Map();
  assert.equal(checkRateLimitBucket(buckets, 2, 60_000, 'k'), true);
  assert.equal(checkRateLimitBucket(buckets, 2, 60_000, 'k'), true);
  assert.equal(checkRateLimitBucket(buckets, 2, 60_000, 'k'), false);
});
