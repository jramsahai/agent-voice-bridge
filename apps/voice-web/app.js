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
function splitTurnResponse(headers, bytes) {
  const transcriptBytes = Number(headers.get('x-voice-transcript-bytes')) || 0;
  const replyBytes = Number(headers.get('x-voice-reply-bytes')) || 0;
  const audioPresentHeader = headers.get('x-voice-audio-present') === '1';

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
    const response = await fetch('/v1/turn', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenEl.value.trim()}`,
        'x-voice-input-format': 'wav'
      },
      body: requestBody
    });

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

      setStatus(`Error: ${humanizeErrorCode(errorCode, errorMessage)}`);
      setHint('Fix the issue and try again.');
      console.error(errorCode, errorMessage);
      return;
    }

    const { transcript, reply, audioPcm } = splitTurnResponse(response.headers, responseBytes);
    transcriptEl.textContent = transcript || '—';
    replyEl.textContent = reply || '—';

    if (audioPcm) {
      if (lastPlayerObjectUrl) {
        URL.revokeObjectURL(lastPlayerObjectUrl);
      }
      const replyWavBlob = wrapPcmAsWavBlob(audioPcm);
      lastPlayerObjectUrl = URL.createObjectURL(replyWavBlob);
      player.src = lastPlayerObjectUrl;
      await player.play().catch(() => {});
    }

    setTurnBusyState(false);
    setStatus('Done.');
    setHint('Press and hold to send another turn.');
  } finally {
    isRecording = false;
    setBusy(false);
  }
}

ptt.addEventListener('pointerdown', async () => {
  if (isBusy || isRecording) return;
  if (!tokenEl.value.trim()) {
    setStatus('Enter the shared access token first.');
    setHint('The token is saved in this browser after you enter it.');
    return;
  }
  await ensureRecorder();
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
    await ensureRecorder();
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
