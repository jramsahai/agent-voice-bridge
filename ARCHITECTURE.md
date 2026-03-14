# Architecture

## High-level flow

```text
Phone/Laptop Browser
        ↓
   Tailscale Tailnet
        ↓
     Voice Web UI
        ↓
   Voice Bridge Service
        ↓
 ┌──────────────────────────┐
 │ Host running OpenClaw    │
 │ - OpenClaw gateway       │
 │ - local STT              │
 │ - local/optional TTS     │
 │ - bridge service         │
 └──────────────────────────┘
        ↓
    LLM provider
```

## Turn-based conversation flow

1. User holds push-to-talk button.
2. Web client records a short utterance.
3. Client uploads the audio turn to the bridge.
4. Bridge passes audio to STT adapter.
5. STT adapter returns transcript text.
6. Bridge sends transcript to OpenClaw adapter.
7. OpenClaw returns reply text.
8. Bridge passes reply text to TTS adapter.
9. TTS adapter returns playable audio.
10. Client receives transcript, reply text, and audio.

## Module boundaries

### 1. Web Client
Responsibilities:
- mic capture
- push-to-talk interaction
- transcript/reply display
- playback of TTS response

Should not know:
- machine-specific STT paths
- OpenClaw internal config
- local filesystem details

### 2. Voice Bridge Service
Responsibilities:
- request/session orchestration
- temp audio handling
- adapter invocation
- response packaging
- auth/session enforcement

Should not hardcode:
- one STT backend
- one TTS backend
- one OpenClaw endpoint layout

### 3. Adapter Layer
Common interfaces:
- `transcribe(input) -> { text, meta }`
- `reply(input) -> { text, meta }`
- `speak(input) -> { audioPath|audioBuffer, meta }`

### 4. Config Layer
All environment-specific concerns should live in config:
- Tailscale host/bind info
- OpenClaw gateway URL/token
- STT command paths/models
- TTS backend/voice
- temp directories
- session defaults

## Security model

- Tailscale is the network boundary.
- The voice bridge should be exposed only on the tailnet by default.
- Separate the voice bridge from the Control UI surface.
- Prefer dedicated auth/session tokens for the voice client.
- Do not bake personal secrets into the repo.

## Packaging strategy

Design first as a standalone companion app with clean adapters.
That makes it easier to:
- reuse on another OpenClaw install
- share with a friend
- later convert pieces into an OpenClaw plugin if that becomes cleaner

## Suggested future phases

### MVP
- Push-to-talk web UI
- local whisper STT
- macOS `say` TTS
- single-user session flow

### Phase 2
- better local TTS (Piper)
- improved latency
- session selection/history

### Phase 3
- semi-streaming / partial transcript UX
- interruption handling
- Linux portability
