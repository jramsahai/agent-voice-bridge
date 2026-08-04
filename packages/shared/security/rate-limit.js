// Generic sliding-window bucket check, relocated verbatim (plus one additive parameter) from
// apps/voice-bridge/request-handler.js (Phase 3), plus the discovery-endpoint constants and
// the failed-auth throttle this phase adds.

// The discovery routes' own rate-limit ceiling (T-3-06/D-05, locked): a sustained one poll
// per second, ten times the turn endpoint's effective default rate — a wire-visible
// operational decision a monitoring configuration and a firmware polling interval are both
// written against, not a tuning knob to be changed lightly.
export const DISCOVERY_RATE_LIMIT_MAX_REQUESTS = 60;
export const DISCOVERY_RATE_LIMIT_WINDOW_MS = 60_000;

// D-05, locked: failed-auth attempts draw on one fixed-key bucket, never keyed by address —
// an address-keyed bucket would reintroduce exactly the unbounded growth AUTH-05 exists to
// remove, just for a different caller class (credential guessing). Closes 03-REVIEW.md's
// open item WR-01 (failed-auth requests were previously unthrottled).
export const FAILED_AUTH_BUCKET_KEY = '__unauthenticated__';
export const FAILED_AUTH_RATE_LIMIT_MAX_REQUESTS = 20;
export const FAILED_AUTH_RATE_LIMIT_WINDOW_MS = 60_000;

// Parameterised over the Map, ceiling, and window so any number of independent budgets can
// share this one sliding-window primitive without duplicating it (the turn endpoint, the two
// discovery endpoints, and the failed-auth bucket all draw on this same function). `now`
// defaults to the real clock but accepts an explicit override so a test can drive
// window-boundary behavior without sleeping. The strict `now - ts < windowMs` comparison
// evicts a timestamp exactly `windowMs` old rather than retaining it — kept exactly as it was
// before this relocation.
export function checkRateLimitBucket(buckets, maxRequests, windowMs, key, now = Date.now()) {
  const bucket = buckets.get(key) ?? [];
  const fresh = bucket.filter((ts) => now - ts < windowMs);
  if (fresh.length >= maxRequests) {
    buckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  buckets.set(key, fresh);
  return true;
}
