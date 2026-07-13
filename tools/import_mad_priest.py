from __future__ import annotations

import argparse
import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import fitz


BOOK_ID = "book-reverend-insanity"
BOOK_SLUG = "reverend-insanity-arabic"
CHAPTER_WORD = "الفصل"
VOLUME_RANGES = (
    (1, 199),
    (200, 405),
    (406, 649),
    (650, 1021),
    (1022, 1966),
    (1967, 2334),
)

CHAPTER_PATTERN = re.compile(rf"{CHAPTER_WORD}\s*(\d{{1,4}})\s*[:：\-–—]?\s*(.*)$")
NUMBER_PATTERN = re.compile(r"(?<!\d)(\d{1,4})(?!\d)")
SPACE_PATTERN = re.compile(r"\s+")
TERMINAL_PATTERN = re.compile(r"[.!؟!…\]”’\"']\s*$")


@dataclass(frozen=True)
class Marker:
    page: int
    line: int
    title: str
    raw: str


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = value.replace("\u200e", "").replace("\u200f", "")
    value = value.replace("\ufeff", "").replace("\u00a0", " ")
    return value


def clean_line(value: str) -> str:
    return SPACE_PATTERN.sub(" ", normalize_text(value)).strip()


def clean_title(value: str) -> str:
    value = value.strip(" -–—:：_[](){}\t")
    value = re.sub(rf"^{CHAPTER_WORD}\s*\d{{1,4}}\s*[:：\-–—]?\s*", "", value)
    return SPACE_PATTERN.sub(" ", value).strip()


def fallback_title(value: str, number: int) -> str:
    if re.search(r"ترجم|تدقيق|مدقق|مراجعة|PEEWEE|Drake|Ismail", value, re.I):
        return ""
    value = re.sub(rf"(?<!\d){number}(?!\d)", "", value)
    value = clean_title(value)
    arabic_letters = sum("\u0600" <= character <= "\u06ff" for character in value)
    return value if arabic_letters >= 4 else ""


def title_from_lines(lines: list[str], line_index: int, fallback: str) -> str:
    title = clean_title(fallback)
    if not title and line_index + 1 < len(lines):
        title = clean_title(lines[line_index + 1])
    if not title or len(title) > 180:
        return ""
    return title


def scan_volume(pdf_path: Path, first: int, last: int) -> tuple[list[str], dict[int, Marker]]:
    document = fitz.open(pdf_path)
    page_texts: list[str] = []
    strong: dict[int, list[Marker]] = {number: [] for number in range(first, last + 1)}
    fallback: dict[int, list[Marker]] = {number: [] for number in range(first, last + 1)}

    for page_index, page in enumerate(document):
        text = normalize_text(page.get_text("text"))
        page_texts.append(text)
        lines = [clean_line(line) for line in text.splitlines() if clean_line(line)]

        for line_index, line in enumerate(lines):
            for match in CHAPTER_PATTERN.finditer(line):
                number = int(match.group(1))
                if first <= number <= last:
                    title = title_from_lines(lines, line_index, match.group(2))
                    strong[number].append(Marker(page_index, line_index, title, line))

        for line_index, line in enumerate(lines[:16]):
            for match in NUMBER_PATTERN.finditer(line):
                number = int(match.group(1))
                if first <= number <= last:
                    fallback[number].append(
                        Marker(page_index, line_index, fallback_title(line, number), line)
                    )

    markers: dict[int, Marker] = {}
    previous_page = -1
    # A heading containing the word "chapter" is authoritative. Choosing the
    # first monotonic occurrence also rejects later cross-references.
    for number in range(first, last + 1):
        choices = [item for item in strong[number] if item.page > previous_page]
        if choices:
            marker = min(choices, key=lambda item: (item.page, item.line))
            markers[number] = marker
            previous_page = marker.page

    # Fill malformed headings (translator labels, split titles, or missing the
    # word "chapter") between the closest authoritative neighbours.
    authoritative = sorted(markers)
    for number in range(first, last + 1):
        if number in markers:
            continue
        lower = max((item for item in authoritative if item < number), default=first - 1)
        upper = min((item for item in authoritative if item > number), default=last + 1)
        lower_page = markers[lower].page if lower in markers else 0
        upper_page = markers[upper].page if upper in markers else len(page_texts) - 1
        ratio = (number - lower) / max(1, upper - lower)
        expected_page = lower_page + ratio * (upper_page - lower_page)
        choices = [
            item
            for item in fallback[number]
            if lower_page < item.page < upper_page
        ]
        if choices:
            markers[number] = min(
                choices,
                key=lambda item: (abs(item.page - expected_page), item.line),
            )
        else:
            page = round(expected_page)
            markers[number] = Marker(page, 0, "", "")

    # Enforce a strictly increasing chapter order. This retains every page even
    # when a source PDF omitted a chapter number entirely.
    previous_page = -1
    for number in range(first, last + 1):
        marker = markers[number]
        page = max(marker.page, previous_page + 1)
        page = min(page, len(page_texts) - (last - number) - 1)
        markers[number] = Marker(page, marker.line, marker.title, marker.raw)
        previous_page = page

    document.close()
    return page_texts, markers


def body_lines(
    page_texts: list[str],
    start: Marker,
    end_page: int,
    chapter_number: int,
) -> list[str]:
    lines: list[str] = []
    exact_heading = re.compile(rf"{CHAPTER_WORD}\s*{chapter_number}(?!\d)")
    bare_heading = re.compile(rf"^\s*{chapter_number}(?!\d)")
    for page_index in range(start.page, end_page):
        page_lines = [
            clean_line(line)
            for line in page_texts[page_index].splitlines()
            if clean_line(line)
        ]
        for line_index, line in enumerate(page_lines):
            if page_index == start.page and line_index < 18:
                if exact_heading.search(line):
                    continue
                if start.raw and line == start.raw:
                    continue
                if line_index == start.line and bare_heading.search(line):
                    continue
            if re.fullmatch(r"[_ـ\-–—\s]{4,}", line):
                continue
            lines.append(line)
    return lines


def paragraphs(lines: list[str]) -> list[str]:
    result: list[str] = []
    buffer = ""
    for line in lines:
        candidate = f"{buffer} {line}".strip() if buffer else line
        if len(candidate) >= 720 or (len(candidate) >= 120 and TERMINAL_PATTERN.search(line)):
            result.append(candidate)
            buffer = ""
        else:
            buffer = candidate
    if buffer:
        result.append(buffer)
    return [item for item in result if len(item) > 1]


def build_book(source_dir: Path) -> tuple[dict, list[str]]:
    pdf_paths = sorted(source_dir.glob("*.pdf"))
    if len(pdf_paths) != len(VOLUME_RANGES):
        raise RuntimeError(f"Expected 6 PDF volumes, found {len(pdf_paths)}")

    chapters: list[dict] = []
    report: list[str] = []
    page_total = 0
    for volume_index, (pdf_path, (first, last)) in enumerate(
        zip(pdf_paths, VOLUME_RANGES), start=1
    ):
        page_texts, markers = scan_volume(pdf_path, first, last)
        page_total += len(page_texts)
        volume_word_total = 0
        for number in range(first, last + 1):
            start = markers[number]
            end_page = (
                markers[number + 1].page
                if number < last
                else len(page_texts)
            )
            raw_lines = body_lines(page_texts, start, end_page, number)
            chapter_paragraphs = paragraphs(raw_lines)
            title_suffix = clean_title(start.title)
            title = f"الفصل {number}" + (f" — {title_suffix}" if title_suffix else "")
            sentences = []
            word_count = 0
            for position, paragraph in enumerate(chapter_paragraphs, start=1):
                word_count += len(paragraph.split())
                sentences.append(
                    {
                        "id": f"ri-c{number:04d}-p{position:04d}",
                        "position": position,
                        "text": paragraph,
                        "tokens": [],
                    }
                )
            volume_word_total += word_count
            chapters.append(
                {
                    "id": f"ch-reverend-insanity-{number:04d}",
                    "bookId": BOOK_ID,
                    "title": title,
                    "position": number,
                    "durationMs": max(1, word_count * 430),
                    "isSample": number == 1,
                    "sentences": sentences,
                }
            )
        report.append(
            f"volume={volume_index} chapters={last - first + 1} "
            f"pages={len(page_texts)} words={volume_word_total}"
        )

    return (
        {
            "id": BOOK_ID,
            "slug": BOOK_SLUG,
            "title": "القس المجنون",
            "author": "غو تشن رن",
            "synopsis": (
                "بعد خمسة قرون من الصراع يعود فانغ يوان إلى بداية رحلته، "
                "محتفظًا بذكرياته وعزيمته، في عالم تحكمه ديدان الغو وصراعات "
                "الطوائف والطموح نحو الخلود."
            ),
            "priceMinor": 5900,
            "currency": "SAR",
            "genre": "فانتازيا",
            "tags": ["فانتازيا", "زراعة", "مغامرة", "رواية مترجمة"],
            "coverTheme": "indigo",
            "status": "PUBLISHED",
            "rating": 0,
            "pageCount": page_total,
            "chapters": chapters,
        },
        report,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Import the six Arabic Reverend Insanity PDF volumes."
    )
    parser.add_argument("source", type=Path, help="Directory containing the six PDFs")
    parser.add_argument("store", type=Path, help="deploy-seed.json path")
    args = parser.parse_args()

    book, report = build_book(args.source)
    derived_dir = args.source / "derived"
    derived_dir.mkdir(parents=True, exist_ok=True)
    for volume_index, (first, last) in enumerate(VOLUME_RANGES, start=1):
        filename = f"volume-{volume_index:02d}.json"
        volume_chapters = [
            chapter for chapter in book["chapters"]
            if first <= chapter["position"] <= last
        ]
        (derived_dir / filename).write_text(
            json.dumps(
                {"bookId": BOOK_ID, "first": first, "last": last, "chapters": volume_chapters},
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        for chapter in volume_chapters:
            chapter["sentenceCount"] = len(chapter["sentences"])
            chapter["contentFile"] = f"books/القس المجنون/derived/{filename}"
            if chapter["position"] != 1:
                chapter["sentences"] = []
    store = json.loads(args.store.read_text(encoding="utf-8"))
    books = store.setdefault("books", [])
    index = next(
        (position for position, item in enumerate(books) if item.get("id") == BOOK_ID),
        None,
    )
    if index is None:
        books.append(book)
    else:
        books[index] = book
    for item in books:
        for chapter in item.get("chapters", []):
            chapter["isSample"] = chapter.get("position") == 1
    args.store.write_text(
        json.dumps(store, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for line in report:
        print(line)
    paragraph_total = sum(len(chapter["sentences"]) for chapter in book["chapters"])
    print(
        f"imported book={BOOK_ID} chapters={len(book['chapters'])} "
        f"paragraphs={paragraph_total} pages={book['pageCount']}"
    )


if __name__ == "__main__":
    main()
