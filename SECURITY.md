# Security Policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub's private vulnerability reporting on this
repository: go to the Security tab and choose "Report a vulnerability", or open
`https://github.com/jramsahai/agent-voice-bridge/security/advisories/new` directly.

**Do not report a vulnerability as a public issue.** A public issue is visible to everyone
before a fix exists.

## Supported versions

`git tag --list` on this repository currently returns one tag, `v1.0`. The default branch
carries ongoing work past that tag. Until a second tagged release exists, treat the latest
commit on the default branch as the supported version; `v1.0` receives no separate backport
stream.

## Trust boundary

Every claim below has been verified against the source at the file cited. If you believe one
of these claims is inaccurate, that itself is worth reporting.

- **TLS is never terminated by this service.** It binds plain HTTP; a reverse proxy (Tailscale
  Serve in the shipped deployment, or Caddy) owns encryption. Exposing the origin outside a
  trusted network without proxy-terminated TLS puts both the bearer token and the audio on the
  wire in the clear. Source: `docs/API.md` ("Deployment requirements": "the service binds
  plain HTTP and never terminates TLS"), `TAILSCALE.md`.

- **The Kokoro TTS service has no authentication of its own** and must stay bound to
  `127.0.0.1`; port `4319` must not be exposed via Tailscale Serve, Funnel, or any public
  proxy. Remote clients talk only to the bridge. Source: `apps/kokoro-tts/README.md`,
  `SETUP.md`.

- **Per-client bearer tokens** live in `security.clients` (a map of client name to token, one
  per device), so a single device's token can be revoked without touching the others.
  Comparison is timing-safe: the received token is hashed to a fixed 32-byte SHA-256 digest
  and compared against every configured candidate with `timingSafeEqual`, with no early exit
  on match, so total elapsed time does not reveal which candidate matched. Source:
  `packages/shared/security/token-auth.js`.

- **Startup config validation** rejects a missing/empty `security.clients`, a token shorter
  than the minimum length, a token still carrying the shipped example placeholder prefix,
  duplicate tokens across clients, and the removed singular `security.token` key. Source:
  `packages/shared/config/validate-config.js`.

- **Host and Origin validation.** `security.expectedHost` (a string or a list) is matched by
  exact normalized equality — lowercased, with only `:80`/`:443` stripped — with no wildcard
  or prefix matching, so widening it cannot admit a host the operator did not literally type.
  `security.allowedOrigins` is an exact-match set. Host and Origin failures deliberately
  collapse to the same `FORBIDDEN` code so a caller is not told which check it failed. Source:
  `apps/voice-bridge/request-handler.js`.

- **Rate limiting**, four sliding-window budgets keyed by resolved client identity, never by
  source address (so the bucket map cannot grow unboundedly under a spoofed-address flood):
  the turn endpoint (default 6 requests / 15 s, configurable via `security.rateLimitWindowMs`
  and `security.rateLimitMaxRequests`), a separate discovery budget for `GET /v1/capabilities`
  and `GET /v1/health` (60 / 60 s) so polling cannot drain the turn budget, and a single
  fixed-key failed-auth bucket (20 / 60 s) that throttles bad tokens and bad Host/Origin
  alike. Source: `packages/shared/security/rate-limit.js`.

- **Payload size limit.** A turn request body is capped at 9,600,000 bytes — five minutes of
  16 kHz mono s16le — rejected from the declared `Content-Length` before any body byte is
  read, and again as the stream is consumed. Source: `packages/shared/audio/wav.js`
  (`MAX_PCM_BYTES`), `packages/shared/transport/turn-response.js`.

- **`GET /` and `GET /app.js` are deliberately ungated** — no bearer token, no Host/Origin
  check, no rate limit. They serve the browser client's HTML and script. Only the three
  `/v1/*` routes are gated. Source: `docs/API.md` Routes table.

Error responses never leak an internal message, path, or stack — unrecognized failures
collapse to a fixed `INTERNAL_ERROR` title (`apps/voice-bridge/request-handler.js`). Also,
`config/config.local.json` is gitignored and must never be committed
(`config/PORTABILITY.md`).
