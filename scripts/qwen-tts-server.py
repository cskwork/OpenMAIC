"""Loopback-only OpenAI speech endpoint using the local Qwen3-TTS model."""

import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "Qwen3-TTS-12Hz-1.7B-Base"
# OpenMAIC's OpenAI-compatible adapter defaults to alloy. Both ids designate
# our one original local voice, not any OpenAI-generated voice.
VOICE_ALIASES = {"default", "alloy", "announcer-female-calm-ko"}


def validate_request(body):
    if not isinstance(body, dict):
        raise ValueError("Expected a JSON object")
    if body.get("model", MODEL_ID) != MODEL_ID:
        raise ValueError(f"Only {MODEL_ID} is available")
    text = body.get("input")
    if not isinstance(text, str) or not text.strip() or len(text) > 1000:
        raise ValueError("input must contain 1 to 1000 characters")
    voice = body.get("voice", "default")
    if voice not in VOICE_ALIASES:
        raise ValueError("This local endpoint uses the configured original announcer voice")
    fmt = body.get("response_format", "mp3")
    if fmt not in {"mp3", "wav"}:
        raise ValueError("response_format must be mp3 or wav")
    speed = body.get("speed", 1.0)
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.25 <= speed <= 4:
        raise ValueError("speed must be between 0.25 and 4")
    return text.strip(), fmt, float(speed)


class Synthesizer:
    def __init__(self):
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel

        self.np, self.sf, self.torch = np, sf, torch
        torch.set_num_threads(4)
        self.lock = threading.Lock()
        self.device = os.environ.get("QWEN_TTS_DEVICE", "mps")
        if self.device == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("Apple Silicon MPS is unavailable. Check Metal access or explicitly set QWEN_TTS_DEVICE=cpu.")
        self.ffmpeg = shutil.which("ffmpeg")
        if not self.ffmpeg:
            raise RuntimeError("ffmpeg is required to encode browser-playable speech")
        model_path = Path(os.environ.get("QWEN_TTS_MODEL_PATH", str(Path.home() / ".cache/qwen3-tts-base")))
        profile_path = Path(os.environ["QWEN_TTS_VOICE_PROFILE"])
        profile = json.loads(profile_path.read_text())
        self.voice_id = profile["id"]
        reference = profile_path.parent / "voices" / Path(profile["reference_audio"]).name
        if hashlib.sha256(reference.read_bytes()).hexdigest() != profile["reference_sha256"]:
            raise RuntimeError("Original voice reference does not match its approved profile")
        self.identity = hashlib.sha256((model_path / "config.json").read_bytes() + profile_path.read_bytes()).hexdigest()
        self.cache = ROOT / "data/qwen-tts-cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        print(f"Loading local {MODEL_ID} on {self.device}", flush=True)
        self.model = Qwen3TTSModel.from_pretrained(
            str(model_path), device_map=self.device, dtype=torch.float32,
            attn_implementation="sdpa", local_files_only=True,
        )
        self.prompt = self.model.create_voice_clone_prompt(
            str(reference), ref_text=profile["reference_text"],
            x_vector_only_mode=profile["clone_mode"] == "speaker_embedding_only",
        )

    def generate(self, text, fmt, speed):
        key = hashlib.sha256(json.dumps([self.identity, text, fmt, speed], ensure_ascii=False).encode()).hexdigest()
        destination = self.cache / f"{key}.{fmt}"
        if not self.lock.acquire(timeout=120):
            raise TimeoutError("Local speech queue is busy; retry after the current request completes")
        try:
            if destination.exists():
                return destination.read_bytes(), True
            started = time.monotonic()
            language = "Korean" if re.search("[가-힣]", text) else "English" if text.isascii() else "Auto"
            with self.torch.inference_mode():
                waves, sr = self.model.generate_voice_clone(
                    text=text, language=language, voice_clone_prompt=self.prompt,
                    non_streaming_mode=True, max_new_tokens=3072,
                )
            wave = self.np.asarray(waves[0], dtype=self.np.float32)
            if wave.size < sr * 0.2 or not self.np.isfinite(wave).all() or float(self.np.max(self.np.abs(wave))) < 0.0001:
                raise RuntimeError("Speech model returned empty, invalid, or silent audio")
            buffer = io.BytesIO()
            self.sf.write(buffer, self.np.clip(wave, -1, 1), sr, format="WAV", subtype="PCM_16")
            audio = buffer.getvalue()
            if fmt == "mp3" or speed != 1:
                args = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-i", "pipe:0"]
                if speed != 1:
                    factors = []
                    remaining = speed
                    while remaining < 0.5:
                        factors.append("atempo=0.5")
                        remaining /= 0.5
                    factors.append(f"atempo={remaining}")
                    args += ["-af", ",".join(factors)]
                args += ["-f", fmt, "pipe:1"]
                audio = subprocess.run(args, input=audio, capture_output=True, check=True, timeout=30).stdout
            temporary = destination.with_suffix(".tmp")
            temporary.write_bytes(audio)
            temporary.replace(destination)
            print(f"Speech generated {len(text)} chars, {wave.size / sr:.1f}s audio, {time.monotonic() - started:.1f}s synthesis", flush=True)
            return audio, False
        finally:
            self.lock.release()


def make_handler(synthesizer, token):
    if len(token) < 32:
        raise ValueError("QWEN_TTS_TOKEN must contain at least 32 characters")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, status, payload, mime="application/json", headers=None):
            if isinstance(payload, dict):
                payload = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def authorized(self):
            if self.headers.get("Origin"):
                self.respond(403, {"error": {"message": "Browser access to the speech backend is disabled"}})
                return False
            if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}"):
                self.respond(401, {"error": {"message": "Unauthorized"}})
                return False
            return True

        def do_GET(self):
            if self.headers.get("Origin"):
                return self.respond(403, {"error": {"message": "Cross-origin requests are disabled"}})
            if self.path == "/health":
                return self.respond(200, {"ok": True, "model": MODEL_ID, "device": synthesizer.device, "voice": synthesizer.voice_id})
            if not self.authorized():
                return
            if self.path == "/v1/models":
                return self.respond(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "local-qwen"}]})
            self.respond(404, {"error": {"message": "Not found"}})

        def do_POST(self):
            if not self.authorized():
                return
            if self.path != "/v1/audio/speech":
                return self.respond(404, {"error": {"message": "Not found"}})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 32_768:
                    return self.respond(413, {"error": {"message": "Request must be between 1 byte and 32 KiB"}})
                self.connection.settimeout(15)
                text, fmt, speed = validate_request(json.loads(self.rfile.read(size)))
            except (ValueError, TypeError):
                return self.respond(400, {"error": {"message": "Invalid speech request: supply model, input, supported voice, format and speed"}})
            try:
                audio, cached = synthesizer.generate(text, fmt, speed)
                self.respond(200, audio, "audio/mpeg" if fmt == "mp3" else "audio/wav", {"X-Qwen-Voice": synthesizer.voice_id, "X-Qwen-Cache": "hit" if cached else "miss"})
            except TimeoutError as error:
                self.respond(503, {"error": {"message": str(error)}})
            except Exception as error:
                print(f"Speech generation failed: {type(error).__name__}: {error}", flush=True)
                self.respond(502, {"error": {"message": "Local speech generation failed. Check logs/local.log."}})

    return Handler


def main():
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    synthesizer = Synthesizer()
    port = int(os.environ.get("QWEN_TTS_PORT", "57441"))
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(synthesizer, os.environ["QWEN_TTS_TOKEN"]))
    print(f"Local speech ready at http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
