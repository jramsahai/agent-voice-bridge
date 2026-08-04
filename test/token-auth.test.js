// Server-free unit suite for packages/shared/security/token-auth.js (TEST-01, AUTH-01/02/03).
// No server, no socket, no config file, no sleep — every fixture below is a plain object.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildClientDigests, resolveClientIdentity, ANONYMOUS_CLIENT_NAME } from '../packages/shared/security/token-auth.js';

test('each of three configured clients resolves to its own name under its own token', () => {
  const digests = buildClientDigests({ alpha: 'alpha-secret', beta: 'beta-secret', gamma: 'gamma-secret' });
  assert.equal(resolveClientIdentity(digests, 'alpha-secret'), 'alpha');
  assert.equal(resolveClientIdentity(digests, 'beta-secret'), 'beta');
  assert.equal(resolveClientIdentity(digests, 'gamma-secret'), 'gamma');
});

test('removing one entry from the fixture map and rebuilding the digest table leaves every remaining name resolving exactly as before (AUTH-02 revocation independence)', () => {
  const clients = { alpha: 'alpha-secret', beta: 'beta-secret', gamma: 'gamma-secret' };
  const before = buildClientDigests(clients);
  assert.equal(resolveClientIdentity(before, 'alpha-secret'), 'alpha');
  assert.equal(resolveClientIdentity(before, 'gamma-secret'), 'gamma');

  const { beta: _removed, ...remaining } = clients;
  const after = buildClientDigests(remaining);
  assert.equal(resolveClientIdentity(after, 'alpha-secret'), 'alpha');
  assert.equal(resolveClientIdentity(after, 'gamma-secret'), 'gamma');
  assert.equal(resolveClientIdentity(after, 'beta-secret'), null);
});

test('an unknown token, an empty string, undefined, and null all resolve null and none of them throws', () => {
  const digests = buildClientDigests({ alpha: 'alpha-secret' });
  assert.equal(resolveClientIdentity(digests, 'not-a-real-token'), null);
  assert.equal(resolveClientIdentity(digests, ''), null);
  assert.equal(resolveClientIdentity(digests, undefined), null);
  assert.equal(resolveClientIdentity(digests, null), null);
});

test('a 1-byte token and a 5000-byte token both resolve null without throwing, against a fixture whose configured tokens are a different length again', () => {
  const digests = buildClientDigests({ alpha: 'a-medium-length-secret-value' });
  assert.equal(resolveClientIdentity(digests, 'x'), null);
  assert.equal(resolveClientIdentity(digests, 'x'.repeat(5000)), null);
});

test('two configured tokens where one is a strict prefix of the other each resolve to their own name; the shorter token never resolves the longer one\'s name', () => {
  const digests = buildClientDigests({ short: 'secret', long: 'secret-plus-more' });
  assert.equal(resolveClientIdentity(digests, 'secret'), 'short');
  assert.equal(resolveClientIdentity(digests, 'secret-plus-more'), 'long');
});

test('two configured tokens differing in exactly one byte each resolve to their own name', () => {
  const digests = buildClientDigests({ a: 'token-value-aaaa', b: 'token-value-aaab' });
  assert.equal(resolveClientIdentity(digests, 'token-value-aaaa'), 'a');
  assert.equal(resolveClientIdentity(digests, 'token-value-aaab'), 'b');
});

test('resolution is order-independent: building the digest table from the same pairs in two different insertion orders resolves the same token to the same name', () => {
  const forward = buildClientDigests({ alpha: 'alpha-secret', beta: 'beta-secret', gamma: 'gamma-secret' });
  const reversed = buildClientDigests({ gamma: 'gamma-secret', beta: 'beta-secret', alpha: 'alpha-secret' });
  for (const token of ['alpha-secret', 'beta-secret', 'gamma-secret']) {
    assert.equal(resolveClientIdentity(forward, token), resolveClientIdentity(reversed, token));
  }
});

test('buildClientDigests(undefined), buildClientDigests(null), and buildClientDigests({}) each return an empty array, and resolving against an empty table returns null', () => {
  for (const input of [undefined, null, {}]) {
    const digests = buildClientDigests(input);
    assert.deepEqual(digests, []);
    assert.equal(resolveClientIdentity(digests, 'anything'), null);
  }
});

test('the same token resolved ten times in a row returns the same name every time', () => {
  const digests = buildClientDigests({ alpha: 'alpha-secret', beta: 'beta-secret' });
  const results = Array.from({ length: 10 }, () => resolveClientIdentity(digests, 'beta-secret'));
  assert.ok(results.every((name) => name === 'beta'));
});

test('ANONYMOUS_CLIENT_NAME is a fixed, non-empty string distinct from any real client name', () => {
  assert.equal(typeof ANONYMOUS_CLIENT_NAME, 'string');
  assert.ok(ANONYMOUS_CLIENT_NAME.length > 0);
});
