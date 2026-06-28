#!/usr/bin/env python3
"""Persistent Kokoro TTS service for the voice bridge."""

import io
import os

import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from kokoro_onnx import Kokoro
from pydantic import BaseModel


MODEL_PATH = os.environ.get(
    "KOKORO_MODEL",
    os.path.expanduser("~/.openclaw/models/kokoro/kokoro-v1.0.onnx"),
)
VOICES_PATH = os.environ.get(
    "KOKORO_VOICES",
    os.path.expanduser("~/.openclaw/models/kokoro/voices-v1.0.bin"),
)
DEFAULT_VOICE = os.environ.get("KOKORO_DEFAULT_VOICE", "af_heart")
BIND_HOST = os.environ.get("KOKORO_BIND_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOKORO_PORT", "4319"))

kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
app = FastAPI(title="OpenClaw Kokoro TTS", version="0.1.0")


class TTSRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    speed: float = 1.0
    lang: str = "en-us"


@app.get("/health")
async def health():
    return {"ok": True, "voice": DEFAULT_VOICE}


@app.post("/generate")
async def generate(request: TTSRequest):
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="text is required")

    try:
        audio, sample_rate = kokoro.create(
            request.text,
            voice=request.voice,
            speed=request.speed,
            lang=request.lang,
        )
        buffer = io.BytesIO()
        sf.write(buffer, audio.astype("float32"), sample_rate, format="WAV", subtype="PCM_16")
        buffer.seek(0)
        return Response(content=buffer.getvalue(), media_type="audio/wav")
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error


if __name__ == "__main__":
    import uvicorn

    print(f"Kokoro TTS starting on http://{BIND_HOST}:{PORT}", flush=True)
    uvicorn.run(app, host=BIND_HOST, port=PORT, log_level="warning")
