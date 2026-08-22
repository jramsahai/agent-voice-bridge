# Roadmap

## Phase 0: Design / scaffolding
- [x] Capture architecture
- [x] Define modular boundaries
- [x] Create portable repo layout
- [x] Decide repo/tooling stack

## Phase 1: MVP
- [x] Create `voice-web` push-to-talk UI
- [x] Create bridge service API
- [x] Add local whisper STT adapter
- [x] Add macOS `say` TTS adapter
- [x] Add OpenClaw turn adapter
- [x] Add config schema + example config
- [x] Add Tailscale deployment notes

## Phase 2: Hardening
- [ ] Add auth/session tokens for voice UI
- [ ] Better logging/observability
- [ ] Retry/error UX
- [ ] Audio format normalization cleanup

## Phase 3: Polish
- [ ] Piper adapter
- [ ] Better voice UX
- [ ] Partial transcript UX
- [ ] Packaging/install script

## Questions to resolve
- What is the cleanest OpenClaw API/session path for turn submission?
- Should the first bridge be HTTP upload based or WebSocket based?
- Which frontend stack should be used for the voice UI? Current scaffold uses vanilla browser APIs for speed.
- Should TTS audio be generated to temp files or streamed directly? Current scaffold generates temp files.
