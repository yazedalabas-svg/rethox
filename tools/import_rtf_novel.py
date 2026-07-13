from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from striprtf.striprtf import rtf_to_text


def clean_line(value: str) -> str:
    value = value.replace("\u3000", " ").replace("¡¡¡ù", " ")
    value = re.sub(r"[※ù¡]{3,}", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" \t")
    return value


def chapter_title(line: str, number: int) -> str:
    match = re.search(rf"الفصل\s*{number}\s*[-،,:]?\s*(.*)", line)
    suffix = match.group(1).strip(' \"“”[]') if match else ""
    return f"الفصل {number}" + (f" — {suffix}" if suffix else "")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("rtf", type=Path)
    parser.add_argument("store", type=Path)
    args = parser.parse_args()

    raw = args.rtf.read_text(encoding="latin-1")
    text = rtf_to_text(raw, errors="ignore")
    lines = [clean_line(line) for line in text.splitlines()]
    lines = [line for line in lines if len(line) > 1]

    boundaries: list[tuple[int, int, str]] = [(1, 0, f"الفصل 1 — {lines[0]}")]
    cursor = 1
    for number in range(2, 91):
        pattern = re.compile(rf"الفصل\s*{number}(?!\d)")
        found = next(
            (
                index
                for index in range(cursor, len(lines))
                if len(lines[index]) < 320 and pattern.search(lines[index])
            ),
            None,
        )
        if found is None:
            raise RuntimeError(f"Chapter {number} heading was not found")
        boundaries.append((number, found, chapter_title(lines[found], number)))
        cursor = found + 1

    chapters = []
    for offset, (number, start, title) in enumerate(boundaries):
        end = boundaries[offset + 1][1] if offset + 1 < len(boundaries) else len(lines)
        body_start = start + 1
        body = lines[body_start:end]
        sentences = []
        word_total = 0
        for position, paragraph in enumerate(body, start=1):
            words = paragraph.split()
            if not words:
                continue
            word_total += len(words)
            sentences.append(
                {
                    "id": f"rz6-c{number:02d}-p{position:04d}",
                    "position": position,
                    "text": paragraph,
                    "tokens": [],
                }
            )
        chapters.append(
            {
                "id": f"ch-rezero-6-{number:02d}",
                "bookId": "book-rezero-arc-6",
                "title": title,
                "position": number,
                "durationMs": max(1, word_total * 430),
                "isSample": True,
                "sentences": sentences,
            }
        )

    store = json.loads(args.store.read_text(encoding="utf-8"))
    book = {
        "id": "book-rezero-arc-6",
        "slug": "rezero-arc-6-arabic",
        "title": "ري:زيرو — الآرك السادس",
        "author": "نسخة عربية مرخّصة للاستخدام",
        "synopsis": "الآرك السادس كاملًا في قارئ عربي مرتب إلى تسعين فصلًا، مع تحكم بحجم الخط وإمكانية الاستماع إلى الفقرات.",
        "priceMinor": 0,
        "currency": "SAR",
        "genre": "فانتازيا",
        "tags": ["ري:زيرو", "فانتازيا", "رواية مترجمة"],
        "coverTheme": "ember",
        "coverUrl": "/covers/rezero-arc-6.webp",
        "status": "PUBLISHED",
        "rating": 4.9,
        "pageCount": 980,
        "chapters": chapters,
    }
    books = store["books"]
    existing = next(
        (i for i, item in enumerate(books) if item["id"] == book["id"]), None
    )
    if existing is None:
        books.insert(0, book)
    else:
        books[existing] = book
    args.store.write_text(
        json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    paragraph_count = sum(len(chapter["sentences"]) for chapter in chapters)
    print(f"Imported {len(chapters)} chapters and {paragraph_count} paragraphs")


if __name__ == "__main__":
    main()
