"""Import licensed Arabic PDFs for "وجهة نظر القارئ" into the Rethox catalogue.

The importer deliberately keeps the source PDFs out of git.  It derives the
website assets and one compact content JSON file per source chapter instead.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pypdf import PdfReader


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = PROJECT_ROOT / "apps" / "web" / "public" / "وجهة نظر القارئ"
API_DATA_DIR = PROJECT_ROOT / "apps" / "api" / "data"
DERIVED_DIR = API_DATA_DIR / "books" / "reader-view" / "derived"
PUBLIC_DIR = PROJECT_ROOT / "apps" / "web" / "public"
COVER_PATH = PUBLIC_DIR / "covers" / "reader-view.jpg"
ILLUSTRATIONS_DIR = PUBLIC_DIR / "illustrations" / "reader-view"
SEED_PATH = API_DATA_DIR / "deploy-seed.json"

CHAPTER_MARKER = re.compile(r"(?mi)^\s*(?P<serial>\d{5})-Chapter-(?P<number>\d+)\b")
WHITESPACE = re.compile(r"\s+")
SENTENCE_BREAK = re.compile(r"(?<=[.!؟])\s+")
ONLY_PAGE_ARTIFACT = re.compile(r"^[\d\s\[\](){}*_~=\-–—]+$")


@dataclass
class SourceChapter:
    volume: int
    local_position: int
    position: int
    pages: list[tuple[int, str]] = field(default_factory=list)
    image_pages: list[int] = field(default_factory=list)


def pdf_sort_key(path: Path) -> tuple[int, str]:
    match = re.search(r"(\d+)", path.stem)
    return (int(match.group(1)) if match else 9999, path.name.casefold())


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).replace("\u00ad", "")
    return value.replace("\r\n", "\n").replace("\r", "\n")


def page_text_without_heading(value: str) -> str:
    return CHAPTER_MARKER.sub("", normalize_text(value), count=1).strip()


def compact_paragraphs(pages: list[tuple[int, str]]) -> list[str]:
    """Turn extracted page text into reader-sized blocks without altering words."""
    source_blocks: list[str] = []
    for _, page_text in pages:
        lines = []
        for raw_line in page_text.splitlines():
            line = WHITESPACE.sub(" ", raw_line).strip()
            if not line or ONLY_PAGE_ARTIFACT.fullmatch(line):
                continue
            lines.append(line)
        if lines:
            source_blocks.append(" ".join(lines))

    paragraphs: list[str] = []
    for block in source_blocks:
        parts = SENTENCE_BREAK.split(block)
        current = ""
        for part in parts:
            part = part.strip()
            if not part:
                continue
            candidate = f"{current} {part}".strip()
            if current and len(candidate) > 1_100:
                paragraphs.append(current)
                current = part
            else:
                current = candidate
        if current:
            paragraphs.append(current)
    return paragraphs


def save_image(image_file: Any, output_path: Path) -> bool:
    """Save a PDF image as a web-friendly JPEG. Returns False for unsupported data."""
    try:
        image = image_file.image
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(output_path, "JPEG", quality=88, optimize=True, progressive=True)
        return True
    except Exception as error:  # A malformed embedded image must not stop the import.
        print(f"  ! skipped image {output_path.name}: {error}", flush=True)
        return False


def extract_page_images(page: Any, volume: int, page_number: int, is_cover_page: bool) -> list[str]:
    image_files = list(page.images)
    if not image_files:
        return []

    public_urls: list[str] = []
    for image_index, image_file in enumerate(image_files, start=1):
        if is_cover_page and not COVER_PATH.exists():
            output_path = COVER_PATH
            public_url = "/covers/reader-view.jpg"
        else:
            output_path = ILLUSTRATIONS_DIR / f"volume-{volume:02d}" / f"page-{page_number:04d}-{image_index:02d}.jpg"
            public_url = f"/illustrations/reader-view/volume-{volume:02d}/page-{page_number:04d}-{image_index:02d}.jpg"
        if save_image(image_file, output_path):
            public_urls.append(public_url)
    return public_urls


def duration_for(sentences: list[dict[str, Any]]) -> int:
    words = sum(len(sentence["text"].split()) for sentence in sentences)
    return max(45_000, round(words / 175 * 60_000))


def chapter_payload(source: SourceChapter) -> tuple[dict[str, Any], dict[str, Any]]:
    chapter_id = f"reader-view-v{source.volume:02d}-c{source.local_position:03d}"
    title = f"المجلد {source.volume} — الفصل {source.local_position}"
    paragraphs = compact_paragraphs(source.pages)
    if not paragraphs:
        raise ValueError(f"volume {source.volume}, chapter {source.number} has no text")
    sentences = [
        {
            "id": f"rv-v{source.volume:02d}-c{source.local_position:03d}-p{index:04d}",
            "position": index,
            "text": text,
            "tokens": [],
        }
        for index, text in enumerate(paragraphs, start=1)
    ]
    illustrations: list[dict[str, str]] = []
    if source.image_pages:
        first_page = source.pages[0][0]
        last_page = source.pages[-1][0]
        page_span = max(1, last_page - first_page)
        for image_page in source.image_pages:
            ratio = min(1, max(0, (image_page - first_page) / page_span))
            sentence_index = min(len(sentences) - 1, round(ratio * (len(sentences) - 1)))
            image_folder = f"/illustrations/reader-view/volume-{source.volume:02d}"
            matching_images = sorted((PUBLIC_DIR / image_folder.lstrip("/")).glob(f"page-{image_page:04d}-*.jpg"))
            for image_path in matching_images:
                illustrations.append({
                    "id": f"rv-v{source.volume:02d}-c{source.local_position:03d}-i{len(illustrations) + 1:02d}",
                    "src": f"{image_folder}/{image_path.name}",
                    "alt": f"صورة من المجلد {source.volume}، الفصل {source.local_position}",
                    "afterSentenceId": sentences[sentence_index]["id"],
                })
    common = {
        "id": chapter_id,
        "bookId": "book-reader-view",
        "title": title,
        "position": source.position,
        "durationMs": duration_for(sentences),
        "isSample": True,
        "volumeNumber": source.volume,
        "volumePosition": source.local_position,
        "illustrations": illustrations,
    }
    content = {**common, "sentences": sentences}
    content_file = f"books/reader-view/derived/volume-{source.volume:02d}-chapter-{source.local_position:03d}.json"
    meta = {
        **common,
        "sentences": [],
        "sentenceCount": len(sentences),
        "contentFile": content_file,
    }
    return meta, content


def write_chapter(meta: dict[str, Any], content: dict[str, Any]) -> None:
    path = API_DATA_DIR / meta["contentFile"]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"chapters": [content]}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def update_seed(chapters: list[dict[str, Any]], page_count: int) -> None:
    seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    book = {
        "id": "book-reader-view",
        "slug": "reader-view-arabic",
        "title": "وجهة نظر القارئ",
        "author": "سينغ شونغ",
        "synopsis": "يجد كيم دوكجا أن الرواية الوحيدة التي تابعها لسنوات أصبحت واقعًا، فيسعى للنجاة وسط السيناريوهات المتلاحقة.",
        "priceMinor": 0,
        "currency": "SAR",
        "genre": "فانتازيا",
        "tags": ["وجهة نظر القارئ", "فانتازيا", "رواية مترجمة"],
        "coverTheme": "night",
        "coverUrl": "/covers/reader-view.jpg",
        "status": "PUBLISHED",
        "rating": 4.9,
        "pageCount": page_count,
        "contentUnitLabel": "فصل",
        "contentUnitLabelPlural": "فصول",
        "chapters": chapters,
    }
    seed["books"] = [item for item in seed.get("books", []) if item.get("id") != book["id"] and item.get("slug") != book["slug"]]
    seed["books"].append(book)
    SEED_PATH.write_text(json.dumps(seed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def attach_volume_covers() -> None:
    """Place each supplied volume cover at the start of its first chapter."""
    seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    book = next((item for item in seed.get("books", []) if item.get("id") == "book-reader-view"), None)
    if not book:
        raise ValueError("Reader View is not present in the deployment seed")
    chapters_by_volume: dict[int, list[dict[str, Any]]] = {}
    for chapter in book.get("chapters", []):
        chapters_by_volume.setdefault(int(chapter.get("volumeNumber", 1)), []).append(chapter)
    for volume, chapters in chapters_by_volume.items():
        chapter = min(chapters, key=lambda item: int(item["position"]))
        source = "/covers/reader-view.jpg" if volume == 1 else f"/illustrations/reader-view/volume-{volume:02d}/page-0001-01.jpg"
        if not (PUBLIC_DIR / source.lstrip("/")).exists():
            continue
        content_path = API_DATA_DIR / chapter["contentFile"]
        content_document = json.loads(content_path.read_text(encoding="utf-8"))
        content = content_document["chapters"][0]
        sentences = content.get("sentences", [])
        if not sentences:
            continue
        cover = {
            "id": f"rv-v{volume:02d}-c{int(chapter['volumePosition']):03d}-volume-cover",
            "src": source,
            "alt": f"غلاف المجلد {volume} من وجهة نظر القارئ",
            "afterSentenceId": sentences[0]["id"],
        }
        illustrations = [item for item in content.get("illustrations", []) if item.get("id") != cover["id"]]
        content["illustrations"] = [cover, *illustrations]
        chapter["illustrations"] = [cover, *[item for item in chapter.get("illustrations", []) if item.get("id") != cover["id"]]]
        content_path.write_text(json.dumps(content_document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    SEED_PATH.write_text(json.dumps(seed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    if "--attach-volume-covers" in sys.argv:
        attach_volume_covers()
        print("Attached volume covers", flush=True)
        return 0
    pdf_paths = sorted(SOURCE_DIR.glob("*.pdf"), key=pdf_sort_key)
    if not pdf_paths:
        raise FileNotFoundError(f"No PDFs found in {SOURCE_DIR}")

    print(f"Importing {len(pdf_paths)} volumes from {SOURCE_DIR}", flush=True)
    shutil.rmtree(DERIVED_DIR, ignore_errors=True)
    shutil.rmtree(ILLUSTRATIONS_DIR, ignore_errors=True)
    if COVER_PATH.exists():
        COVER_PATH.unlink()

    chapter_metas: list[dict[str, Any]] = []
    total_pages = 0
    next_position = 1
    for volume, pdf_path in enumerate(pdf_paths, start=1):
        reader = PdfReader(str(pdf_path))
        total_pages += len(reader.pages)
        current: SourceChapter | None = None
        chapter_count = 0
        volume_chapter_position = 0
        print(f"Volume {volume}: {len(reader.pages)} pages", flush=True)
        for page_number, page in enumerate(reader.pages, start=1):
            raw_text = normalize_text(page.extract_text() or "")
            heading = CHAPTER_MARKER.search(raw_text)
            page_image_urls = extract_page_images(page, volume, page_number, page_number == 1)
            if heading:
                if current:
                    meta, content = chapter_payload(current)
                    write_chapter(meta, content)
                    chapter_metas.append(meta)
                    chapter_count += 1
                volume_chapter_position += 1
                current = SourceChapter(
                    volume=volume,
                    local_position=volume_chapter_position,
                    position=next_position,
                )
                next_position += 1
            if current:
                current.pages.append((page_number, page_text_without_heading(raw_text)))
                if page_image_urls:
                    current.image_pages.append(page_number)
        if current:
            meta, content = chapter_payload(current)
            write_chapter(meta, content)
            chapter_metas.append(meta)
            chapter_count += 1
        print(f"Volume {volume}: imported {chapter_count} chapters", flush=True)

    if not chapter_metas:
        raise ValueError("No chapter headings found; seed was left unchanged")
    update_seed(chapter_metas, total_pages)
    attach_volume_covers()
    print(f"Done: {len(chapter_metas)} chapters, {total_pages} pages", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Import failed: {error}", file=sys.stderr, flush=True)
        raise
