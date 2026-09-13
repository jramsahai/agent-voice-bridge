# Roadmap

What has shipped, what is next, and the questions the early scaffold left open, with
their answers. The README's "Next likely improvements" is the short form of the open list.

## Shipped

- Push-to-talk browser client, local Whisper STT, switchable TTS (`macos-say`, `kokoro-onnx`
  with an optional persistent Kokoro service and a spawn fallback)
- Versioned HTTP API (`docs/API.md`): `POST /v1/turn`, `GET /v1/capabilities`,
  `GET /v1/health`, implementable with raw HTTP and PCM buffers
- Reference CLI client (`apps/voice-cli`) that completes a turn with no browser, no codecs
- An ESP32-S3 handheld built from the API document alone, reaching the bridge over Tailscale
- Per-client bearer tokens, Host and Origin validation, sliding-window rate limits, payload
  caps, structured error envelopes that never leak internals
- Audio format negotiation and normalization, stage timeouts derived into a published client
  read-timeout floor, per-session turn lock, temp-file hygiene, graceful shutdown
- Startup config validation and preflight reachability checks
- Voice-mode session priming once per session, speech cleanup of replies (markdown, emoji)
- Agent providers behind one adapter seam: `openclaw`, `hermes`, and a generic `command`

## Open

- Verify the `hermes` provider against a real install (written from the CLI reference)
- Linux support: an `ffmpeg` path beside `afconvert`, a non-macOS system TTS, CI on Linux
- Piper or another local TTS backend
- Install and setup automation (a script that lays down model files, config, and the
  launchd or systemd service)
- Token rotation and per-client revocation without a restart
- Partial transcript and interruption UX; the backend stages are batch-only today, so this
  is a client-side affordance until an STT stage can stream

## Decisions the scaffold left open, now settled

- **Turn submission is HTTP upload per turn, not WebSocket.** A device with no TLS stack
  and no JSON parser can still complete a turn, which the handheld proved.
- **The browser client stays vanilla.** No framework; it is one reference client among
  several, and the API document is the product.
- **TTS audio goes through temp files, cleaned per turn.** The persistent Kokoro service
  removed the cost that streaming would have addressed.
- **The agent is reached through its CLI, one process per turn.** Session continuity is the
  agent's own (`--session-id`, `--resume`), primed once by the bridge.
