# Setup

This repo contains the voice bridge app, browser client, adapter code, a Whisper wrapper, and an optional persistent Kokoro TTS service.

It does not include model files, local secrets, local LaunchAgents, or a machine-specific `config/config.local.json`.

## Prerequisites

- Node.js 20+
- Python 3.10+
- OpenClaw CLI available as `openclaw`
- `whisper-cli` from `whisper.cpp`
- macOS `afconvert` for audio conversion
- Tailscale Serve if accessing the browser UI from another device

## Model files

Recommended local layout:

```text
~/.openclaw/models/
  whisper/
    ggml-small.en.bin
    ggml-silero-vad.onnx
  kokoro/
    kokoro-v1.0.onnx
    voices-v1.0.bin
```

The Whisper wrapper defaults to `ggml-small.en.bin` and uses the Silero VAD model when present.

## Local config

Create a local config from the example:

```sh
cp config/config.example.json config/config.local.json
```

Then edit:

- `openclaw.sessionId`
- `security.token`
- `security.expectedHost`
- `security.allowedOrigins`
- `tts.voice` if you want a different Kokoro voice

Keep `config/config.local.json` out of git.

## Whisper STT

The repo includes `scripts/whisper-audio`, which accepts an audio file path and prints transcript text.

Defaults:

- model: `~/.openclaw/models/whisper/ggml-small.en.bin`
- VAD model: `~/.openclaw/models/whisper/ggml-silero-vad.onnx`
- CLI: `whisper-cli`

Override paths if needed:

```sh
export VOICE_BRIDGE_WHISPER_MODEL="/path/to/ggml-small.en.bin"
export VOICE_BRIDGE_WHISPER_VAD_MODEL="/path/to/ggml-silero-vad.onnx"
export WHISPER_CLI="/path/to/whisper-cli"
```

## Kokoro TTS

Install service dependencies:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r apps/kokoro-tts/requirements.txt
```

Run the persistent service:

```sh
python apps/kokoro-tts/server.py
```

The service defaults to `http://127.0.0.1:4319`. The bridge uses `tts.serviceUrl` from config, then `KOKORO_TTS_URL`, then that default.

If the service is not available, the bridge falls back to `tts.command`.

Security note: the Kokoro service does not implement its own authentication. Keep it bound to `127.0.0.1` and do not expose port `4319` directly through Tailscale Serve, Funnel, or a public reverse proxy. Remote clients should talk only to the voice bridge, which has the shared-token auth layer.

## Run the bridge

In one terminal:

```sh
npm run start:kokoro
```

In another:

```sh
npm start
```

Health check:

```sh
curl -H "Host: your-device.your-tailnet.ts.net" http://127.0.0.1:4318/health
```

## Tailscale Serve

For phone/laptop browser access, expose the local bridge with Tailscale Serve:

```sh
tailscale serve --https=443 http://127.0.0.1:4318
```

Then open:

```text
https://your-device.your-tailnet.ts.net/
```

See [`TAILSCALE.md`](./TAILSCALE.md) for more deployment notes.
