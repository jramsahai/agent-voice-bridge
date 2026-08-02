// The single place every error code the service can return is defined. Every later
// phase imports from this already-complete catalogue rather than appending its own row.

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
});

export function isKnownErrorCode(code) {
  return Object.hasOwn(ERROR_CODES, code);
}
