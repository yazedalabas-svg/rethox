"""Attach the original PDF cover illustration to each Reverend Insanity volume start."""

from __future__ import annotations

import json
from pathlib import Path

from pypdf import PdfReader


BOOK_ID = "book-reverend-insanity"
VOLUME_STARTS = (1, 200, 406, 650, 1022, 1967)


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def source_directory(books_root: Path) -> Path:
    return next(
        directory
        for directory in books_root.iterdir()
        if directory.is_dir() and len(list(directory.glob("*.pdf"))) == len(VOLUME_STARTS)
    )


def extract_cover(pdf_path: Path) -> bytes | None:
    reader = PdfReader(str(pdf_path))
    images = list(reader.pages[0].images)
    if not images:
        return None
    return max(images, key=lambda image: len(image.data)).data


def main() -> None:
    root = project_root()
    books_root = root / "apps" / "api" / "data" / "books"
    source = source_directory(books_root)
    asset_dir = root / "apps" / "web" / "public" / "reverend-insanity" / "assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    asset_path = asset_dir / "pdf-cover.jpg"
    pdfs = sorted(source.glob("*.pdf"))

    covers = [extract_cover(pdf) for pdf in pdfs]
    cover_data = next((cover for cover in covers if cover), None)
    if not cover_data:
        raise RuntimeError("No embedded illustration was found in the supplied PDFs.")
    if not asset_path.exists() or asset_path.read_bytes() != cover_data:
        asset_path.write_bytes(cover_data)

    illustration = {
        "id": "ri-pdf-cover",
        "src": "/reverend-insanity/assets/pdf-cover.jpg",
        "alt": "رسم الغلاف الأصلي من ملفات PDF لرواية القس المجنون",
        "position": 1,
    }
    attached = 0
    for volume_index, chapter_start in enumerate(VOLUME_STARTS, start=1):
        if not covers[volume_index - 1]:
            continue
        derived_path = source / "derived" / f"volume-{volume_index:02d}.json"
        payload = json.loads(derived_path.read_text(encoding="utf-8"))
        chapter = next(item for item in payload["chapters"] if item["position"] == chapter_start)
        chapter["illustrations"] = [
            item for item in chapter.get("illustrations", []) if item.get("id") != illustration["id"]
        ]
        chapter["illustrations"].insert(0, illustration)
        attached += 1
        derived_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

    seed_path = root / "apps" / "api" / "data" / "deploy-seed.json"
    seed = json.loads(seed_path.read_text(encoding="utf-8"))
    book = next(item for item in seed["books"] if item["id"] == BOOK_ID)
    for volume_index, chapter_start in enumerate(VOLUME_STARTS):
        if not covers[volume_index]:
            continue
        chapter = next(item for item in book["chapters"] if item["position"] == chapter_start)
        chapter["illustrations"] = [illustration]
    seed_path.write_text(json.dumps(seed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"attached illustration to {attached} volume starts: {asset_path}")


if __name__ == "__main__":
    main()
