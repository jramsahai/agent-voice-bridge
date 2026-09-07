#!/usr/bin/env python3
"""One-shot Kokoro synthesis: the bridge's spawn fallback when the FastAPI service is down.

Usage: speak.py <text> <output-wav> [voice]

Loads the model on every call, so this is slow (seconds) compared with server.py — it
exists so a turn still completes when the persistent service is unreachable.
"""

import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro


MODEL_PATH = os.environ.get(
    "KOKORO_MODEL",
    os.path.expanduser("~/.openclaw/models/kokoro/kokoro-v1.0.onnx"),
)
VOICES_PATH = os.environ.get(
    "KOKORO_VOICES",
    os.path.expanduser("~/.openclaw/models/kokoro/voices-v1.0.bin"),
)
DEFAULT_VOICE = os.environ.get("KOKORO_DEFAULT_VOICE", "af_heart")


def main(argv):
    if len(argv) < 3:
        print("usage: speak.py <text> <output-wav> [voice]", file=sys.stderr)
        return 2
    text, out_path = argv[1], argv[2]
    voice = argv[3] if len(argv) > 3 and argv[3] else DEFAULT_VOICE
    if not text.strip():
        print("speak.py: text is empty", file=sys.stderr)
        return 2

    kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
    audio, sample_rate = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
    sf.write(out_path, audio, sample_rate, format="WAV", subtype="PCM_16")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
