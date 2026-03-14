const ptt = document.getElementById('ptt');
const transcriptEl = document.getElementById('transcript');
const replyEl = document.getElementById('reply');
const player = document.getElementById('player');
const statusEl = document.getElementById('status');

let mediaRecorder;
let chunks = [];
let stream;

function setStatus(text) {
  statusEl.textContent = text;
}

async function ensureRecorder() {
  if (mediaRecorder) return;
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
}

async function stopAndSend() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  await new Promise((resolve) => {
    mediaRecorder.onstop = resolve;
    mediaRecorder.stop();
  });

  const blob = new Blob(chunks, { type: 'audio/webm' });
  chunks = [];
  setStatus('Transcribing and thinking...');

  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const audioBase64 = btoa(binary);

  const response = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType: blob.type })
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
}

ptt.addEventListener('pointerdown', async () => {
  await ensureRecorder();
  chunks = [];
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
