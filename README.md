# OpenClaw Voice Bridge

A modular, portable voice companion for OpenClaw focused on private, remote, push-to-talk conversations over Tailscale.

## What it is

This project provides a small browser-based voice client and a local bridge service that lets you talk to an OpenClaw agent from other devices on your tailnet.

Current shape:
- browser push-to-talk UI
- local bridge service on the OpenClaw host
- local STT via `whisper-cpp` wrapper
- OpenClaw turn handoff via `openclaw agent`
- switchable local TTS backends:
  - `macos-say`
  - `kokoro-onnx`
- tailnet-only access via Tailscale Serve HTTPS

## Current status

This repo now contains a working MVP that has been exercised across multiple devices.

Working today:
- remote voice access from laptop and phone over Tailscale
- browser mic capture in a secure context
- local transcription on the host machine
- dedicated OpenClaw session handoff for voice turns
- local TTS reply playback in the browser
- first security pass:
  - shared token auth
  - expected host validation
  - allowed-origin checks
  - request size limits
  - simple rate limiting
  - safer client-facing errors
- initial UX polish:
  - saved token handling
  - clearer status/hints
  - improved busy/recording states
  - mobile-friendly push-to-talk button sizing

This is still an MVP, but it is no longer just a scaffold.

## Architecture at a glance

```text
Phone / Laptop Browser
        ↓
Tailscale Serve HTTPS
        ↓
Voice Bridge Service
        ↓
- STT adapter (local whisper wrapper)
- OpenClaw adapter
- TTS adapter (`macos-say` or `kokoro-onnx`)
        ↓
OpenClaw session reply
        ↓
Audio + text back to browser
```

## Goals

- Real-time-ish two-way voice from anywhere
- Tailscale-first private access
- Local speech-to-text by default
- Swappable text-to-speech backends
- Minimal coupling to any single OpenClaw install
- Portable enough to reuse on another machine or share with a friend

## Core modules

### `apps/voice-web`
- push-to-talk UI
- transcript/reply display
- browser audio playback
- token entry and lightweight UX state

### `apps/voice-bridge`
- accepts uploaded turn audio
- runs STT adapter
- calls OpenClaw
- runs TTS adapter
- returns text + audio payloads

### `packages/shared/adapters`
- STT adapters
- TTS adapters
- OpenClaw integration layer

## Current adapters

### STT
- `whisper-local`
  - expected shape: a local command that accepts an audio file path and prints transcript text

### TTS
- `macos-say`
  - simple local fallback
- `kokoro-onnx`
  - higher-quality local voice path
  - integrated through a local wrapper command so the bridge can stay runtime-agnostic

### OpenClaw
- `openclaw agent --json`
- uses a dedicated explicit session id so voice turns do not contend with the main chat lane

## Configuration

The project uses:
- `config/config.example.json` as the shareable template
- `config/config.local.json` for local machine-specific deployment values

Example shape:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4318
  },
  "openclaw": {
    "sessionId": "voice-bridge-mvp",
    "thinking": "low"
  },
  "stt": {
    "provider": "whisper-local",
    "command": "/Users/you/bin/whisper-audio"
  },
  "tts": {
    "provider": "kokoro-onnx",
    "command": "/Users/you/bin/tts-kokoro",
    "voice": "af_heart"
  },
  "security": {
    "token": "replace-with-a-shared-secret",
    "expectedHost": "your-device.your-tailnet.ts.net",
    "allowedOrigins": [
      "https://your-device.your-tailnet.ts.net"
    ],
    "maxJsonBytes": 2000000,
    "rateLimitWindowMs": 15000,
    "rateLimitMaxRequests": 6
  }
}
```

## Tailscale deployment model

The currently tested deployment pattern is:
- bridge binds to `127.0.0.1:4318`
- Tailscale Serve exposes it over tailnet HTTPS
- browser accesses the app through `https://<device>.<tailnet>.ts.net/`

Why this matters:
- browser microphone APIs require a secure context
- plain HTTP to a tailnet IP loaded the page but did not expose `navigator.mediaDevices`
- Tailscale Serve HTTPS solved that cleanly

See [`TAILSCALE.md`](./TAILSCALE.md) for deployment notes.

## Portability and hygiene

Keep machine-specific details out of the shared repo.

Do not commit:
- real shared tokens
- real Tailscale hostnames
- real usernames or home paths
- local-only deployment configs
- durable model/runtime state under `~/.openclaw`

See [`config/PORTABILITY.md`](./config/PORTABILITY.md) for more.

## Project structure

```text
voice-bridge/
  README.md
  ARCHITECTURE.md
  ROADMAP.md
  TAILSCALE.md
  config/
    config.example.json
    PORTABILITY.md
  apps/
    voice-web/
    voice-bridge/
  packages/
    shared/
      config/
      adapters/
```

## Non-goals for the current MVP

- full duplex streaming voice
- PSTN / phone integration
- multi-tenant hosting
- fully local LLM stack
- highly polished production auth

## Next likely improvements

- better secret handling / token rotation
- optional warm persistent Kokoro service for lower latency
- stronger install/setup automation
- more polished voice UX and TTS tuning
- broader portability cleanup for non-macOS hosts
