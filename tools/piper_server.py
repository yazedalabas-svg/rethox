"""Persistent Piper worker: keeps voice models resident in memory instead of
reloading the ONNX model from disk on every narration request.

The API spawns a small pool of these (see `apps/api/src/piper-pool.ts`) and
keeps them alive for the life of the server. Each process speaks a tiny
line-delimited JSON protocol over stdin/stdout:

  request:  {"id": "...", "voice": "ar_JO-kareem-medium", "text": "...", "out": "/abs/path.mp3"}
  response: {"id": "...", "ok": true}
            {"id": "...", "ok": false, "error": "message"}

Output contract matches `tts_piper.py`: the MP3 is written to `out` and a
sibling `<out>.json` metadata file is written alongside it, so the API's
cache-reading code does not need to know whether the audio came from the
one-shot script or this persistent worker.

A worker never exits on a bad request — one malformed job must not take the
rest of the pool's queue down with it. It exits only on stdin EOF (the parent
closed the pipe) or a fatal, unrecoverable error.
"""

import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

from piper import PiperVoice

# Loaded lazily per voice id and kept for the process lifetime: the first
# request for a voice pays the model-load cost, every later request (from
# any reader, for as long as this worker lives) reuses it for free.
_voice_cache: dict[str, PiperVoice] = {}


def get_voice(voice_id: str, voice_dir: Path) -> PiperVoice:
    cached = _voice_cache.get(voice_id)
    if cached is not None:
        return cached
    model_path = voice_dir / f"{voice_id}.onnx"
    if not model_path.exists():
        raise FileNotFoundError(f"Piper voice model not found: {model_path}")
    voice = PiperVoice.load(str(model_path))
    _voice_cache[voice_id] = voice
    return voice


def wav_to_mp3(wav_path: Path, mp3_path: Path) -> None:
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(wav_path),
            "-codec:a",
            "libmp3lame",
            "-qscale:a",
            "4",
            str(mp3_path),
        ],
        check=True,
    )


def wav_duration_ms(wav_path: Path) -> int:
    with wave.open(str(wav_path), "rb") as wav_file:
        frames = wav_file.getnframes()
        rate = wav_file.getframerate() or 1
    return max(1, round(frames / rate * 1000))


def handle_job(job: dict, voice_dir: Path) -> None:
    voice_id = job["voice"]
    text = job["text"].strip()
    output = Path(job["out"])
    if not text:
        raise ValueError("No text provided")

    voice = get_voice(voice_id, voice_dir)
    with tempfile.TemporaryDirectory() as work_dir:
        wav_path = Path(work_dir) / "narration.wav"
        with wave.open(str(wav_path), "wb") as wav_file:
            voice.synthesize_wav(text, wav_file)
        duration_ms = wav_duration_ms(wav_path)
        wav_to_mp3(wav_path, output)

    metadata = {
        "voice": voice_id,
        "engine": "piper",
        "durationMs": duration_ms,
        # Piper reports no word boundaries; the API estimates them from length.
        "boundaries": [],
    }
    output.with_suffix(".json").write_text(
        json.dumps(metadata, ensure_ascii=False), encoding="utf-8"
    )


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] != "--voice-dir":
        raise SystemExit("usage: piper_server.py --voice-dir <dir>")
    voice_dir = Path(sys.argv[2])

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except json.JSONDecodeError as error:
            # No job id to reply to; note it on stderr and keep serving.
            print(f"piper_server: bad request line: {error}", file=sys.stderr, flush=True)
            continue

        job_id = job.get("id")
        try:
            handle_job(job, voice_dir)
            print(json.dumps({"id": job_id, "ok": True}), flush=True)
        except Exception as error:  # noqa: BLE001 - one bad job must not kill the worker
            print(
                json.dumps({"id": job_id, "ok": False, "error": str(error)}),
                flush=True,
            )


if __name__ == "__main__":
    main()
