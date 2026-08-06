const ptt = document.getElementById('ptt');
const tokenEl = document.getElementById('token');
const toggleTokenEl = document.getElementById('toggle-token');
const clearTokenEl = document.getElementById('clear-token');
const authPillEl = document.getElementById('auth-pill');
const busyPillEl = document.getElementById('busy-pill');
const transcriptEl = document.getElementById('transcript');
const replyEl = document.getElementById('reply');
const player = document.getElementById('player');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');

let stream;
let mediaRecorder;
let recordedChunks = [];
let decodeAudioContext;
let isBusy = false;
let isRecording = false;
let lastPlayerObjectUrl = null;

// WR-06 (05-REVIEW.md): without this, a hung backend leaves the fetch promise never settling
// and the "Working..." button stuck with no way to recover short of reloading the page. This
// deliberately stays tighter than the published minimum client read timeout
// (packages/shared/transport/read-timeout.js) — a human is watching this page, and a five-minute
// silent wait is worse than an early, recoverable error. A headless client (the reference CLI,
// firmware) must use the published floor instead; the browser's own tighter value is a Phase 5
// UX choice, not a spec requirement, and is unchanged by Phase 6.
const REQUEST_TIMEOUT_MS = 30000;

const TOKEN_STORAGE_KEY = 'voice-bridge-token';
const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
if (savedToken) tokenEl.value = savedToken;

function updateTokenState() {
  const hasToken = Boolean(tokenEl.value.trim());
  authPillEl.textContent = hasToken ? 'token saved' : 'token required';
  authPillEl.style.background = hasToken ? '#14532d' : '#374151';
}

function persistToken() {
  const value = tokenEl.value.trim();
  if (value) {
    localStorage.setItem(TOKEN_STORAGE_KEY, value);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
  updateTokenState();
}

tokenEl.addEventListener('change', persistToken);
tokenEl.addEventListener('input', updateTokenState);
updateTokenState();

toggleTokenEl.addEventListener('click', () => {
  tokenEl.type = tokenEl.type === 'password' ? 'text' : 'password';
  toggleTokenEl.textContent = tokenEl.type === 'password' ? 'Show' : 'Hide';
});

clearTokenEl.addEventListener('click', () => {
  tokenEl.value = '';
  persistToken();
  setStatus('Token cleared.');
});

function setStatus(text) {
  statusEl.textContent = text;
}

function setHint(text) {
  hintEl.textContent = text;
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  ptt.disabled = nextBusy;
  if (nextBusy) {
    ptt.classList.add('processing');
    ptt.textContent = 'Working...';
  } else {
    ptt.classList.remove('processing');
    ptt.textContent = 'Hold to talk';
  }
}

// WEB-03: a refused turn (TURN_BUSY) must read as a named, distinct state — never the
// amber 'processing'/'Working...' spinner setBusy() above shows for a turn that is
// actually running. Cleared at the start of every new turn attempt and on the next
// success (see stopAndSend below), so a stale busy pill never survives past the user's
// next action.
function setTurnBusyState(active) {
  busyPillEl.hidden = !active;
  if (active) {
    ptt.classList.add('locked');
    setStatus('Busy: another client is mid-turn; your turn was not sent.');
  } else {
    ptt.classList.remove('locked');
  }
}

// Replaces the old freeform-message humanizeError(): every branch here is keyed on a
// stable catalogue code name (packages/shared/errors/error-codes.js), never on matching
// a server-supplied message string. The default falls back to the envelope's own message
// so an unrecognised code (e.g. a future catalogue row) still shows something readable.
function humanizeErrorCode(code, message) {
  switch (code) {
    case 'FMT_UNSUPPORTED':
      return 'That audio format is not supported.';
    case 'AUDIO_MALFORMED':
      return 'The recorded audio was malformed.';
    case 'AUDIO_TOO_LARGE':
      return 'That recording was too large.';
    case 'AUDIO_CONVERSION_FAILED':
      return 'Audio conversion failed on the bridge.';
    case 'TURN_BUSY':
      return 'Another client is mid-turn. Your turn was not sent.';
    case 'TURN_ABORTED':
      return 'The turn was aborted before it could complete.';
    case 'TRANSCRIPT_EMPTY':
      return 'I heard almost nothing. Try speaking a little louder or longer.';
    case 'UNAUTHORIZED':
      return 'Wrong or missing access token.';
    case 'FORBIDDEN':
      return 'This browser origin or host is not allowed.';
    case 'RATE_LIMITED':
      return 'Slow down a bit and try again.';
    case 'NOT_FOUND':
      return 'That endpoint does not exist.';
    case 'INTERNAL_ERROR':
      return 'Something broke on the bridge. Try again.';
    default:
      return message || 'Request failed.';
  }
}

// The turn-error handler both the generic !response.ok branch and the splitTurnResponse
// catch call: clears the busy state so a refused/failed turn never leaves the UI looking
// as if a turn is still in progress, surfaces the error through the page's own
// humanizeErrorCode messaging path, sets the hint, and logs the code/message. Factored out
// so the catch path (WEB-01, must_haves truth) is mechanically testable in isolation —
// self-contained aside from the four module-scope functions it calls by name, which is
// exactly what the extracted-source contract test injects as doubles.
function reportTurnError(code, message, hint) {
  setTurnBusyState(false);
  // G-05-4 (sibling path): a failed turn renders no transcript or reply, so leaving the
  // player loaded would keep offering the PREVIOUS turn's audio next to an error message,
  // as if it belonged to the turn that just failed.
  resetPlayer();
  setStatus(`Error: ${humanizeErrorCode(code, message)}`);
  setHint(hint);
  console.error(code, message);
}

// IN-02 (05-REVIEW.md): the microphone stream is acquired once here and never released
// (no stream.getTracks().forEach(track => track.stop()) anywhere), so the browser's
// mic-in-use indicator stays lit for the page's remaining life after the first turn. This
// is intentional, not an oversight: re-acquiring the stream on every turn would re-prompt
// for permission each time, which is worse UX than a persistently-lit indicator.
async function ensureRecorder() {
  if (mediaRecorder) return;
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeTypes = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];
  const supportedMimeType = mimeTypes.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || '';
  mediaRecorder = supportedMimeType ? new MediaRecorder(stream, { mimeType: supportedMimeType }) : new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };
}

function interleaveChannels(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  if (channels === 1) return audioBuffer.getChannelData(0);
  const result = new Float32Array(length * channels);
  const channelData = [];
  for (let c = 0; c < channels; c++) channelData.push(audioBuffer.getChannelData(c));
  let offset = 0;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) result[offset++] = channelData[c][i];
  }
  return result;
}

function encodeWavFromAudioBuffer(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const samples = interleaveChannels(audioBuffer);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

async function blobToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  if (!decodeAudioContext) decodeAudioContext = new AudioContext();
  const audioBuffer = await decodeAudioContext.decodeAudioData(arrayBuffer.slice(0));
  return encodeWavFromAudioBuffer(audioBuffer);
}

// Splits a /v1/turn success response using only the three X-Voice-* framing headers, at
// exactly the declared byte offsets, in the fixed order transcript then reply then audio
// — never a body-length header (the success response sets none; it arrives chunked).
// The touching-boundary cases (a zero-length reply, or audio starting exactly at
// transcriptBytes + replyBytes) fall out of subarray()'s own start/end semantics: a
// zero-length reply slice decodes to '', and an audio slice with no bytes left (start
// === bytes.length) is explicitly treated as no audio below, not an empty Uint8Array.
//
// CR-01 (05-REVIEW.md), mirrored from cli.js's splitTurnBody: Uint8Array.prototype.subarray
// clamps an out-of-range end index instead of throwing, so a declared byte count that
// exceeds what was actually received must be refused before any subarray call — never
// silently clamped into a mis-split. Dropping the previous `|| 0` fallback is deliberate:
// an absent or non-numeric header must be refused, not coerced to zero. Strictly
// greater-than, so a declared total exactly equal to bytes.length is still accepted.
//
// Self-contained by construction: references only its own parameters, its own locals, and
// platform globals (Number, TextDecoder, Error) — no humanizeErrorCode call, no DOM
// element, no module-scope binding — so it can be extracted and evaluated in isolation.
function splitTurnResponse(headers, bytes) {
  const transcriptBytesHeader = headers.get('x-voice-transcript-bytes');
  const replyBytesHeader = headers.get('x-voice-reply-bytes');
  const transcriptBytes = Number(transcriptBytesHeader);
  const replyBytes = Number(replyBytesHeader);
  const audioPresentHeader = headers.get('x-voice-audio-present') === '1';

  if (
    !Number.isInteger(transcriptBytes) || transcriptBytes < 0 ||
    !Number.isInteger(replyBytes) || replyBytes < 0 ||
    transcriptBytes + replyBytes > bytes.length
  ) {
    const err = new Error(
      `response framing headers declare ${transcriptBytes + replyBytes} text bytes, ` +
        `but only ${bytes.length} bytes were received — refusing to guess a split`,
    );
    err.code = 'CONTRACT_VIOLATION';
    throw err;
  }

  const decoder = new TextDecoder('utf8');
  const transcript = decoder.decode(bytes.subarray(0, transcriptBytes));
  const reply = decoder.decode(bytes.subarray(transcriptBytes, transcriptBytes + replyBytes));

  const audioStart = transcriptBytes + replyBytes;
  const hasAudioBytes = audioPresentHeader && audioStart < bytes.length;
  const audioPcm = hasAudioBytes ? bytes.subarray(audioStart) : null;

  return { transcript, reply, audioPcm };
}

// The reply arrives as headerless PCM (16000 Hz, mono, 16-bit signed little-endian —
// the pcm16 registry row), not a data URI. This builds the same 44-byte RIFF/WAVE/fmt/data
// layout packages/shared/audio/wav.js's pcmToWav() writes server-side, purely so the
// browser's own <audio> element has a container it can decode; no server-side change.
function wrapPcmAsWavBlob(pcmBytes) {
  const sampleRate = 16000;
  const channels = 1;
  const bitDepth = 16;
  const blockAlign = channels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(buffer);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, pcmBytes.length, true);

  new Uint8Array(buffer, 44).set(pcmBytes);

  return new Blob([buffer], { type: 'audio/wav' });
}

// Detach the player from whatever reply it last held and hide it, so a turn that carries
// no audio can never present the previous turn's audio as its own (G-05-4).
function resetPlayer() {
  if (lastPlayerObjectUrl) {
    URL.revokeObjectURL(lastPlayerObjectUrl);
    lastPlayerObjectUrl = null;
  }
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.hidden = true;
}

async function stopAndSend() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  setBusy(true);
  setTurnBusyState(false);
  try {
    await new Promise((resolve) => {
      mediaRecorder.addEventListener('stop', resolve, { once: true });
      mediaRecorder.stop();
    });

    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    recordedChunks = [];
    setStatus('Processing audio...');
    setHint('Converting browser audio to WAV.');
    const wavBlob = await blobToWav(blob);

    setStatus('Transcribing and thinking...');
    setHint('Sending your turn to the bridge.');
    const requestBody = await wavBlob.arrayBuffer();

    // Raw WAV bytes as the request body — no JSON envelope, no base64 encoding step
    // (WEB-01, D-02). The browser stays on the wav input format: the service never
    // resamples a body declared pcm16, and a browser AudioContext runs at 44100 or
    // 48000 Hz by default, which would be silently mis-transcribed rather than rejected.
    const requestController = new AbortController();
    const requestTimeoutId = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch('/v1/turn', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenEl.value.trim()}`,
          'x-voice-input-format': 'wav'
        },
        body: requestBody,
        signal: requestController.signal
      });
    } finally {
      clearTimeout(requestTimeoutId);
    }

    const responseBytes = new Uint8Array(await response.arrayBuffer());

    if (!response.ok) {
      let errorCode = response.headers.get('x-error-code');
      let errorMessage;
      try {
        const envelope = JSON.parse(new TextDecoder('utf8').decode(responseBytes));
        errorMessage = envelope?.error?.message;
        errorCode = errorCode || envelope?.error?.code;
      } catch {
        // No parseable error envelope — fall back to the header-derived code alone.
      }

      if (errorCode === 'TURN_BUSY') {
        setTurnBusyState(true);
        setHint('Wait for the other client to finish, then try again.');
        console.error(errorCode, errorMessage);
        return;
      }

      reportTurnError(errorCode, errorMessage, 'Fix the issue and try again.');
      return;
    }

    let transcript;
    let reply;
    let audioPcm;
    try {
      ({ transcript, reply, audioPcm } = splitTurnResponse(response.headers, responseBytes));
    } catch (error) {
      reportTurnError(error.code, error.message, 'The response could not be trusted — nothing was rendered.');
      return;
    }
    transcriptEl.textContent = transcript || '—';
    replyEl.textContent = reply || '—';

    if (audioPcm) {
      if (lastPlayerObjectUrl) {
        URL.revokeObjectURL(lastPlayerObjectUrl);
      }
      const replyWavBlob = wrapPcmAsWavBlob(audioPcm);
      lastPlayerObjectUrl = URL.createObjectURL(replyWavBlob);
      player.src = lastPlayerObjectUrl;
      player.hidden = false;
      await player.play().catch(() => {});
    } else {
      // G-05-4 (05-UAT.md): a 200 can carry no audio segment (request-handler.js sets
      // audioPresent from Boolean(result.speech)). Leaving the player untouched here left
      // it enabled over a stale src — either the PREVIOUS turn's blob URL, which offers
      // the prior reply's audio as if it were this one, or an empty src, whose play()
      // aborts and surfaces an uncaught DOMException. removeAttribute + load() is what
      // actually detaches the media resource; src = '' resolves against the page URL.
      resetPlayer();
    }

    setTurnBusyState(false);
    setStatus('Done.');
    setHint('Press and hold to send another turn.');
  } catch (error) {
    // WR-04 (05-REVIEW.md): blobToWav()'s decodeAudioData and the fetch() call above have
    // no catch of their own — without this, a network failure or malformed-audio decode
    // error becomes an unhandled rejection that clears the busy state via `finally` below
    // but never tells the user why the turn silently failed.
    // WR-06: the AbortController above turns a hung backend into this same catch as an
    // AbortError — surfaced as a distinct timeout state rather than a generic network error.
    if (error.name === 'AbortError') {
      reportTurnError('TIMEOUT', `No response from the bridge after ${REQUEST_TIMEOUT_MS}ms.`, 'The bridge may be stuck on a long turn. Try again.');
    } else {
      reportTurnError('NETWORK_ERROR', error.message, 'Check the connection to the bridge and try again.');
    }
  } finally {
    isRecording = false;
    setBusy(false);
  }
}

// WR-03 (05-REVIEW.md): shared token-presence guard so the keyboard-shortcut recording
// path refuses to start the same as the pointer path does — previously only pointerdown
// checked this, letting a tokenless keyboard-triggered turn record, encode, and send
// before being rejected 401 after the fact.
function hasToken() {
  return Boolean(tokenEl.value.trim());
}

ptt.addEventListener('pointerdown', async () => {
  if (isBusy || isRecording) return;
  if (!hasToken()) {
    setStatus('Enter the shared access token first.');
    setHint('The token is saved in this browser after you enter it.');
    return;
  }
  // WR-05 (05-REVIEW.md): getUserMedia() rejects on a denied/missing microphone with no
  // handler here previously — an unhandled rejection with zero visible feedback to the
  // user, the single most common real-world failure mode for a mic app.
  try {
    await ensureRecorder();
  } catch (error) {
    setStatus('Could not access the microphone.');
    setHint(error.message || 'Check microphone permissions and try again.');
    return;
  }
  recordedChunks = [];
  mediaRecorder.start();
  isRecording = true;
  ptt.classList.add('recording');
  ptt.classList.remove('processing');
  ptt.textContent = 'Release to send';
  setStatus('Recording...');
  setHint('Keep holding while you talk.');
});

async function finishRecording() {
  if (!isRecording) return;
  ptt.classList.remove('recording');
  await stopAndSend();
}

ptt.addEventListener('pointerup', finishRecording);
ptt.addEventListener('pointercancel', finishRecording);
ptt.addEventListener('pointerleave', async (event) => {
  if (event.buttons === 1) await finishRecording();
});

window.addEventListener('keydown', async (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !isBusy && !isRecording) {
    event.preventDefault();
    if (!hasToken()) {
      setStatus('Enter the shared access token first.');
      setHint('The token is saved in this browser after you enter it.');
      return;
    }
    try {
      await ensureRecorder();
    } catch (error) {
      setStatus('Could not access the microphone.');
      setHint(error.message || 'Check microphone permissions and try again.');
      return;
    }
    recordedChunks = [];
    mediaRecorder.start();
    isRecording = true;
    ptt.classList.add('recording');
    ptt.textContent = 'Release to send';
    setStatus('Recording...');
    setHint('Recording started from keyboard shortcut. Press Escape to send.');
  } else if (event.key === 'Escape' && isRecording) {
    event.preventDefault();
    await finishRecording();
  }
});
