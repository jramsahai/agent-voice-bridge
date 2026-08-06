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
