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

The body is the transcript segment, then the reply segment, then — when `X-Voice-Audio-Present` is `1` — the audio segment. The three segments are concatenated with **no delimiter of any kind**. A client slices them by byte offset using the two byte-count headers; scanning the body for a separator is wrong and will corrupt the reply. The segment order is fixed and never varies.

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

The `X-Error-Code` response header carries the same code as `error.code`, so a client with no JSON parser can still branch on the failure without touching the body. `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-transform`, and `X-API-Version` ride on every response, including every error.

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
