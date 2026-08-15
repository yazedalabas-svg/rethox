from __future__ import annotations

"""Replace Re:Zero arc 6 chapters 65–90 from the supplied English PDF.

The importer deliberately leaves chapters 1–64 untouched.  It retains the chapter
IDs used by reader links and saved progress, rebuilds only the sentence content
for the tail, and imports the high-resolution illustrations embedded in the PDF.
"""

import argparse
import concurrent.futures
import json
import re
from pathlib import Path
from typing import Any

import import_rezero_arcs as shared


PROJECT = Path(__file__).resolve().parents[1]
PDF_PATH = PROJECT / "apps" / "web" / "public" / "re zero arc 7 - 9" / "727279946-Rezero-Arc-6.pdf"
SEED_PATH = PROJECT / "apps" / "api" / "data" / "deploy-seed.json"
RUNTIME_PATH = PROJECT / "apps" / "api" / "data" / "runtime-store.json"
CACHE_PATH = PROJECT / "tmp" / "pdfs" / "rezero-arc-6" / "tail-65-90.json"
TRANSLATION_CACHE_PATH = PROJECT / "tmp" / "pdfs" / "rezero-arc-6" / "tail-65-90-ar.json"
PUBLIC_DIR = PROJECT / "apps" / "web" / "public"
IMAGE_DIR = PUBLIC_DIR / "illustrations" / "rezero-arc-6"
BOOK_ID = "book-rezero-arc-6"

# Printed table-of-contents page numbers are one less than the PDF page indexes.
CHAPTER_START_PAGES = {
    65: 1065, 66: 1081, 67: 1098, 68: 1115, 69: 1134, 70: 1153,
    71: 1171, 72: 1189, 73: 1225, 74: 1252, 75: 1278, 76: 1312,
    77: 1336, 78: 1355, 79: 1375, 80: 1398, 81: 1417, 82: 1433,
    83: 1455, 84: 1489, 85: 1506, 86: 1537, 87: 1561, 88: 1579,
    89: 1597, 90: 1617,
}

ARABIC_TITLES = {
    65: "الثاني، الخامس، ثم ما يليه",
    66: "فرصة ثانية نحو الخاتمة",
    67: "الملك الصغير",
    68: "امرأة العقرب",
    69: "المطرقة الحديدية العبثية للسيف",
    70: "النجم الصادق",
    71: "العدّ واحدًا",
    72: "■■・■",
    73: "«ناتسوكي سوبارو»",
    74: "ناتسوكي سوبارو",
    75: "لوي أرنيب",
    76: "الجحيم الذي يحمل اسم المرء",
    77: "منارة الهجوم المضاد",
    78: "الزوايا الأربع",
    79: "استعدوا، انطلقوا، ابدأوا",
    80: "موت العقل",
    81: "سعيدة بلقائك",
    82: "القيد المصاحب للمعركة",
    83: "رام",
    84: "هيّا، هيّا!",
    85: "الخاسر النبيل",
    86: "حديث عمّا حمله الأمس",
    87: "نظرة من بعيد",
    88: "أرجو إرادتك",
    89: "شاولا",
    90: "البطل",
}

# A source glyph used for Shaula's scream is not a word.  Google occasionally
# returns a Greek placeholder for it, which harms RTL rendering and TTS, so keep
# its intended Arabic vocalisation explicitly.
MANUAL_TRANSLATIONS = {
    "rz6-c78-p0179": "كان موجّهًا نحوه، مستعدًا لإطلاق ضربته المدمرة… شاولا: «هيييييياااااا!!»",
}

# Extend the shared glossary before Google sees the source text.  This prevents
# names and fixed terms from being translated inconsistently between paragraphs.
shared.NAME_REPLACEMENTS.update({
    "Reid Astrea": "ريد أستريا", "Reid": "ريد",
    "Ley Batenkaitos": "لاي باتينكايتوس", "Ley": "لاي", "Lye": "لاي",
    "Roy Alphard": "روي ألفارد", "Roy": "روي", "Batenkaitos": "باتينكايتوس",
    "Satella": "ساتيلا", "Volcanica": "فولكانيكا", "Ram": "رام",
    "Reinhard": "راينهارد", "Felt": "فيلت", "Flandre": "فلاندر",
    "Murder Becomes a Habit": "القتل يصبح عادة", "Sword Saint": "قديس السيف",
    "Sin Archbishop": "رئيس أساقفة الخطيئة", "Gluttony": "الشراهة",
    "Authority of Gluttony": "سلطة الشراهة", "Hall of Memories": "قاعة الذكريات",
    "Taygeta Library": "مكتبة تايگيتا", "Pleiades Watchtower": "برج مراقبة الثريا",
    "Great Scorpion": "العقرب العظيم", "Guiltylowe": "غيلتيلاو",
})

HEADING = re.compile(r"^Chapter\s+(?P<number>6[5-9]|[789]\d)\s*[:,–—-]\s*(?P<title>.+)$", re.IGNORECASE)
TRANSLATOR_LINE = re.compile(
    r"^(?:Translation|Translations|Translated|Art|Illustration|Proofread|Edited)\s+(?:by|from)\b",
    re.IGNORECASE,
)


def atomic_json(path: Path, value: Any, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2 if pretty else None, separators=None if pretty else (",", ":")) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def clean_source(value: str) -> str:
    value = value.replace("\ufeff", "").replace("\u00ad", "")
    value = shared.SPACE.sub(" ", value).strip()
    value = value.replace("ーー", "—").replace("―", "—")
    return value


def source_paragraphs(layout: str) -> list[str]:
    lines: list[str] = []
    for raw in layout.replace("\r", "").splitlines():
        line = clean_source(raw)
        if not line:
            lines.append("")
            continue
        if line.isdigit() or HEADING.fullmatch(line) or TRANSLATOR_LINE.match(line):
            continue
        if line in {"△▼△▼△▼△", "※"} or not re.search(r"[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]", line):
            continue
        lines.append(line)

    result: list[str] = []
    buffer: list[str] = []
    def flush() -> None:
        if not buffer:
            return
        value = clean_source(" ".join(buffer))
        buffer.clear()
        if not value or TRANSLATOR_LINE.match(value) or shared.is_editorial_note(value):
            return
        lowered = value.lower()
        if any(marker in lowered for marker in (
            "all rights reserved", "translation by", "translations by", "compiled by", "table of contents",
        )):
            return
        result.append(value)
    for line in lines:
        if line:
            buffer.append(line)
        else:
            flush()
    flush()
    return result


def append_page_fragments(existing: list[dict[str, Any]], incoming: list[str], page: int) -> None:
    if incoming and existing:
        previous = existing[-1]["text"].rstrip()
        current = incoming[0].lstrip()
        if previous and current and (previous.endswith((",", ";", ":", "—", "-")) or (previous[-1].isalnum() and current[0].islower())):
            existing[-1]["text"] = clean_source(previous + " " + current)
            existing[-1]["endPage"] = page
            incoming = incoming[1:]
    existing.extend({"text": value, "startPage": page, "endPage": page} for value in incoming)


def extract_images(page: Any, chapter: int, page_number: int) -> list[dict[str, Any]]:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    assets: list[dict[str, Any]] = []
    for index, image in enumerate(page.images, start=1):
        size = getattr(getattr(image, "image", None), "size", (0, 0))
        if len(image.data) < 50_000 or size[0] * size[1] < 300_000:
            continue
        suffix = Path(image.name).suffix.lower()
        if suffix not in {".jpg", ".jpeg", ".png", ".webp"}:
            suffix = ".jpg"
        target = IMAGE_DIR / f"arc6-c{chapter:02d}-p{page_number:04d}-i{index:02d}{suffix}"
        target.write_bytes(image.data)
        assets.append({"src": "/" + target.relative_to(PUBLIC_DIR).as_posix(), "page": page_number})
    return assets


def extract_source(refresh: bool) -> dict[str, Any]:
    cached = {} if refresh or not CACHE_PATH.exists() else json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    cached_chapters = {int(key): value for key, value in cached.get("chapters", {}).items()}
    if len(cached_chapters) == len(CHAPTER_START_PAGES):
        return {"source": str(PDF_PATH), "chapters": cached_chapters}
    from pypdf import PdfReader
    reader = PdfReader(str(PDF_PATH))
    chapters: dict[int, dict[str, Any]] = cached_chapters
    starts = list(CHAPTER_START_PAGES.items())
    for offset, (chapter_number, start_page) in enumerate(starts):
        if chapter_number in chapters:
            print(f"using cached chapter {chapter_number}", flush=True)
            continue
        end_page = starts[offset + 1][1] - 1 if offset + 1 < len(starts) else len(reader.pages)
        chapter = {"number": chapter_number, "startPage": start_page, "endPage": end_page, "paragraphs": [], "images": []}
        for page_number in range(start_page, end_page + 1):
            page = reader.pages[page_number - 1]
            append_page_fragments(chapter["paragraphs"], source_paragraphs(page.extract_text(extraction_mode="layout") or ""), page_number)
            chapter["images"].extend(extract_images(page, chapter_number, page_number))
        for position, paragraph in enumerate(chapter["paragraphs"], start=1):
            paragraph["id"] = f"rz6-c{chapter_number}-p{position:04d}"
        chapters[chapter_number] = chapter
        atomic_json(CACHE_PATH, {"source": str(PDF_PATH), "chapters": chapters})
        print(f"extracted chapter {chapter_number}: {len(chapter['paragraphs'])} paragraphs, {len(chapter['images'])} images", flush=True)
    result = {"source": str(PDF_PATH), "chapters": chapters}
    atomic_json(CACHE_PATH, result)
    return result


def translate(chapters: dict[int, dict[str, Any]], workers: int, refresh: bool) -> dict[str, str]:
    cache: dict[str, str] = {} if refresh or not TRANSLATION_CACHE_PATH.exists() else json.loads(TRANSLATION_CACHE_PATH.read_text(encoding="utf-8"))
    all_paragraphs = [paragraph for chapter in chapters.values() for paragraph in chapter["paragraphs"]]
    source_ids = {paragraph["id"] for paragraph in all_paragraphs}
    # Discard entries for editorial notes that were removed from the source.
    cache = {key: value for key, value in cache.items() if key in source_ids}
    groups = shared.translation_groups(all_paragraphs, cache, max_chars=11_000, max_items=60)
    translator = shared.GoogleTranslator(workers)
    print(f"translation: {len(all_paragraphs) - len(cache)} new paragraphs across {len(groups)} requests", flush=True)
    def one(group: list[dict[str, str]]) -> dict[str, str]:
        return translator.translate_group(group)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = [executor.submit(one, group) for group in groups]
        for index, future in enumerate(futures, start=1):
            translated = future.result()
            cache.update(translated)
            atomic_json(TRANSLATION_CACHE_PATH, cache)
            print(f"translated batch {index}/{len(futures)} ({len(cache)}/{len(all_paragraphs)})", flush=True)
    cache.update(MANUAL_TRANSLATIONS)
    for paragraph in all_paragraphs:
        value = shared.replace_known_names(cache[paragraph["id"]])
        value = shared.clean_residual_latin(value, translator.translate_text)
        if not shared.valid_translation(paragraph["text"], value):
            raise ValueError(f"invalid Arabic translation: {paragraph['id']}")
        cache[paragraph["id"]] = value
    atomic_json(TRANSLATION_CACHE_PATH, cache)
    return cache


def illustration_position(paragraphs: list[dict[str, Any]], image_page: int) -> str | None:
    prior = [paragraph for paragraph in paragraphs if paragraph["endPage"] <= image_page]
    return prior[-1]["id"] if prior else None


def apply_book_data(source: dict[str, Any], translations: dict[str, str], store_path: Path) -> None:
    store = json.loads(store_path.read_text(encoding="utf-8"))
    book = next(item for item in store["books"] if item["id"] == BOOK_ID)
    by_position = {chapter["position"]: chapter for chapter in book["chapters"]}
    for number, imported in source["chapters"].items():
        number = int(number)
        current = by_position[number]
        sentences = [
            {"id": paragraph["id"], "position": position, "text": translations[paragraph["id"]], "tokens": []}
            for position, paragraph in enumerate(imported["paragraphs"], start=1)
        ]
        current["title"] = f"الفصل {number} — {ARABIC_TITLES[number]}"
        current["sentences"] = sentences
        current["durationMs"] = max(30_000, sum(max(1, len(item["text"].split())) for item in sentences) * 430)
        current["illustrations"] = [
            {
                "id": f"rz6-c{number}-art-{index:02d}",
                "src": image["src"],
                "alt": "",
                "afterSentenceId": illustration_position(imported["paragraphs"], image["page"]),
                "position": index,
            }
            for index, image in enumerate(imported["images"], start=1)
        ]
    atomic_json(store_path, store, pretty=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh-source", action="store_true")
    parser.add_argument("--refresh-translations", action="store_true")
    parser.add_argument("--extract-only", action="store_true")
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    source = extract_source(args.refresh_source)
    if args.extract_only:
        return
    translations = translate(source["chapters"], args.workers, args.refresh_translations)
    apply_book_data(source, translations, SEED_PATH)
    if RUNTIME_PATH.exists():
        apply_book_data(source, translations, RUNTIME_PATH)
    print("Replaced Arc 6 chapters 65–90; chapters 1–64 were not changed.")


if __name__ == "__main__":
    main()
