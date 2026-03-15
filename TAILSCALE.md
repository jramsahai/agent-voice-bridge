# Tailscale Setup

This project is currently tested as a **tailnet-only** remote voice app using **Tailscale Serve**.

## Why Tailscale Serve

Browser microphone APIs require a **secure context**.
A plain `http://100.x.y.z:4318` tailnet URL loaded the app, but did **not** expose `navigator.mediaDevices` in the browser.

Using **Tailscale Serve over HTTPS** fixed that.

## Current working shape

- Voice bridge process binds to:
  - `127.0.0.1:4318`
- Tailscale Serve exposes it at:
  - `https://your-device.your-tailnet.ts.net/`
- Access is restricted to the tailnet

## Enable Serve

If Serve is not enabled on the tailnet yet, Tailscale prints a link like:

```text
https://login.tailscale.com/f/serve?node=<node-id>
```

Open that once and enable Serve for the node.

## Start the voice bridge

```bash
cd voice-bridge
node apps/voice-bridge/server.js
```

The local config should bind to loopback:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4318
  }
}
```

## Publish it to the tailnet

```bash
tailscale serve --bg 4318
```

Check status:

```bash
tailscale serve status
```

Expected shape:

```text
https://<device>.tailnet.ts.net/
|-- / proxy http://127.0.0.1:4318
```

## Test flow

1. Open the HTTPS Tailscale URL from another tailnet device.
2. Enter the shared access token configured in your local deployment config.
3. Grant microphone permission.
4. Hold the push-to-talk button.
5. Speak and release.
6. Confirm transcript + reply audio come back.

## Config hygiene

- Keep machine-specific values in `config/config.local.json` (or your own untracked deployment config).
- Do **not** commit real tokens, real hostnames, or user-specific filesystem paths.
- Keep `config/config.example.json` generic and safe to share.

## First security pass

The current MVP now includes:
- shared bearer-token access to `/api/turn`
- expected host validation
- allowed-origin checks
- request size limits
- simple per-IP rate limiting
- safer client-facing errors (no stack traces returned to browser)

## TTS backends

The bridge now supports switchable TTS backends via config:
- `macos-say`
- `kokoro-onnx`

For Kokoro ONNX, the local deployment used in this setup is a wrapper script (for example `~/bin/tts-kokoro`) backed by a durable local runtime under `~/.openclaw`.

## Notes

- Ping/ICMP may still fail if the host firewall + stealth mode are enabled.
  That does **not** necessarily mean the Tailscale app URL is broken.
- Tailnet HTTPS access is the thing that matters for browser mic support.
- For MVP, this setup is intentionally private and avoids public exposure.
