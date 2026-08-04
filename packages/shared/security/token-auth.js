// Multi-client bearer-token identity resolution. Pure and socket-free: no fs, no http, no
// process access — every input arrives as a plain argument, so this module is directly
// testable with fixture objects (TEST-01).
//
// Constant-total-time by construction (T-4-01): the received token is hashed once to a
// fixed 32-byte SHA-256 digest and compared against every configured candidate digest with
// timingSafeEqual — the loop below never breaks or returns early on a match. This buys two
// properties a naive early-exit loop would leak: (1) total elapsed time does not depend on
// which candidate (if any) matched, and (2) because both operands are always 32-byte digests
// regardless of the original token's length, timingSafeEqual's length-mismatch RangeError
// can never fire, so no manual length pre-check is needed. Do not "optimize" the early exit
// back in — that reintroduces both properties as an attacker-observable timing signal.

import { createHash, timingSafeEqual } from 'node:crypto';

// The escape hatch preserved from the single-token era (D-04, locked): when no client is
// configured, every request resolves to this one fixed identity. Bounded — exactly one
// possible bucket key — and made unreachable in a production boot by 04-03's
// validateConfig(), which treats an absent/empty security.clients as a hard startup error.
export const ANONYMOUS_CLIENT_NAME = '__anonymous__';

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

// Maps a { name: token } object to an array of [name, digest] pairs. Tolerates a
// null/undefined/non-object argument by returning an empty array — this module stays
// permissive on shape so it composes under any caller; 04-03's validateConfig() is the layer
// that rejects an absent/empty security.clients for a live service.
export function buildClientDigests(clients) {
  if (clients === null || typeof clients !== 'object') return [];
  return Object.entries(clients).map(([name, token]) => [name, digest(token)]);
}

// Resolve-never-throw, mirroring error-response.js's posture elsewhere in this codebase.
// Returns the matched name or null. A falsy receivedToken short-circuits with zero
// comparisons run — there is no candidate-specific timing to leak when nothing is compared.
export function resolveClientIdentity(clientDigests, receivedToken) {
  if (!receivedToken) return null;
  const receivedDigest = digest(receivedToken);
  let matched = null;
  for (const [name, candidateDigest] of clientDigests) {
    // timingSafeEqual never throws here: both operands are always 32-byte SHA-256 digests,
    // regardless of the original token's length.
    if (timingSafeEqual(receivedDigest, candidateDigest)) {
      matched = name;
    }
  }
  return matched;
}
