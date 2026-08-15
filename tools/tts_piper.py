"""Generate Arabic narration locally with Piper (ONNX, CPU-only).

Reads UTF-8 text from stdin and writes MP3 + JSON metadata, matching the
contract of tts_edge.py so the API can treat both engines the same way.

Piper does not report word boundaries, so metadata is written with an empty
`boundaries` list; the API then derives per-word timings from the audio length.
"""

import argparse
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

from piper import PiperVoice


def synthesize_wav(text: str, wav_path: Path, model_path: Path) -> None:
    voice = PiperVoice.load(str(model_path))
    with wave.open(str(wav_path), "wb") as wav_file:
        voice.synthesize_wav(text, wav_file)


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--voice-dir", required=True)
    args = parser.parse_args()

    text = sys.stdin.buffer.read().decode("utf-8").strip()
    if not text:
        raise SystemExit("No text provided")

    model_path = Path(args.voice_dir) / f"{args.voice}.onnx"
    if not model_path.exists():
        raise SystemExit(f"Piper voice model not found: {model_path}")

    output = Path(args.out)
    with tempfile.TemporaryDirectory() as work_dir:
        wav_path = Path(work_dir) / "narration.wav"
        synthesize_wav(text, wav_path, model_path)
        duration_ms = wav_duration_ms(wav_path)
        wav_to_mp3(wav_path, output)

    metadata = {
        "voice": args.voice,
        "engine": "piper",
        "durationMs": duration_ms,
        # Piper reports no word boundaries; the API estimates them from length.
        "boundaries": [],
    }
    output.with_suffix(".json").write_text(
        json.dumps(metadata, ensure_ascii=False), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
