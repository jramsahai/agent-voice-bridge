# Contributing

## Setup

- Node.js 20+ (matches the `engines` field in `package.json`)
- macOS host — see the README's macOS-only section for why
- Copy the config template: `cp config/config.example.json config/config.local.json`

For model files, Whisper, the optional Kokoro service, and Tailscale Serve, see
[`SETUP.md`](./SETUP.md) rather than repeating those steps here.

## Tests

```sh
npm test
```

This runs the whole suite via the plain Node test runner (`node --test`). There is no install
step, because the project has zero npm dependencies. That zero-dependency posture is
deliberate and enforced by a test in the suite itself: a pull request that adds a runtime
dependency or introduces a lockfile will fail `test/turn-suite-hygiene.test.js`.

## Scope and non-goals

The current MVP deliberately does not cover:

- full duplex streaming voice
- PSTN / phone integration
- multi-tenant hosting
- fully local LLM stack
- highly polished production auth

See the README's "Non-goals for the current MVP" section for the canonical list.
