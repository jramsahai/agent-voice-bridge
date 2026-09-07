# Kokoro TTS service

Small FastAPI wrapper for the local Kokoro ONNX runtime. The voice bridge can call this service instead of spawning the Python TTS wrapper for every turn.

## Setup

Create a Python environment and install dependencies:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r apps/kokoro-tts/requirements.txt
```

The service expects existing Kokoro model files. Configure their paths with environment variables:

```sh
export KOKORO_MODEL="$HOME/.openclaw/models/kokoro/kokoro-v1.0.onnx"
export KOKORO_VOICES="$HOME/.openclaw/models/kokoro/voices-v1.0.bin"
```

## Run

```sh
python apps/kokoro-tts/server.py
```

By default the service binds to `127.0.0.1:4319`.

Security note: this service does not implement its own authentication. Keep it bound to `127.0.0.1` and do not expose port `4319` directly through Tailscale Serve, Funnel, or a public reverse proxy. Remote clients should talk only to the voice bridge, which has the shared-token auth layer.

Useful environment variables:

- `KOKORO_MODEL`: path to `kokoro-v1.0.onnx`
- `KOKORO_VOICES`: path to `voices-v1.0.bin`
- `KOKORO_DEFAULT_VOICE`: default voice, such as `af_heart`
- `KOKORO_BIND_HOST`: bind host, default `127.0.0.1`
- `KOKORO_PORT`: bind port, default `4319`

Point the bridge at the service with `tts.serviceUrl` in `config.local.json` or with `KOKORO_TTS_URL`.

## Spawn fallback

When the service is unreachable the bridge falls back to spawning `tts.command` once per turn. The repo ships that command as `scripts/tts-kokoro`, which runs `apps/kokoro-tts/speak.py` (`<text> <output-wav> [voice]`) under the same venv. It reads `KOKORO_MODEL`, `KOKORO_VOICES`, and `KOKORO_DEFAULT_VOICE` exactly as the service does, and `KOKORO_PYTHON` selects the interpreter (default `~/.openclaw/tts/kokoro-onnx/.venv/bin/python`). It loads the model on every call, so expect a few seconds per turn on this path.
