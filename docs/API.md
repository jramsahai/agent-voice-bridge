# Voice Bridge API

This documents Voice Bridge API version 1 (`X-API-Version: 1`) over plain HTTP — the wire contract a client implements with nothing but raw HTTP and PCM buffers, no JSON parser required for the parts that don't need one.

## Routes

| Method | Path | Auth gate | Rate-limit bucket | Notes |
|--------|------|-----------|--------------------|-------|
| `GET` | `/` | none | none | Serves the browser client's HTML |
| `GET` | `/app.js` | none | none | Serves the browser client's script |
| `POST` | `/v1/turn` | Bearer token, Host and Origin checked | `turn` | Runs one voice turn: transcribe, agent, optional speech |
| `GET` | `/v1/capabilities` | Bearer token, Host and Origin checked | `discovery` | Line-based text listing supported formats, voices, byte ceiling, header names, and API version |
| `GET` | `/v1/health` | Bearer token, Host and Origin checked | `discovery` | Line-based text reporting reachability of the transcribe, agent, and speech backends |
| any other method or path | — | — | — | Returns `404` with code `NOT_FOUND` |

`GET /` and `GET /app.js` are deliberately ungated — no bearer token, no Host/Origin check, no rate limit. Do not infer a uniform bearer-token gate from the rest of this table: only the three `/v1/*` routes require one.

Every gated route expects a request line shaped like this, using only placeholder values from `config/config.example.json` — never a real hostname or token:

```http
GET /v1/capabilities HTTP/1.1
Host: your-device.your-tailnet.ts.net
Authorization: Bearer <your-bearer-token>
```

## Authentication

Every gated route (`POST /v1/turn`, `GET /v1/capabilities`, `GET /v1/health`) requires an `Authorization` header of the form:

```
Authorization: Bearer <token>
```

Tokens are per-client: each client is named and issued its own token in the operator's config (`security.clients`), and revoking one client's token leaves every other client's token working. A missing or invalid credential returns `401 UNAUTHORIZED`.

The `Host` and `Origin` headers are also validated against the operator's configuration. A rejection of either check returns `403 FORBIDDEN` — the same code for both failure modes, deliberately indistinguishable. A client must not attempt to determine which of the two checks failed from the response alone.

### The `Host` header

`Host` must exactly match one of the operator's configured `security.expectedHost` entries. Both sides are normalized before comparison — lowercased, with an explicit `:80` or `:443` suffix stripped — and then compared for exact equality, one entry at a time. There is no wildcard, prefix, or pattern matching: a host the operator did not literally configure is never admitted. An absent `Host` is rejected.

A client sends the hostname it dialed. When the service sits behind a reverse proxy — the deployment shape this project ships, with Tailscale Serve fronting the origin — that is the **proxy's** hostname, not the origin's address, because the proxy forwards the client's `Host` through unchanged. A client reaching the proxy over HTTPS on 443 and a client reaching it over plain HTTP on 80 therefore send the *same* `Host` value, since both standard ports are stripped:

```http
POST /v1/turn HTTP/1.1
Host: your-device.your-tailnet.ts.net
```

A client that addresses the origin directly on its own non-standard port sends that port verbatim (`your-device.your-tailnet.ts.net:4318`), and the operator must have configured that exact string as its own `expectedHost` entry — `security.expectedHost` accepts a list precisely so one configuration can admit both shapes at once.

A `Host` mismatch is a configuration error, not something a client can recover from by retrying or by trying another value. Treat a `403` as terminal and surface it to the operator.

### The `Origin` header

A non-browser client should **omit `Origin` entirely**. The check applies only when the header is present: an absent `Origin` always passes, whatever the operator has configured. The reference command-line client (`apps/voice-cli/cli.js`) sends no `Origin` at all, and an embedded client should do the same.

Do not synthesize a plausible-looking `Origin` value. When the header is present it is matched exactly — no normalization, unlike `Host` — against the operator's `security.allowedOrigins` list, so an invented value is more likely to be rejected than an absent one. `Origin` exists for the browser client, which the browser sets automatically and cannot suppress.

`GET /` and `GET /app.js` are ungated by design — no bearer token, no Host/Origin check — as already stated in the Routes table above.

This section describes the authentication scheme only, not how the server compares a submitted token against its configured candidates.

## Audio formats

| Wire id | Direction | Shape |
|---------|-----------|-------|
| `pcm16` | input and reply | Headerless raw audio: 16000 Hz, mono, signed 16-bit little-endian, no container. |
| `wav` | input only | A RIFF/WAVE container. Sample rate, channel count, and bit depth are declared in the file's own `fmt ` chunk rather than assumed by the server, and it is converted server-side before transcription. |

The input-direction format list and the reply-direction format list are deliberately different. `wav` may be sent as input but is rejected as a reply format — requesting it via `X-Voice-Output-Format: wav` returns `415 FMT_UNSUPPORTED`. A client must not reuse the input format list for the reply direction, or vice versa; query each list independently (`GET /v1/capabilities`'s `input-formats` and `reply-formats` lines each publish the correct one).

## POST /v1/turn — request

`POST /v1/turn` runs one voice turn: transcribe, agent, optional speech.

The request body is raw bytes in the format declared by `X-Voice-Input-Format` — no JSON envelope, no base64 encoding. `Content-Type` is always `application/octet-stream`.

| Header | Values | Behavior when absent |
|--------|--------|------------------------|
| `X-Voice-Input-Format` | Any registered input format id (see Audio formats above: `pcm16`, `wav`) | **No default.** An absent or unregistered value is rejected `415 FMT_UNSUPPORTED`. |
| `X-Voice-Output-Format` | Any reply-direction format id (see Audio formats above: `pcm16`) | Falls back to the default reply format (`pcm16`). |
| `X-Voice-Want-Audio` | Any string | Audio is suppressed only when the value is the literal single character `0`. Any other value — including absent or empty — means audio is wanted. This is a deliberate fail-open: a typo in this header never silently drops the reply audio. |
| `Authorization` | `Bearer <token>` | Missing or invalid returns `401 UNAUTHORIZED`. |
| `Content-Length` | Byte count of the body | The body is capped at `9600000` bytes (5 minutes of 16kHz mono 16-bit PCM). A declared `Content-Length` above the cap is rejected `413 AUDIO_TOO_LARGE` before any body byte is read. |

The `Content-Length` row above describes only the first of two `413 AUDIO_TOO_LARGE` triggers — the declared-length check, which fires before any body byte is read. The same `9600000`-byte ceiling above is also enforced against the running total of bytes actually received as the body streams in, so a client that under-declares `Content-Length`, sends none at all, or uses chunked request framing still meets `413 AUDIO_TOO_LARGE` — this second trigger firing while the request body is still uploading, part-way through the transfer rather than before it starts. When this trigger fires, the server writes the `413` and ends the response while the client may still be writing its request body, so the client's next body write can fail with a broken pipe or a connection reset. Do not treat the broken pipe as terminal: a client must still read the response after a failed body write, because a complete `413 AUDIO_TOO_LARGE` — envelope, `X-Error-Code` header, and all — may already be waiting on the socket. Treating the write failure as the end of the exchange discards the only explanation the server ever sends.

Worked example — a client sending 16kHz mono PCM directly, no container:

```http
POST /v1/turn HTTP/1.1
Host: your-device.your-tailnet.ts.net
Authorization: Bearer <your-bearer-token>
Content-Type: application/octet-stream
X-Voice-Input-Format: pcm16
Content-Length: <n>

<raw 16kHz mono signed 16-bit little-endian PCM bytes follow, exactly <n> of them>
```

## POST /v1/turn — response

A successful turn returns `200` with the following response headers:

| Header | Meaning |
|--------|---------|
| `Content-Type` | Always `application/octet-stream`. |
| `Cache-Control` | Always `no-transform`. |
| `X-API-Version` | The current API version (`1`). |
| `X-Voice-Transcript-Bytes` | UTF-8 byte length of the transcript segment. |
| `X-Voice-Reply-Bytes` | UTF-8 byte length of the reply segment. |
| `X-Voice-Output-Format` | The resolved reply format id — echoes the negotiated `X-Voice-Output-Format`. |
| `X-Voice-Audio-Present` | `1` if an audio segment follows the two text segments, `0` if it does not. |

### Response body framing

The body is the transcript segment, then the reply segment, then — when `X-Voice-Audio-Present` is `1` — the audio segment. The three segments are concatenated with **no delimiter of any kind**. A client slices them by byte offset using the two byte-count headers; scanning the body for a separator is wrong and will corrupt the reply. The segment order is fixed and never varies — this pairs with the parse-by-key rule the two discovery routes below use, where line order is explicitly not a promise.

The two byte-count headers are UTF-8 **byte** lengths, not character or code-point counts. A client must slice by byte offset, never with a character-based string API — a multi-byte character in the transcript or reply would otherwise misalign every following byte.

A body whose total length exactly equals `X-Voice-Transcript-Bytes` plus `X-Voice-Reply-Bytes` carries no audio segment. This exactly-equal case is a valid, complete response, not a truncated one.

The audio segment, when present, is headerless raw bytes in the format named by `X-Voice-Output-Format` — no container, no length prefix. It simply ends when the connection ends.

The response head and both text segments are written to the wire as soon as the transcript and reply are known — before speech synthesis begins. A client receives the text well before the audio and can display it immediately.

Worked example — a `200` response carrying a 2-byte transcript, a 2-byte reply, and an audio segment:

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Cache-Control: no-transform
X-API-Version: 1
X-Voice-Transcript-Bytes: 2
X-Voice-Reply-Bytes: 2
X-Voice-Output-Format: pcm16
X-Voice-Audio-Present: 1

<body: bytes 0-1 are the transcript, bytes 2-3 are the reply, bytes 4 onward are the audio segment>
```

### Reply text is not deterministic

Two turns carrying byte-identical request audio can return different reply text. The reply segment is generated by an agent rather than looked up, so nothing in this contract pins its content to the request. The transcript segment is a transcription of what was said and is stable for identical input; the reply segment is not.

A client must not diff reply text against a fixture. This was measured directly against live backends — byte-identical input produced different replies across runs. A test that asserts on exact reply content is testing the agent's sampling rather than this API, and will fail intermittently against a service that is behaving correctly. Assert on the framing instead: the byte-count headers, the segment boundaries, and the response headers are all pinned and are what this specification actually guarantees.

This says nothing about the byte-count headers' accuracy. `X-Voice-Reply-Bytes` always describes the reply that was actually sent, whatever its content — a varying reply changes the header's value, never its correctness.

## Consuming the response body

`POST /v1/turn` success responses carry **no body-length header at all** — no `Content-Length`, no other header stating the body's total size. The response head is written to the wire as soon as the transcript and reply are known, before speech synthesis starts, so the total body length is genuinely unknown at that moment: the audio byte count depends on TTS output that has not run yet. Node applies chunked `Transfer-Encoding` framing automatically in the absence of a body-length header, and the handler deliberately never sets one — setting either `Content-Length` or `Transfer-Encoding` by hand would defeat that automatic chunking.

A client must implement three consequences of this:

- Do not wait for a body-length header before starting to read the response — none is ever sent.
- Do not compute remaining bytes from a body-length header — there is nothing to subtract from.
- Read until the connection ends. The response is complete when the stream closes, not when some declared byte count is reached.

### Consumption algorithm

Read the response body incrementally, keyed to the two byte-count headers already on the wire (`X-Voice-Transcript-Bytes`, `X-Voice-Reply-Bytes`):

1. Accumulate bytes until the transcript byte count is satisfied, then decode that span as the transcript.
2. Continue accumulating until the reply byte count is satisfied, then decode that span as the reply. Both spans are small and bounded by text length — accumulating them fully before use is fine.
3. If `X-Voice-Audio-Present` carries `1`, stream every subsequent byte straight into a playback or ring buffer as it arrives, rather than accumulating the whole reply in memory first.

The two byte-count headers are **UTF-8 byte counts, not character or code-point counts**. A client must slice the response body by byte offset, never with a character-based string API — a multi-byte character in the transcript or reply would otherwise misalign every byte that follows it, in both the current segment and every segment after it.

### The no-audio case

When `X-Voice-Audio-Present` carries `0`, no audio segment follows the two text segments, and the body's total length equals `X-Voice-Transcript-Bytes` plus `X-Voice-Reply-Bytes` **exactly**. This exactly-equal case is a valid, complete response, not a truncated one — a client must not treat "no bytes after the text segments" as an error or a sign the connection dropped early.

### Recommended read buffer size

A read buffer of **4096 bytes** is recommended, though not required — a client may choose a different size without breaking the wire contract. The figure is grounded in the shipped audio shape: 16000 Hz, mono, 2 bytes per sample is **32000** bytes per second of audio, so a 4096-byte buffer is roughly 128 ms of audio per read. That is large enough to amortise per-read overhead, small enough that RAM footprint stays trivial on an embedded client, and small enough that playback can start after the first buffer rather than waiting for the whole reply.

A client must be prepared to stream a reply of unbounded length — the request byte-count ceiling is not enforced anywhere on the reply/TTS path, so the two directions must not be assumed to share a hard limit. Treat `9600000` bytes (the request ceiling — see the request byte-count ceiling above) as a reasonable buffer-sizing floor, not a guaranteed maximum. A client must stream through that ceiling, never buffer the whole reply in memory to reach it.

The reference command-line client (`apps/voice-cli/cli.js`) implements this by streaming every byte of the audio segment straight to its output sink as it arrives, never accumulating the segment in memory to reach the ceiling above. The browser client (`apps/voice-web/app.js`) deliberately opts out and buffers the whole response instead, trading strict compliance for implementation simplicity because a human is present to retry — the same deliberate opt-out this specification already records for that client's read timeout, below. A client with no human present to retry, the case this specification exists for, must follow the reference CLI's shape rather than the browser's.

## Client read timeout

A client's HTTP read (inactivity) timeout — the maximum gap it tolerates between received bytes, never a total request-duration budget — must be configured to at least **300000 milliseconds** (5 minutes) to receive a `POST /v1/turn` response correctly. Applying this number as a total-duration cap instead of an inactivity gap produces different, wrong behavior: it must only ever be measured against the time since the last received byte, never against elapsed time since the request was sent.

This 300000 ms floor is derived, not chosen. The response head and its first byte are written only after both the transcribe stage (ceiling 120000 ms) and the agent stage (ceiling 180000 ms) resolve — 120000 + 180000 = 300000. The speech (TTS) stage runs only after that first byte is already on the wire, so it is deliberately outside this floor.

A client configured at or above 300000 ms waits out any turn the server is still legally allowed to be working on. A client configured below it can abort a turn the server is still legitimately processing — and because the server never learns the client gave up, there is no server-side error to correlate the failure against. The symptom is an intermittent client-side timeout on long audio or a long reply, against a clean server log.

Real turns measured against live backends took 5,438 ms and 10,274 ms to first byte (a short reply and a 55-second reply, respectively). Cite these as the **typical** case, not the floor: a tighter timeout works almost always, which is exactly what makes a too-tight configuration rare, confusing, and worth over-provisioning against.

The reference command-line client (`apps/voice-cli/cli.js`) ships with its default read timeout set to this same published floor, so it is compliant with the specification it ships alongside. A client may deliberately tighten its timeout below the floor when a human is present to retry — the browser client does exactly this, trading strict compliance for a snappier UI under human supervision.

## GET /v1/capabilities

`GET /v1/capabilities` is the pre-first-turn discovery route: a client calls it before attempting its first turn to learn what the service supports. It requires the same bearer token, `Host`, and `Origin` gate as `POST /v1/turn`, but draws from a separate, more generous discovery rate-limit bucket, so polling it never competes with the turn endpoint's tighter budget. It is **not** covered by the turn lock — it stays answerable while a turn is in flight.

The response is `Content-Type: text/plain; charset=utf-8`. The body is one `key: value` pair per line, deliberately not JSON, so a client with no JSON parser can read it with a single line split. Unlike `POST /v1/turn`, this response carries a real `Content-Length` header, because unlike the turn response this body is fully known before it is ever written — nothing on this route needs chunked framing.

```
api-version: 1
input-formats: pcm16,wav
reply-formats: pcm16
default-reply-format: pcm16
voices: af_heart
max-audio-bytes: 9600000
input-format-header: X-Voice-Input-Format
output-format-header: X-Voice-Output-Format
want-audio-header: X-Voice-Want-Audio
transcript-bytes-header: X-Voice-Transcript-Bytes
reply-bytes-header: X-Voice-Reply-Bytes
```

`voices` is config-dependent — the example above is `config/config.example.json`'s value; an operator's real deployment may list more.

| Key | Meaning |
|-----|---------|
| `api-version` | Same value as the `X-API-Version` response header carried on every route. |
| `input-formats` | Every registered input-direction format id, comma-separated. |
| `reply-formats` | Every registered reply-direction format id, comma-separated — deliberately a different (and possibly shorter) list than `input-formats`; see Audio formats above. |
| `default-reply-format` | The format id used for `X-Voice-Output-Format` when a turn request omits it. |
| `voices` | The operator-configured voice list, comma-separated. Config-dependent. |
| `max-audio-bytes` | The request body size ceiling in bytes — the same threshold that triggers `POST /v1/turn`'s `413 AUDIO_TOO_LARGE`. |
| `input-format-header` | The exact request header name a client uses to declare the input format. |
| `output-format-header` | The exact request header name a client uses to declare the wanted reply format. |
| `want-audio-header` | The exact request header name a client uses to suppress reply audio. |
| `transcript-bytes-header` | The exact response header name carrying the transcript segment's byte length. |
| `reply-bytes-header` | The exact response header name carrying the reply segment's byte length. |

The `input-formats` and `reply-formats` lists are intentionally different — see Audio formats above. A client must query each list independently rather than assume one applies to both directions; a client that reused `input-formats` for the reply direction would offer `wav` as a reply format and be rejected.

A client must parse this body **by key** — splitting each line on the first `: ` — and must not depend on line order. New keys may be appended in a future version without disturbing existing ones.

## GET /v1/health

`GET /v1/health` reports the reachability of the three backends the service depends on. It carries the same bearer/Host/Origin gate and draws from the same discovery rate-limit bucket as `GET /v1/capabilities`, and it is likewise not covered by the turn lock — it stays answerable while a turn is in flight.

The body is exactly three lines, naming the transcribe, agent, and speech backends in that order. Each value is exactly one of two tokens — `up` or `down` — and never anything else. The response status is `200` when all three backends are up, and `503` otherwise.

No URL, command path, probe error text, or any other diagnostic detail ever appears in this body. A client must not expect one and must not parse for one — the three up/down lines are the entire contract.

Backend status is served from a short-TTL cache shared with the live turn path, so polling this route repeatedly does not add a fixed probe penalty per call. The cache interval itself is an internal tuning detail and is not published here.

```
transcribe: up
agent: up
speech: down
```

The same parse-by-key rule applies here as for `GET /v1/capabilities`: split each line on the first `: ` and read by key, never by line position.

## Errors

Every non-2xx response from `POST /v1/turn` and from an unmatched path returns the same JSON envelope, an object under key `error` carrying `code` and `message`:

```json
{
  "error": {
    "code": "FMT_UNSUPPORTED",
    "message": "Requested format 'ogg' is not supported. Supported formats: pcm16, wav."
  }
}
```

The `X-Error-Code` response header carries the same code as `error.code`, so a client with no JSON parser can still branch on the failure without touching the body. `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-transform`, and `X-API-Version` ride on every `POST /v1/turn` and unmatched-path response, including every error (the two discovery routes below render the same code/message pair differently — see below).

That guarantee is about responses **this service's origin** produces — every error `buildError` emits carries `X-Error-Code`. A client will nonetheless meet error responses on the deployed path that carry no `X-Error-Code`, because a proxy in front of the origin can answer a request the origin never receives. If `X-Error-Code` is absent from an error response, it did not come from this service's origin, so no code in the error catalogue describes it, and a client must not branch on the catalogue for it. Do not retry it: a retry re-issues the identical request against a rejection the origin never saw, so the retry loop is unbounded rather than eventually-successful. Treat the response as terminal and surface it to the operator — see Rejections that never reach the origin under Deployment requirements below.

`GET /v1/capabilities` and `GET /v1/health` render the identical `code`/`message` pair as two plain-text lines instead, under `Content-Type: text/plain; charset=utf-8`, still carrying the same `X-Error-Code` header:

```
error-code: UNAUTHORIZED
error-message: Authentication is required or the provided credential is invalid.
```

### Error catalogue

| Code | HTTP status | Meaning |
|------|-------------|---------|
| `FMT_UNSUPPORTED` | 415 | The requested audio format is not supported. |
| `AUDIO_MALFORMED` | 400 | The audio data is malformed or does not match the declared format. |
| `AUDIO_TOO_LARGE` | 413 | The audio payload exceeds the maximum allowed size. |
| `AUDIO_CONVERSION_FAILED` | 500 | Audio conversion failed. |
| `TURN_BUSY` | 409 | Another turn is already in progress. Try again shortly. |
| `TURN_ABORTED` | 499 | The turn was aborted before it could complete. |
| `TRANSCRIPT_EMPTY` | 422 | Transcription returned no text. |
| `UNAUTHORIZED` | 401 | Authentication is required or the provided credential is invalid. |
| `FORBIDDEN` | 403 | The request is not permitted from this host or origin. |
| `RATE_LIMITED` | 429 | Too many requests. Try again shortly. |
| `NOT_FOUND` | 404 | The requested resource does not exist. |
| `INTERNAL_ERROR` | 500 | An internal error occurred while processing the request. |

This catalogue is append-only: once a code is published here, its key and its HTTP status are pinned forever — an existing entry is never redefined, only new entries are appended, and a code is never removed. A client may hard-code its branches against this table.

### Concurrency

A `POST /v1/turn` that arrives while another turn is in progress is rejected immediately with `409 TURN_BUSY`. It is never queued and never interleaved with the in-flight turn — a client should retry rather than wait.

`GET /v1/capabilities` and `GET /v1/health` are not covered by the turn lock. Both stay answerable while a turn is in flight.

`TURN_ABORTED` (499) is recorded server-side when a client disconnects mid-turn; it is a log-reading code only. By definition no client ever receives it over the wire — the connection that would have carried it is already gone.

## Deployment requirements

The service binds plain HTTP and never terminates TLS, by design. A reverse proxy owns encryption — this project's own deployment fronts the origin with Tailscale Serve (see `TAILSCALE.md`), terminating HTTPS at the tailnet edge and forwarding plain HTTP to the origin on loopback. Exposing the origin outside a trusted network without proxy-terminated TLS exposes both the bearer token and the audio in the clear. This is a constraint the operator must resolve with a proxy — it is never presented here as an acceptable way to expose this service on its own.

### Rejections that never reach the origin

The `403 FORBIDDEN` documented above under The `Host` header is what the **origin** returns, for a client that dials the origin directly on its own non-standard port.

This project's shipped deployment sits the origin behind **Tailscale Serve**, which routes by `Host` before it ever opens a connection to the origin, so a `Host` Serve does not recognise is answered by the proxy itself and never reaches the origin at all.

A client dialing this deployment with a bad `Host` observes a `404` carrying no `X-Error-Code` header, no JSON error envelope, and none of the `X-API-Version` / `X-Voice-*` headers this specification otherwise guarantees — none of that is the origin's output.

This is invisible from the server side: the origin never sees the request, so its logs show nothing for it.

The outcome is terminal, not retryable: a retry re-issues the same request against the same proxy-side routing decision, so nothing server-side can ever make it succeed. Surface it to the operator as a `Host` misconfiguration.

This describes the deployment this project ships — Tailscale Serve fronting the origin — and is a property of the proxy layer, not a promise about every reverse proxy a client might sit behind.

### What the origin guarantees

Verified automatically by this repository's own test suite (`test/http-turn.test.js`'s wire-hygiene tests), across every status code a turn can return, not just the success path:

- The origin never issues a redirect.
- The origin never sets a cookie.
- The origin never compresses a response.
- The origin always sends the `no-transform` cache directive exactly once.

### What the operator's reverse-proxy configuration must honour

No test in this repository can reach this half — there is no proxy inside `node --test`, and standing one up is out of scope. The operator's reverse proxy must:

- Not enable compression on the turn endpoint.
- Not issue redirects in front of it.
- Not rewrite, re-buffer, or otherwise transform the response body — re-buffering destroys the streaming property this specification documents, and any transformation invalidates the byte offsets a client slices on.
- Pass through every `X-Voice-*` header and the `X-API-Version` header unmodified — a client that loses the byte-count headers cannot frame the body at all.

**Verification (manual, end-of-phase):** request a real turn through the proxy URL with response headers shown and the raw body preserved, then confirm three things: no `content-encoding` header is present, the status is `200` rather than a `3xx`, and the response body bytes are identical to the origin's own.
