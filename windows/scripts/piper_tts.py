#!/usr/bin/env python3
# Omi Piper Neural TTS Engine (Turkish & Multilingual)
# High-quality, fast local text-to-speech using Piper 1 / OHF-Voice.

import os
import sys
import io
import wave
import base64
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_DIR = BASE_DIR / "src-tauri" / "piper_models"

HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/"

VOICE_MAP = {
    "tr_TR-dfki-medium": {
        "name": "Türkçe (DFKI)",
        "path": "tr/tr_TR/dfki/medium/tr_TR-dfki-medium"
    },
    "en_US-lessac-medium": {
        "name": "English (US - Lessac)",
        "path": "en/en_US/lessac/medium/en_US-lessac-medium"
    },
    "en_US-amy-medium": {
        "name": "English (US - Amy)",
        "path": "en/en_US/amy/medium/en_US-amy-medium"
    },
    "en_GB-alba-medium": {
        "name": "English (UK - Alba)",
        "path": "en/en_GB/alba/medium/en_GB-alba-medium"
    },
    "de_DE-thorsten-medium": {
        "name": "Deutsch (Thorsten)",
        "path": "de/de_DE/thorsten/medium/de_DE-thorsten-medium"
    },
    "fr_FR-siwis-medium": {
        "name": "Français (Siwis)",
        "path": "fr/fr_FR/siwis/medium/fr_FR-siwis-medium"
    },
    "es_ES-sharvard-medium": {
        "name": "Español (Sharvard)",
        "path": "es/es_ES/sharvard/medium/es_ES-sharvard-medium"
    },
    "it_IT-paola-medium": {
        "name": "Italiano (Paola)",
        "path": "it/it_IT/paola/medium/it_IT-paola-medium"
    },
    "ru_RU-dmitri-medium": {
        "name": "Русский (Dmitri)",
        "path": "ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium"
    },
    "ar_JO-kareem-medium": {
        "name": "العربية (Kareem)",
        "path": "ar/ar_JO/kareem/medium/ar_JO-kareem-medium"
    },
    "pt_BR-faber-medium": {
        "name": "Português (Faber)",
        "path": "pt/pt_BR/faber/medium/pt_BR-faber-medium"
    },
}

DEFAULT_MODEL = "tr_TR-dfki-medium"

def ensure_model(model_id: str):
    info = VOICE_MAP.get(model_id) or VOICE_MAP[DEFAULT_MODEL]
    rel_path = info["path"]
    model_path = MODEL_DIR / f"{model_id}.onnx"
    config_path = MODEL_DIR / f"{model_id}.onnx.json"

    if not config_path.exists() or not model_path.exists():
        import urllib.request
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        if not config_path.exists():
            url = HF_BASE + rel_path + ".onnx.json"
            urllib.request.urlretrieve(url, config_path)
        if not model_path.exists():
            url = HF_BASE + rel_path + ".onnx"
            urllib.request.urlretrieve(url, model_path)

    return model_path, config_path

def synthesize_to_base64(text: str, model_id: str = DEFAULT_MODEL) -> str:
    try:
        from piper import PiperVoice
    except ImportError:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", "piper-tts"])
        from piper import PiperVoice

    model_path, config_path = ensure_model(model_id)
    voice = PiperVoice.load(str(model_path), str(config_path))

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        voice.synthesize_wav(text, wav_file)

    wav_bytes = buf.getvalue()
    return base64.b64encode(wav_bytes).decode("ascii")

def main():
    args = sys.argv[1:]
    model_id = DEFAULT_MODEL
    text = ""

    i = 0
    while i < len(args):
        if args[i] == "--model" and i + 1 < len(args):
            model_id = args[i + 1]
            i += 2
        elif args[i] == "--status":
            info = VOICE_MAP.get(model_id) or VOICE_MAP[DEFAULT_MODEL]
            m_path = MODEL_DIR / f"{model_id}.onnx"
            c_path = MODEL_DIR / f"{model_id}.onnx.json"
            print(json.dumps({
                "ready": m_path.exists() and c_path.exists(),
                "model": model_id,
                "name": info["name"]
            }))
            return
        else:
            text = args[i]
            i += 1

    if not text:
        text = sys.stdin.read().strip()
    if not text:
        sys.exit(0)

    try:
        b64 = synthesize_to_base64(text, model_id)
        sys.stdout.buffer.write(b64.encode("ascii"))
        sys.stdout.buffer.flush()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
