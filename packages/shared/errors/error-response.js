// Shared error envelope builder used by every later phase. Returns a plain object —
// it has no HTTP response-transport dependency at all — so it is testable with
// nothing listening. Wiring this into the transport layer is Phase 3's job.

import { ERROR_CODES, isKnownErrorCode } from './error-codes.js';
import { listSupportedFormats } from '../audio/format-registry.js';

// Named export so consumers (including tests deriving the header name to assert on) never
// have to re-derive it positionally from the headers object buildError() below returns.
export const ERROR_CODE_HEADER_NAME = 'X-Error-Code';

// A reflected caller-controlled identifier is bounded so this module can never be used
// as an arbitrary-length reflector for hostile input (documented limit — read by the
// test suite rather than duplicated there).
const MAX_ECHOED_IDENTIFIER_LENGTH = 200;

// Bracketed placeholders for absent/empty requested-format input, so a screenless
// client's message never reads as though a format literally named "null" or
// "undefined" (a JavaScript primitive) was requested.
const EMPTY_FORMAT_LABEL = '[empty]';
const ABSENT_FORMAT_LABEL = '[none]';

function renderRequestedFormatLabel(requestedFormatId) {
  if (requestedFormatId === '') {
    return EMPTY_FORMAT_LABEL;
  }
  if (requestedFormatId === null || requestedFormatId === undefined) {
    return ABSENT_FORMAT_LABEL;
  }
  const text = String(requestedFormatId);
  if (text.length > MAX_ECHOED_IDENTIFIER_LENGTH) {
    return `${text.slice(0, MAX_ECHOED_IDENTIFIER_LENGTH)}...`;
  }
  return text;
}

// DEBT-02: a screenless client classifies a rejection by its status and its X-Error-Code
// header together, so a code emitted under a status the catalogue does not assign it is a
// rejection the device's state machine cannot classify at all. Validated here rather than
// trusted, so the whole class of drift closes in the one place every rejection renders
// from instead of needing an audit of every call site forever.
function assertStatusOverride(code, extra) {
  if (extra.status === undefined) {
    return;
  }
  const catalogueStatus = ERROR_CODES[code].status;
  if (extra.status !== catalogueStatus) {
    throw new Error(
      `buildError: status override ${JSON.stringify(extra.status)} for '${code}' does not match its catalogue status ${catalogueStatus}`,
    );
  }
}

export function buildError(code, message, extra = {}) {
  if (!isKnownErrorCode(code)) {
    throw new Error(`buildError: '${code}' is not a registered error code`);
  }
  assertStatusOverride(code, extra);
  const status = extra.status ?? ERROR_CODES[code].status;
  // A non-string or empty message is not a meaningful thing for a screenless client to
  // render — fall back to the catalogue's fixed title for the code rather than emitting
  // an empty or object-shaped message.
  const safeMessage = typeof message === 'string' && message.length > 0 ? message : ERROR_CODES[code].title;
  return {
    status,
    headers: { [ERROR_CODE_HEADER_NAME]: code },
    body: {
      error: {
        ...(extra.body ?? {}),
        // code and message always win over anything extra.body tried to supply,
        // so a caller can never spoof the stable machine-readable identity of the error.
        code,
        message: safeMessage,
      },
    },
  };
}

export function unsupportedFormatError(requestedFormatId) {
  // Freshly built and sorted by format-registry.js on every call — this function must
  // not re-derive, re-sort, or cache that guarantee, only consume it.
  const supportedFormats = listSupportedFormats();
  const label = renderRequestedFormatLabel(requestedFormatId);
  const message = `Requested format '${label}' is not supported. Supported formats: ${supportedFormats.join(', ')}.`;
  return buildError('FMT_UNSUPPORTED', message, {
    status: 415,
    body: { supportedFormats },
  });
}
