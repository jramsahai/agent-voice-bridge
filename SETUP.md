# Setup

This repo contains the voice bridge app, browser client, adapter code, a Whisper wrapper, and an optional persistent Kokoro TTS service.

It does not include model files, local secrets, local LaunchAgents, or a machine-specific `config/config.local.json`.

## Prerequisites

- Node.js 20+
- Python 3.10+
- An agent CLI: OpenClaw on `PATH` as `openclaw` (or `agent.command` / `OPENCLAW_BIN`), Hermes as `hermes` (or `agent.command` / `HERMES_BIN`), or any command that takes a prompt and prints a reply — see "Pick your agent" below
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

- `agent.provider`, `agent.sessionId`, and `agent.command` — see "Pick your agent" below
- `security.clients` — a map of client name to token, one entry per device; the shipped placeholder tokens are rejected at startup
- `security.expectedHost` — one hostname (a plain string, still accepted) or a list of hostnames. A client reaching the bridge directly on a non-default port needs its own entry carrying that port, because the `Host` header it sends carries the port.
- `security.allowedOrigins`
- `tts.voice` if you want a different Kokoro voice

Keep `config/config.local.json` out of git.

## Pick your agent

The `agent` block selects which CLI answers each voice turn. `agent.sessionId` is always
required: it keys the per-session turn lock, and for the two session-aware providers it also
names the conversation every turn resumes.

| `agent.provider` | What runs per turn | Notes |
| --- | --- | --- |
| `openclaw` (default) | `openclaw agent --message <text> --json --session-id <sessionId>` | `agent.thinking` is forwarded as `--thinking`. `agent.command` defaults to `openclaw` on `PATH`, or `OPENCLAW_BIN`. Exercised daily. |
| `hermes` | `hermes chat -Q --oneshot -q <text> --resume <sessionId>` | Written from the Hermes CLI reference, not yet run against a real install. The session named by `sessionId` must already exist. `agent.args` replaces the `chat -Q --oneshot` prefix if your Hermes version's flags differ. `agent.command` defaults to `hermes`, or `HERMES_BIN`. |
| `command` | `agent.command` with `agent.args`; `{text}` in an argument is replaced by the transcript, otherwise the transcript goes to stdin | Stateless: no priming, no resume. Reply is whatever the command prints. Point it at a wrapper script for any other agent. |

The OpenClaw and Hermes providers prime the session once with voice-mode instructions
(`agent.voiceInstructions` overrides the default text) and record that under the OS temp
directory so the priming turn is never resent.

```json
"agent": { "provider": "hermes", "command": "hermes", "sessionId": "voice" }
```

```json
"agent": { "provider": "command", "command": "./my-agent.sh", "args": ["--prompt", "{text}"], "sessionId": "voice" }
```

## Whisper STT

The repo includes `scripts/whisper-audio`, which accepts an audio file path and prints transcript text.
It also includes `scripts/tts-kokoro`, the spawn fallback the bridge uses for speech when the Kokoro service is down; it runs `apps/kokoro-tts/speak.py` under the Kokoro venv (override the interpreter with `KOKORO_PYTHON`).

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
