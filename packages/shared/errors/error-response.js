// Shared error envelope builder used by every later phase. Returns a plain object —
// it has no HTTP response-transport dependency at all — so it is testable with
// nothing listening. Wiring this into the transport layer is Phase 3's job.

import { ERROR_CODES, isKnownErrorCode } from './error-codes.js';
import { listSupportedFormats } from '../audio/format-registry.js';

export function buildError(code, message, extra = {}) {
  if (!isKnownErrorCode(code)) {
    throw new Error(`buildError: '${code}' is not a registered error code`);
  }
  const status = extra.status ?? ERROR_CODES[code].status;
  return {
    status,
    headers: { 'X-Error-Code': code },
    body: {
      error: {
        ...(extra.body ?? {}),
        // code and message always win over anything extra.body tried to supply,
        // so a caller can never spoof the stable machine-readable identity of the error.
        code,
        message,
      },
    },
  };
}

export function unsupportedFormatError(requestedFormatId) {
  const supportedFormats = listSupportedFormats();
  const message = `Requested format '${requestedFormatId}' is not supported. Supported formats: ${supportedFormats.join(', ')}.`;
  return buildError('FMT_UNSUPPORTED', message, {
    status: 415,
    body: { supportedFormats },
  });
}
