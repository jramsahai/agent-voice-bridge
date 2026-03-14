# Portability Notes

This project is meant to travel across OpenClaw installs, not stay glued to one machine.

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

## Current portability assumptions

The MVP currently assumes:
- Node 20+
- a local STT command exists and can transcribe an audio file path
- a local TTS backend exists (currently macOS `say` in the example path)
- Tailscale Serve HTTPS is used for browser mic support

## Future cleanup ideas

- replace macOS-first TTS docs with a backend matrix (`say`, Piper, cloud fallback)
- formalize config loading for `config.local.json` vs env vars
- add an install/setup script
- document Linux-specific STT/TTS paths
