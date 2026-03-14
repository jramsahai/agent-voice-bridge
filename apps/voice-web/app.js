const ptt = document.getElementById('ptt');
const tokenEl = document.getElementById('token');
const toggleTokenEl = document.getElementById('toggle-token');
const clearTokenEl = document.getElementById('clear-token');
const authPillEl = document.getElementById('auth-pill');
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

function humanizeError(error) {
  switch (error) {
    case 'unauthorized':
      return 'Wrong or missing access token.';
    case 'origin not allowed':
      return 'This browser origin is not allowed.';
    case 'host not allowed':
      return 'This host is not allowed.';
    case 'too many requests':
      return 'Slow down a bit and try again.';
    case 'payload too large':
      return 'That recording was too large.';
    case 'transcription returned empty text':
      return 'I heard almost nothing. Try speaking a little louder or longer.';
    case 'internal server error':
      return 'Something broke on the bridge. Try again.';
    default:
      return error || 'Request failed.';
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

async function stopAndSend() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  setBusy(true);
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
    const arrayBuffer = await wavBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const audioBase64 = btoa(binary);

    const response = await fetch('/api/turn', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokenEl.value.trim()}`
      },
      body: JSON.stringify({ audioBase64, mimeType: wavBlob.type })
    });

    const data = await response.json();
    if (!response.ok) {
      setStatus(`Error: ${humanizeError(data.error)}`);
      setHint('Fix the issue and try again.');
      console.error(data);
      return;
    }

    transcriptEl.textContent = data.transcript || '—';
    replyEl.textContent = data.reply || '—';
    if (data.audioBase64) {
      player.src = `data:${data.audioMimeType};base64,${data.audioBase64}`;
      await player.play().catch(() => {});
    }
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
