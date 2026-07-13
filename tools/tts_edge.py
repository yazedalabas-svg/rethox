"""Generate cached neural Arabic narration with word timings.

Reads UTF-8 text from stdin and writes MP3 + JSON metadata. This intentionally
matches the desktop generator's voice and defaults: ar-SA-HamedNeural, +0%, +0Hz.
"""

import argparse
import asyncio
import json
from pathlib import Path
import sys

import edge_tts


def split_text(text: str, max_len: int = 1500):
    chunks, current, current_len = [], [], 0
    for word in text.split():
        extra = len(word) + (1 if current else 0)
        if current and current_len + extra > max_len:
            chunks.append(" ".join(current))
            current, current_len = [word], len(word)
        else:
            current.append(word)
            current_len += extra
    if current:
        chunks.append(" ".join(current))
    return chunks


async def generate(text: str, output: Path, voice: str, rate: str, pitch: str):
    output.parent.mkdir(parents=True, exist_ok=True)
    boundaries = []
    timeline_ms = 0
    with output.open("wb") as audio:
        for text_chunk in split_text(text):
            communicate = edge_tts.Communicate(
                text_chunk,
                voice=voice,
                rate=rate,
                pitch=pitch,
                boundary="WordBoundary",
            )
            chunk_end_ms = timeline_ms
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    start_ms = timeline_ms + round(chunk["offset"] / 10_000)
                    duration_ms = max(1, round(chunk["duration"] / 10_000))
                    end_ms = start_ms + duration_ms
                    boundaries.append(
                        {"text": chunk["text"], "startMs": start_ms, "endMs": end_ms}
                    )
                    chunk_end_ms = max(chunk_end_ms, end_ms)
            timeline_ms = chunk_end_ms

    metadata = {
        "voice": voice,
        "rate": rate,
        "pitch": pitch,
        "durationMs": boundaries[-1]["endMs"] if boundaries else 0,
        "boundaries": boundaries,
    }
    output.with_suffix(".json").write_text(
        json.dumps(metadata, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(metadata, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--voice", default="ar-SA-HamedNeural")
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    args = parser.parse_args()
    # Node writes UTF-8 bytes to the pipe. Decode explicitly because Windows
    # may otherwise expose stdin using the active ANSI/OEM code page.
    text = sys.stdin.buffer.read().decode("utf-8").strip()
    if not text:
        raise SystemExit("No text provided")
    asyncio.run(generate(text, Path(args.out), args.voice, args.rate, args.pitch))


if __name__ == "__main__":
    main()
