const ptt = document.getElementById('ptt');
const tokenEl = document.getElementById('token');
const transcriptEl = document.getElementById('transcript');
const replyEl = document.getElementById('reply');
const player = document.getElementById('player');
const statusEl = document.getElementById('status');

let stream;
let mediaRecorder;
let recordedChunks = [];
let decodeAudioContext;
let isBusy = false;

const TOKEN_STORAGE_KEY = 'voice-bridge-token';
const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
if (savedToken) tokenEl.value = savedToken;
tokenEl.addEventListener('change', () => {
  localStorage.setItem(TOKEN_STORAGE_KEY, tokenEl.value.trim());
});

function setStatus(text) {
  statusEl.textContent = text;
}

function setBusy(nextBusy) {
  isBusy = nextBusy;
  ptt.disabled = nextBusy;
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
  if (channels === 1) {
    return audioBuffer.getChannelData(0);
  }
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
    const wavBlob = await blobToWav(blob);
    setStatus('Transcribing and thinking...');

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
      setStatus(`Error: ${data.error || 'request failed'}`);
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
  } finally {
    setBusy(false);
  }
}

ptt.addEventListener('pointerdown', async () => {
  if (isBusy) return;
  if (!tokenEl.value.trim()) {
    setStatus('Enter the shared access token first.');
    return;
  }
  await ensureRecorder();
  recordedChunks = [];
  mediaRecorder.start();
  ptt.classList.add('recording');
  setStatus('Recording... release to send.');
});

async function finishRecording() {
  ptt.classList.remove('recording');
  await stopAndSend();
}

ptt.addEventListener('pointerup', finishRecording);
ptt.addEventListener('pointercancel', finishRecording);
ptt.addEventListener('pointerleave', async (event) => {
  if (event.buttons === 1) await finishRecording();
});
