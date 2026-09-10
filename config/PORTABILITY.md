# Portability Notes

This project is meant to travel across machines and agent installs, not stay glued to one of either.

## Keep out of the shared repo

Do not commit:
- real shared tokens
- real Tailscale hostnames
- real usernames/home paths
- machine-specific secret material
- local-only deployment configs

## Safe to share

These are fine to keep in the repo:
- `config/config.example.json`
- generic setup docs
- adapter interfaces
- backend/frontend code
- placeholder command paths

## Binary paths

Every external binary is resolved from config, never hardcoded in adapter code:

| Binary | Config key | Fallback |
| --- | --- | --- |
| Agent CLI | `agent.command` | per provider: `OPENCLAW_BIN` then `openclaw` on `PATH`; `HERMES_BIN` then `hermes`; none for `command` |
| STT | `stt.command` | none — required |
| TTS | `tts.command` | none — required |

`config.example.json` ships PATH-relative placeholders. Absolute, machine-specific
paths (e.g. `/opt/homebrew/bin/openclaw` on Apple Silicon Homebrew) belong in
gitignored `config/config.local.json`.

## Current portability assumptions

The MVP currently assumes:
- Node 20+
- a local STT command exists and can transcribe an audio file path
- a local TTS backend exists (currently macOS `say` in the example path)
- Tailscale Serve HTTPS is used for browser mic support

## Future cleanup ideas

- replace macOS-first TTS docs with a fuller backend matrix (`say`, `kokoro-onnx`, Piper, cloud fallback)
- formalize config loading for `config.local.json` vs env vars
- add an install/setup script
- document Linux-specific STT/TTS paths
