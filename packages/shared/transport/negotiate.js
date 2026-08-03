// Pure, I/O-free HTTP header negotiation for the /v1/turn wire contract (D-03: header
// names carry the registry's short wire ids, never MIME types). This module never
// re-derives format validity itself — it delegates to format-registry.js's lookupFormat()
// and error-response.js's unsupportedFormatError()/buildError(), the same modules
// convert.js already consumes, so a format's validity is defined in exactly one place.
// Resolve-never-throw, mirroring error-response.js's own posture: bad or absent input
// resolves to { error }, never a thrown exception — except a call with no headers
// argument at all, which throws (there is nothing to negotiate against), unlike
// negotiate({}), which resolves an { error } object like any other rejected input.

import { AUDIO_FORMATS, lookupFormat } from '../audio/format-registry.js';
import { unsupportedFormatError, buildError } from '../errors/error-response.js';

export const INPUT_FORMAT_HEADER = 'X-Voice-Input-Format';
export const OUTPUT_FORMAT_HEADER = 'X-Voice-Output-Format';
export const WANT_AUDIO_HEADER = 'X-Voice-Want-Audio';

// The one value that turns audio off. This rule is deliberately asymmetric: an absent
// header, an empty header, and any unrecognised value all resolve audio-wanted. A
// firmware client that ships a fixed header string can never silently lose its audio to
// a typo — only the exact disabled token does that. This is a discretionary choice this
// plan records rather than inherits; Phase 6 documents the same rule from this constant.
export const WANT_AUDIO_DISABLED_TOKEN = '0';

// The registry's single headerless row is, by construction (format-registry.js), the
// default output format for a client that declares no preference — found structurally,
// the same way convert.js's resolveDefaultHeaderlessFormat() finds it, so this module never
// hardcodes a registered wire id and FMT-07's one-row-change property survives here too.
export function defaultOutputFormatId() {
  const entry = Object.entries(AUDIO_FORMATS).find(([, row]) => row.headerless);
  if (!entry) {
    throw new Error('negotiate.js: no registry row is headerless; cannot derive a default output format');
  }
  return entry[0];
}

// Reply-direction availability, resolved structurally from the registry's own row data
// (the `headerless` flag) rather than from a copied literal list — the same
// structural-resolution technique convert.js uses for WHISPER_INPUT and the whisper
// conversion recipe. Sorted freshly on every call, matching listSupportedFormats()'s
// no-caching contract, so registering a new headerless row extends the reply direction
// with no edit here.
//
// D-01: the reply direction has exactly one member today (pcm16) because this phase
// deliberately ships only the pcm16 reply path — `wav` as a reply format is out of
// scope this phase. prepareClientOutput()'s container-format branch (convert.js) is the
// second line of defense behind the pre-check below: it independently returns 415 for
// any non-headerless requestedFormatId, untouched by this module. The pre-check exists
// so a client is never told a format is available in this direction only to be rejected
// a second time by that backstop.
export function listReplyFormats() {
  return Object.entries(AUDIO_FORMATS)
    .filter(([, row]) => row.headerless)
    .map(([id]) => id)
    .sort();
}

function readHeader(headers, name) {
  // No optional chaining here: a call with no headers argument at all (negotiate())
  // throws a TypeError on this property access, which is the intended "no input at all
  // causes a throw" behavior — negotiate({}) still resolves normally since {} is a
  // real object with no own properties.
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

// Same reflected-input defense error-response.js's unsupportedFormatError() applies to
// the input-format side (T-3-02): a client-controlled header value that reaches this
// error message must not become a second, unbounded reflector. The bracketed [empty]
// placeholder and the length ceiling mirror that module's own constants without
// importing them (this module's declared file scope is negotiate.js/test only).
const MAX_ECHOED_OUTPUT_FORMAT_ID_LENGTH = 200;

function renderOutputFormatId(value) {
  if (value === '') {
    return '[empty]';
  }
  const text = String(value);
  return text.length > MAX_ECHOED_OUTPUT_FORMAT_ID_LENGTH
    ? `${text.slice(0, MAX_ECHOED_OUTPUT_FORMAT_ID_LENGTH)}...`
    : text;
}

// Built via buildError() directly (the one error envelope — see error-response.js) so
// its shape matches unsupportedFormatError()'s exactly, but the list it advertises is
// direction-correct: only formats prepareClientOutput() can actually deliver, never the
// whole registry. This is what closes the inherited Phase 1 FMT-02 item STATE.md
// records — today listSupportedFormats() is direction-agnostic, so a reply-format
// rejection built from it would name `wav` as supported even though
// prepareClientOutput(buf, 'wav') returns 415, walking a screenless client into a
// second failure.
function unsupportedReplyFormatError(requestedOutputFormatId) {
  const supportedFormats = listReplyFormats();
  const label = renderOutputFormatId(requestedOutputFormatId);
  const message = `Requested output format '${label}' is not available as a reply format. Available reply formats: ${supportedFormats.join(', ')}.`;
  return buildError('FMT_UNSUPPORTED', message, {
    status: 415,
    body: { supportedFormats },
  });
}

// Reads the lowercase forms of the header-name constants above off a plain Node req.headers
// object and resolves to { inputFormatId, outputFormatId, wantAudio } or, following
// error-response.js's resolve-never-throw posture, to { error }. Every header value is
// compared byte-for-byte against the registry (lookupFormat()'s Object.hasOwn guard
// already enforces this): no case folding, no trimming, no normalisation, so a mis-cased
// or padded id is rejected exactly like an unregistered one.
export function negotiate(headers) {
  const inputFormatId = readHeader(headers, INPUT_FORMAT_HEADER);
  if (!lookupFormat(inputFormatId)) {
    return { error: unsupportedFormatError(inputFormatId) };
  }

  const requestedOutputFormatId = readHeader(headers, OUTPUT_FORMAT_HEADER);
  const outputFormatId = requestedOutputFormatId ?? defaultOutputFormatId();
  if (!listReplyFormats().includes(outputFormatId)) {
    return { error: unsupportedReplyFormatError(outputFormatId) };
  }

  const wantAudioHeader = readHeader(headers, WANT_AUDIO_HEADER);
  const wantAudio = wantAudioHeader === undefined ? true : wantAudioHeader !== WANT_AUDIO_DISABLED_TOKEN;

  return { inputFormatId, outputFormatId, wantAudio };
}
