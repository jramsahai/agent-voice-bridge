# OpenClaw Voice Bridge

A modular, portable voice companion for OpenClaw focused on private, remote, push-to-talk conversations over Tailscale.

## Goals

- Real-time-ish two-way voice from anywhere
- Tailscale-first private access
- Local speech-to-text by default
- Swappable text-to-speech backends
- Minimal coupling to any single OpenClaw install
- Portable enough to reuse on another machine or share with a friend

## MVP

- Browser-based push-to-talk client
- Voice bridge service on the OpenClaw host
- Local STT adapter (`whisper-cpp` + wrapper)
- OpenClaw adapter for turn-based replies via `openclaw agent`
- Local TTS adapter (start with macOS `say`)
- Config-driven deployment

## Current status

A first runnable scaffold exists now:
- zero-dependency Node server
- simple browser push-to-talk page
- local whisper wrapper adapter
- local macOS `say` adapter
- OpenClaw CLI adapter
- working tailnet-only remote access via Tailscale Serve HTTPS

This is an MVP scaffold, not production-ready voice infra yet.

## Current working MVP notes

- Browser capture currently records with `MediaRecorder`, then converts the blob to WAV in-browser before upload.
- The OpenClaw handoff uses a dedicated explicit session id to avoid contention with the main chat lane.
- The currently tested remote deployment pattern is documented in `TAILSCALE.md`.
- The first security pass adds shared-token gating, origin/host checks, request size limits, and simple rate limiting.
- The current UI includes saved token handling, clearer status/hints, better busy/recording states, and friendlier user-facing errors.
- TTS is now switchable by config between `macos-say` and `kokoro-onnx`, with Kokoro integrated through a local wrapper script.

## Proposed Structure

```text
voice-bridge/
  README.md
  ARCHITECTURE.md
  ROADMAP.md
  config/
    config.example.json
  apps/
    voice-web/
    voice-bridge/
  packages/
    shared/
      types/
      config/
      adapters/
```

## Core Modules

### voice-web
- Push-to-talk UI
- Transcript/reply display
- Audio playback
- Tailscale-accessible browser app

### voice-bridge
- Accepts uploaded/streamed turn audio
- Runs STT adapter
- Calls OpenClaw
- Runs TTS adapter
- Returns text + audio

### shared adapters
- `stt/transcribe(audio) -> text`
- `tts/speak(text) -> audio`
- `openclaw/sendTurn(text, session) -> reply`

## Initial Adapter Targets

### STT
- `whisper-local` (current wrapper-backed local path)

### TTS
- `macos-say`
- later: `piper`

### OpenClaw
- gateway-backed turn submission

## Deployment Model

- Run the bridge on the same machine as OpenClaw
- Expose the voice web app and/or bridge only over Tailscale
- Keep machine-specific paths and secrets in config, not code
- Treat `config/config.example.json` as the shareable template and keep local deployment values in an untracked local config

## Non-Goals for MVP

- full duplex streaming voice
- PSTN/phone support
- perfect local-only LLM/TTS stack
- multi-tenant hosting
