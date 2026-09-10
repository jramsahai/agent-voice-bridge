# Agent Voice Bridge

A modular, portable push-to-talk voice bridge for local agent CLIs, focused on private, remote conversations over Tailscale. Speak from a phone, a laptop, or a handheld; the bridge transcribes locally, hands the text to your agent, and speaks the reply back.

See [`docs/API.md`](./docs/API.md) for the versioned HTTP API contract a client can implement against without reading server source.

> **Unofficial, third-party project.** Not affiliated with, endorsed by, or supported by the
> OpenClaw or Hermes projects.

## macOS only

This service runs on **macOS only** and will not run on Linux or Windows. It shells out to
macOS-specific binaries at fixed paths: `/usr/bin/afconvert` for audio format conversion
(the default in `packages/shared/audio/convert.js`), `/usr/bin/say` for the `macos-say` TTS
provider, and two `#!/bin/zsh` wrapper scripts (`scripts/whisper-audio` for local transcription,
`scripts/tts-kokoro` for the Kokoro spawn fallback).
The test suite shells out to the real `/usr/bin/afconvert`, so it does not run on Linux either.
Linux support is on the roadmap, not in the code.

## Supported agents

The bridge talks to the agent through one small adapter per provider, selected by `agent.provider`:

| Provider | Agent | Status |
| --- | --- | --- |
| `openclaw` | [OpenClaw](https://github.com/openclaw/openclaw), via `openclaw agent --json` against a dedicated session | Exercised daily on the author's own setup |
| `hermes` | [Hermes Agent](https://github.com/NousResearch/hermes-agent), via `hermes chat -Q --oneshot -q … --resume …` | Written from the CLI reference; not yet run against a real install |
| `command` | Any executable that takes a prompt and prints a reply | Stateless escape hatch for everything else |

Adding a provider is one file in `packages/shared/adapters/` exposing
`(text, agentConfig, { signal }) → { text, rawText, meta }` plus a branch in `agent.js`. See
[`SETUP.md`](./SETUP.md) for the per-provider config.

## What it is

This project provides a small browser-based voice client and a local bridge service that lets you talk to your agent from other devices on your tailnet.

Current shape:
- browser push-to-talk UI
- a versioned HTTP API (`docs/API.md`) any client can implement against, plus a non-browser reference CLI client (`apps/voice-cli`) proving it
- local bridge service on the agent's host
- local STT via `whisper-cpp` wrapper
- agent turn handoff through a provider adapter (`openclaw`, `hermes`, or any `command`)
- switchable local TTS backends:
  - `macos-say`
  - `kokoro-onnx`
- tailnet-only access via Tailscale Serve HTTPS

## Current status

This repo contains a working MVP that has been exercised across multiple devices.

Working today:
- a published, versioned HTTP API (`docs/API.md`) covering `POST /v1/turn`, `GET /v1/capabilities`, and `GET /v1/health`, implementable with raw HTTP and PCM buffers
- a reference CLI client (`apps/voice-cli`) that completes a full voice turn against that API with no browser, no JavaScript, and no audio codecs — proving the contract before hardware exists
- remote voice access from laptop and phone over Tailscale
- browser mic capture in a secure context
- local transcription on the host machine
- dedicated agent session handoff for voice turns
- local TTS reply playback in the browser
- voice-mode session shaping for better spoken replies:
  - the bridge uses a dedicated agent session for voice turns
  - that session is primed once with voice-mode instructions instead of injecting a fake system prompt into every turn
  - normal turns send only the plain transcript text to the agent
  - TTS receives a speech-cleaned version of the reply while the client can still receive the raw reply text for display/debugging
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
Phone / Laptop Browser, CLI, or handheld
        ↓
Tailscale Serve HTTPS
        ↓
Voice Bridge Service
        ↓
- STT adapter (local whisper wrapper)
- agent adapter (`openclaw`, `hermes`, or `command`)
- TTS adapter (`macos-say` or `kokoro-onnx`)
        ↓
agent session reply
        ↓
Audio + text back to the client
```

## Goals

- Real-time-ish two-way voice from anywhere
- Tailscale-first private access
- Local speech-to-text by default
- Swappable text-to-speech backends
- Swappable agent backends, with no agent-specific logic outside its adapter
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
- calls the agent adapter
- runs TTS adapter
- returns text + audio payloads
- exposes the versioned HTTP API documented in `docs/API.md` (`POST /v1/turn`, `GET /v1/capabilities`, `GET /v1/health`)

### `apps/voice-cli`
- non-browser reference client for the published API
- proves a device with no browser, no JavaScript, and no audio codecs can complete a full voice turn using only raw HTTP and PCM buffers
- see `docs/API.md` for the wire contract it implements

### `apps/kokoro-tts`
- optional persistent FastAPI service for Kokoro ONNX
- loads the TTS model once at startup
- lets the bridge avoid spawning Python for every reply

### `packages/shared/adapters`
- STT adapters
- TTS adapters
- agent adapters (`agent-openclaw-cli.js`, `agent-hermes-cli.js`, `agent-command.js`) behind the `agent.js` selector
- shared session priming (`agent-session.js`) and speech cleanup (`speech-clean.js`)

## Current adapters

### STT
- `whisper-local`
  - expected shape: a local command that accepts an audio file path and prints transcript text

### TTS
- `macos-say`
  - simple local fallback
- `kokoro-onnx`
  - higher-quality local voice path
  - prefers the optional persistent Kokoro service when `tts.serviceUrl` or `KOKORO_TTS_URL` is available
  - falls back to the local wrapper command so the bridge can stay runtime-agnostic

### Agent
- `openclaw`
  - `openclaw agent --json` with a dedicated explicit session id so voice turns do not contend with the main chat lane
- `hermes`
  - `hermes chat -Q --oneshot -q <text> --resume <sessionId>`; the session must already exist
- `command`
  - your executable, `{text}` in `agent.args` or the transcript on stdin, reply on stdout
- for the session-aware providers, the bridge sends a one-time priming turn with voice-mode instructions on first use so replies stay brief, conversational, and speech-friendly; after that, normal turns send only the transcribed user text

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
  "agent": {
    "provider": "openclaw",
    "command": "openclaw",
    "sessionId": "voice-bridge-mvp",
    "thinking": "low"
  },
  "stt": {
    "provider": "whisper-local",
    "command": "./scripts/whisper-audio"
  },
  "tts": {
    "provider": "kokoro-onnx",
    "command": "./scripts/tts-kokoro",
    "serviceUrl": "http://127.0.0.1:4319",
    "voice": "af_heart",
    "voices": ["af_heart"]
  },
  "security": {
    "clients": {
      "browser": "replace-with-the-browser-secret",
      "handheld": "replace-with-the-handheld-secret"
    },
    "expectedHost": [
      "your-device.your-tailnet.ts.net",
      "your-device.your-tailnet.ts.net:4318"
    ],
    "allowedOrigins": [
      "https://your-device.your-tailnet.ts.net"
    ],
    "rateLimitWindowMs": 15000,
    "rateLimitMaxRequests": 6
  }
}
```

A config still using the pre-provider `openclaw` key is migrated in memory to `agent` with
`"provider": "openclaw"` and a startup warning; update the file to silence it.

`security.expectedHost` also still accepts a plain string (one host) — that shape is unchanged.
The list form exists so one configuration can serve both a Tailscale-Serve-fronted browser
(port 443, so the `Host` header carries no port suffix) and a TLS-less client reaching the
bridge directly on its own port, which sends that port in `Host` verbatim and therefore needs
its own entry carrying the suffix.

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
- durable model/runtime state

See [`config/PORTABILITY.md`](./config/PORTABILITY.md) for more.

## Setup

See [`SETUP.md`](./SETUP.md) for a fresh-machine checklist covering model files, local config, the agent provider, Whisper STT, the optional Kokoro service, and Tailscale Serve.

## Project structure

```text
agent-voice-bridge/
  README.md
  ARCHITECTURE.md
  ROADMAP.md
  SETUP.md
  TAILSCALE.md
  docs/
    API.md
  config/
    config.example.json
    PORTABILITY.md
  apps/
    voice-web/
    voice-bridge/
    voice-cli/
    kokoro-tts/
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

## Voice response shaping notes

The current bridge intentionally separates three concerns:

1. **Session behavior**
   - a dedicated voice session is primed once with instructions to keep replies brief, conversational, and speech-friendly
   - the bridge tracks locally whether that dedicated session has already been primed so it does not resend the priming turn on every request

2. **Per-turn handoff**
   - each normal voice turn sends only the transcribed user message to the agent
   - this avoids brittle per-turn fake system prompt injection and keeps the user turn clean

3. **TTS cleanup**
   - before speech playback, the bridge strips markdown and other formatting artifacts that sound bad when spoken
   - the goal is to preserve meaning while making the output sound natural in TTS
   - the cleaned speech text is separate from the raw reply text returned to the client

This architecture produced noticeably better spoken replies than the earlier approach of embedding a pseudo-system prompt into every user turn.

## Next likely improvements

- verify the Hermes provider against a real install
- better secret handling / token rotation
- stronger install/setup automation
- more polished voice UX and TTS tuning
- broader portability cleanup for non-macOS hosts
