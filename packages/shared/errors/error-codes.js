// The single place every error code the service can return is defined. This catalogue is
// never complete — a later phase adds its own row here, deliberately, and once a code is
// published its key and status are pinned: an existing entry's code or status is never
// redefined, only new entries are appended.

export const ERROR_CODES = Object.freeze({
  FMT_UNSUPPORTED: Object.freeze({
    status: 415,
    title: 'The requested audio format is not supported.',
  }),
  AUDIO_MALFORMED: Object.freeze({
    status: 400,
    title: 'The audio data is malformed or does not match the declared format.',
  }),
  AUDIO_TOO_LARGE: Object.freeze({
    status: 413,
    title: 'The audio payload exceeds the maximum allowed size.',
  }),
  AUDIO_CONVERSION_FAILED: Object.freeze({
    status: 500,
    title: 'Audio conversion failed.',
  }),
  TURN_BUSY: Object.freeze({
    status: 409,
    title: 'Another turn is already in progress. Try again shortly.',
  }),
  TURN_ABORTED: Object.freeze({
    // 499 is not an IANA-registered status; it is the long-standing reverse-proxy
    // convention for a client that closed the request before the server could respond. By
    // definition nothing is listening to receive it over the wire — it exists so the
    // pipeline's internal failure shape has a stable identity that Phase 3 can log and map.
    status: 499,
    title: 'The turn was aborted before it could complete.',
  }),
});

// Shape invariants enforced once, at import time, so a malformed catalogue fails the
// process immediately rather than at the moment a client hits that error path.
const CODE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

for (const [key, value] of Object.entries(ERROR_CODES)) {
  if (!CODE_KEY_PATTERN.test(key)) {
    throw new Error(`error-codes: catalogue key '${key}' must match ${CODE_KEY_PATTERN}`);
  }
  if (!Number.isInteger(value.status) || value.status < 400 || value.status > 599) {
    throw new Error(`error-codes: '${key}'.status must be an integer between 400 and 599`);
  }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    throw new Error(`error-codes: '${key}'.title must be a non-empty string`);
  }
}

export function isKnownErrorCode(code) {
  return Object.hasOwn(ERROR_CODES, code);
}
