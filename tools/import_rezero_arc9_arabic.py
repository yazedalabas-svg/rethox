from __future__ import annotations

import html
import json
import re
import urllib.request
import zipfile
from pathlib import Path
from typing import Iterable


PROJECT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT / "apps" / "api" / "data"
DERIVED_DIR = DATA_DIR / "books" / "ReZero Arc 9" / "derived"
SEED_PATH = DATA_DIR / "deploy-seed.json"
RUNTIME_PATH = DATA_DIR / "runtime-store.json"
ARC9_BOOK_ID = "book-rezero-arc-9"

VOL39_PATH = Path(r"D:\REZERO VOL 39 AR.txt")
VOL40_PATH = Path(r"D:\REZERO VOL 40 AR.txt")
SOURCE_ZIP = Path(r"D:\converted-files.zip")

MISSING_URLS = {
    24: "https://kolnovel.com/shaag24rezero-starting-life-in-another-worldz435ggye-275011/",
    25: "https://kolnovel.com/shaag24rezero-starting-life-in-another-worldz435ggye-275013/",
    26: "https://kolnovel.com/shaag24rezero-starting-life-in-another-worldz435ggye-275015/",
    27: "https://kolnovel.com/shaag24rezero-starting-life-in-another-worldz435ggye-275017/",
    28: "https://kolnovel.com/shaag24rezero-starting-life-in-another-worldz435ggye-275019/",
    29: "https://kolnovel.com/shaag24rezero-starting-life-in-another-worldz435ggye-275021/",
}

MISSING_TITLES = {
    24: "عدو البشرية",
    25: "كانت إميليا غاضبة",
    26: "شيطان السيف ضد الساكورا القرمزية",
    27: "كلمات طفل",
    28: "مقطع من أسطورة",
    29: "في أسفل الطاولة",
}

TITLE_OVERRIDES = {
    8: "كيفية الندم",
    35: "نجم الصحوة",
    39: "الخط النهائي",
    41: "أخبر المغتصب",
    49: "الساحر",
    59: "الفصل 59",
}

VOLUME39_HEADINGS = [
    (1, "الفصل الأول:"),
    (2, "الفصل الثاني:"),
    (3, "الفصل الثالث:"),
    (4, "الفصل الرابع:"),
    (5, "الفصل الخامس:"),
    (6, "الفصل السادس:"),
    (7, "فاصل:"),
    (8, "الفصل السابع:"),
    (9, "الفصل الثامن: كيفية الندم"),
    (10, "الفصل التاسع:"),
    (11, "الفصل العاشر:"),
    (12, "الفصل الحادي عشر:"),
    (13, "الفصل 12:"),
    (14, "الفصل 13:"),
]
VOLUME40_HEADINGS = [(number, f"الفصل {number}:") for number in range(14, 24)]


def compact(value: str) -> str:
    value = html.unescape(value)
    value = value.replace("\u200b", "").replace("\ufeff", "")
    value = value.replace("\u3000", " ")
    return re.sub(r"\s+", " ", value).strip()


def is_metadata(line: str) -> bool:
    lowered = line.casefold()
    return (
        not line
        or re.fullmatch(r"[0-9٠-٩]+", line) is not None
        or re.fullmatch(r"[※—–\-_=*·. ]{3,}", line) is not None
        or lowered.startswith(("by ", "ترجمة", "مترجم", "ترجمه", "تمت الترجمة", "بواسطة"))
        or "onlinedoctranslator" in lowered
    )


def text_paragraphs(text: str, *, skip_header: bool = False) -> list[str]:
    blocks = re.split(r"\n\s*\n+", text.replace("\r\n", "\n"))
    result: list[str] = []
    for index, block in enumerate(blocks):
        lines = [compact(line) for line in block.splitlines()]
        lines = [line for line in lines if line and not is_metadata(line)]
        if skip_header and index == 0:
            continue
        if not lines:
            continue
        value = compact(" ".join(lines))
        if value and not is_metadata(value):
            result.append(value)
    return result


def volume_chapters_text(text: str, specs: list[tuple[int, str]], source_name: str) -> dict[int, tuple[str, list[str]]]:
    lines = text.replace("\r\n", "\n").splitlines()
    starts: list[tuple[int, int]] = []
    cursor = 120
    for number, heading in specs:
        found = next(
            (index for index in range(cursor, len(lines)) if compact(lines[index]) == heading),
            None,
        )
        if found is None:
            raise RuntimeError(f"Could not find {heading!r} in {source_name}")
        starts.append((number, found))
        cursor = found + 1

    result: dict[int, tuple[str, list[str]]] = {}
    for offset, (number, start) in enumerate(starts):
        end = starts[offset + 1][1] if offset + 1 < len(starts) else len(lines)
        nonempty = [(idx, compact(lines[idx])) for idx in range(start + 1, end) if compact(lines[idx])]
        if not nonempty:
            raise RuntimeError(f"Empty chapter {number} in {path}")
        heading_suffix = compact(lines[start]).split(":", 1)[1].strip() if ":" in compact(lines[start]) else ""
        title = heading_suffix or nonempty[0][1]
        body_start = nonempty[1][0] if len(nonempty) > 1 and re.fullmatch(r"[0-9٠-٩]+", nonempty[1][1]) else nonempty[0][0]
        body = "\n".join(lines[body_start:end])
        paragraphs = text_paragraphs(body)
        result[number] = (title, paragraphs)
    return result


def volume_chapters(path: Path, specs: list[tuple[int, str]]) -> dict[int, tuple[str, list[str]]]:
    return volume_chapters_text(path.read_text(encoding="utf-8", errors="replace"), specs, str(path))


def chapter_title_from_header(header: str, fallback: str) -> str:
    match = re.search(r"[\"“”«»](.*?)[\"“”«»]", header)
    if match:
        return compact(match.group(1))
    return fallback


def split_zip_text(name: str, text: str) -> dict[int, tuple[str, list[str]]]:
    lines = text.replace("\r\n", "\n").splitlines()
    # Combined files have an explicit header for each chapter. Single files use
    # the first chapter header after their translator credits.
    starts: list[tuple[int, int]] = []
    pattern = re.compile(r"(?i)الفصل\s*(?:التاسع[،, ]*)?(?:الجزء\s*)?(?:9[،, ]*)?(?:الفصل\s*)?(55|56|58|59)\b")
    if name.startswith("فصل 55") or name.startswith("الفصل 58"):
        for index, line in enumerate(lines):
            match = pattern.search(compact(line))
            if match:
                starts.append((int(match.group(1)), index))
    elif name == "الفصل 57.txt":
        starts = [(57, next(index for index, line in enumerate(lines) if "57" in compact(line)))]
    elif name == "الفصل الأخير.txt":
        starts = [(60, next(index for index, line in enumerate(lines) if "الحلقة النهائية" in compact(line)))]
    else:
        number_match = re.search(r"(?:الفصل|فصل)\s*(\d+)", name)
        if not number_match:
            number_match = re.search(r"الفصل\s*(?:التاسع[،, ]*)?(?:الجزء\s*)?(\d+)", text)
        if not number_match:
            raise RuntimeError(f"Could not identify chapter number in {name}")
        number = int(number_match.group(1))
        header_index = next(
            (index for index, line in enumerate(lines) if re.search(rf"\b{number}\b", compact(line)) and "الفصل" in compact(line)),
            0,
        )
        starts = [(number, header_index)]

    result: dict[int, tuple[str, list[str]]] = {}
    for offset, (number, start) in enumerate(starts):
        end = starts[offset + 1][1] if offset + 1 < len(starts) else len(lines)
        header = compact(lines[start])
        body = "\n".join(lines[start + 1 : end])
        title = chapter_title_from_header(header, f"الفصل {number}")
        result[number] = (title, text_paragraphs(body))
    return result


def extract_missing_chapter(url: str, number: int) -> list[str]:
    request = urllib.request.Request(url, headers={"User-Agent": "rethox-arc9-import/1.0"})
    source = urllib.request.urlopen(request, timeout=45).read().decode("utf-8", errors="replace")
    match = re.search(r'<div[^>]*id="kol_content"[^>]*>', source, re.IGNORECASE)
    if not match:
        raise RuntimeError(f"Arabic chapter body was not found: {url}")
    end = source.lower().find("</div>", match.end())
    body = source[match.end() : end if end >= 0 else len(source)]
    chunks = re.split(r"(?is)<p\b[^>]*>", body)[1:]
    paragraphs: list[str] = []
    for chunk in chunks:
        chunk = chunk.split("<p", 1)[0]
        chunk = re.sub(r"(?is)<script.*?</script>|<style.*?</style>|<[^>]+>", " ", chunk)
        value = compact(chunk)
        if value and value != f"41.{number}" and "تحدي أغسطس" not in value:
            paragraphs.append(value)
    # The source pages contain malformed nested paragraph tags. The outer
    # paragraph stream is the one that begins and ends at the canonical scene
    # boundaries. Drop the interleaved duplicate stream and retain first copies.
    stream = paragraphs[::2]
    unique: list[str] = []
    seen: set[str] = set()
    for paragraph in stream:
        key = re.sub(r"\s+", " ", paragraph).casefold()
        if key in seen or "تحدي أغسطس" in paragraph:
            continue
        seen.add(key)
        unique.append(paragraph)
    if len(unique) < 40:
        raise RuntimeError(f"Arabic chapter {number} extraction looks incomplete: {len(unique)} paragraphs")
    return unique


def make_chapter(position: int, chapter_number: int | None, title: str, paragraphs: Iterable[str], volume: int, volume_position: int) -> dict:
    cleaned = [compact(value) for value in paragraphs if compact(value)]
    sentences = [
        {
            "id": f"rz9-c{position:03d}-p{index:04d}",
            "position": index,
            "text": paragraph,
            "tokens": [],
        }
        for index, paragraph in enumerate(cleaned, start=1)
    ]
    words = sum(len(sentence["text"].split()) for sentence in sentences)
    label = f"الفصل {chapter_number} — {title}" if chapter_number is not None else title
    return {
        "id": f"ch-rezero-9-{position:03d}",
        "bookId": ARC9_BOOK_ID,
        "title": label,
        "position": position,
        "durationMs": max(45_000, words * 430),
        "isSample": position == 1,
        "volumeNumber": volume,
        "volumePosition": volume_position,
        "sentences": sentences,
    }


def read_all() -> list[dict]:
    if not VOL39_PATH.exists() or not SOURCE_ZIP.exists():
        raise FileNotFoundError("Expected D:\\REZERO VOL 39 AR.txt and D:\\converted-files.zip")

    vol39 = volume_chapters(VOL39_PATH, VOLUME39_HEADINGS)
    chapters: list[dict] = []
    position = 1
    volume_positions: dict[int, int] = {}

    def add(chapter_number: int | None, title: str, paragraphs: list[str], volume: int) -> None:
        nonlocal position
        volume_positions[volume] = volume_positions.get(volume, 0) + 1
        chapters.append(make_chapter(position, chapter_number, title, paragraphs, volume, volume_positions[volume]))
        position += 1

    # Volume 39 includes the short Katya Aurelie intermission between chapters 6 and 7.
    for number in range(1, 7):
        title, paragraphs = vol39[number]
        add(number, title, paragraphs, 39)
    add(None, "فاصل — كاتيا أوريلي", vol39[7][1], 39)
    for number in range(8, 15):
        actual = number - 1
        title, paragraphs = vol39[number]
        add(actual, title, paragraphs, 39)

    with zipfile.ZipFile(SOURCE_ZIP) as archive:
        names = {Path(name).name: name for name in archive.namelist() if not name.endswith("/")}

        def read(name: str) -> str:
            return archive.read(names[name]).decode("utf-8", errors="replace")

        vol40 = volume_chapters_text(read("REZERO VOL 40 AR.txt"), VOLUME40_HEADINGS, "REZERO VOL 40 AR.txt")
        add(None, "فاصل — الصراخ", text_paragraphs(read("Intermission arc 9.txt"), skip_header=True), 39)
        for number in range(14, 24):
            title, paragraphs = vol40[number]
            add(number, title, paragraphs, 40)

        missing = {number: extract_missing_chapter(url, number) for number, url in MISSING_URLS.items()}
        for number in range(24, 30):
            add(number, MISSING_TITLES[number], missing[number], 41)

        filenames = {
            30: "الفصل 30 من الأرك 9.txt", 31: "فصل 31 من الأرك 9.txt", 32: "الفصل 32 من الأرك 9.txt",
            33: "الفصل 33 من الأرك 9.txt", 34: "فصل 34 من الأرك 9.txt", 35: "الفصل 35 من الأرك 9.txt",
            36: "الفصل 36 من الأرك 9.txt", 37: "الفصل 37 !.txt", 38: "الفصل 38.txt", 39: "الفصل 39!!.txt",
            40: "الفصل 40.txt", 41: "الفصل 41.txt", 42: "الفصل 42.txt", 43: "فصل 43.txt", 44: "الفصل 44.txt",
            45: "الفصل 45.txt", 46: "الفصل 46.txt", 47: "الفصل 47.txt", 48: "الفصل 48.txt", 49: "الفصل 49!.txt",
            50: "الفصل 50.txt", 51: "الفصل 51.txt", 52: "الفصل 52.txt", 53: "الفصل 53.txt", 54: "الفصل 54.txt",
            57: "الفصل 57.txt",
        }
        combined = split_zip_text("فصل 55 و 56.txt", read("فصل 55 و 56.txt"))
        combined.update(split_zip_text("الفصل 58 & 59.txt", read("الفصل 58 & 59.txt")))
        for number in range(30, 60):
            if number in {55, 56, 58, 59}:
                title, paragraphs = combined[number]
            else:
                title, paragraphs = split_zip_text(filenames[number], read(filenames[number]))[number]
            add(number, TITLE_OVERRIDES.get(number, title), paragraphs, 41)
        title, paragraphs = split_zip_text("الفصل الأخير.txt", read("الفصل الأخير.txt"))[60]
        add(None, "الخاتمة — إعادة النسج", paragraphs, 41)

    return chapters


def write_store(chapters: list[dict]) -> None:
    DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    for existing in DERIVED_DIR.glob("volume-*.json"):
        if existing.name.startswith("volume-39") or existing.name.startswith("volume-40") or existing.name.startswith("volume-41"):
            existing.unlink()
    grouped: dict[int, list[dict]] = {}
    for chapter in chapters:
        grouped.setdefault(int(chapter["volumeNumber"]), []).append(chapter)
    chapter_meta: list[dict] = []
    for volume, volume_chapters_list in sorted(grouped.items()):
        filename = f"volume-{volume}.json"
        payload = {"bookId": ARC9_BOOK_ID, "chapters": volume_chapters_list}
        (DERIVED_DIR / filename).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        for chapter in volume_chapters_list:
            meta = {key: value for key, value in chapter.items() if key != "sentences"}
            meta["sentences"] = []
            meta["sentenceCount"] = len(chapter["sentences"])
            meta["contentFile"] = f"books/ReZero Arc 9/derived/{filename}"
            chapter_meta.append(meta)

    book = {
        "id": ARC9_BOOK_ID,
        "slug": "rezero-arc-9-arabic",
        "title": "ري:زيرو — الآرك التاسع: ضوء نجم عديم الاسم",
        "author": "تَابي ناغاتسوكي",
        "synopsis": "تبدأ حكاية جديدة بعد كارثة فولّاكيا، حيث تتقاطع العودة بالموت مع أسرار برج المراقبة ومصائر إميليا وسوبارو ورفاقهما.",
        "priceMinor": 2900,
        "currency": "SAR",
        "genre": "فانتازيا",
        "tags": ["ري:زيرو", "الآرك 9", "فانتازيا", "رواية مترجمة"],
        "coverTheme": "indigo",
        "coverUrl": "/covers/rezero-arc-9.webp",
        "status": "PUBLISHED",
        "rating": 4.9,
        "pageCount": sum(len(chapter["sentences"]) for chapter in chapters),
        "contentUnitLabel": "فصل",
        "contentUnitLabelPlural": "فصول",
        "chapters": sorted(chapter_meta, key=lambda item: item["position"]),
    }
    for path in (SEED_PATH, RUNTIME_PATH):
        store = json.loads(path.read_text(encoding="utf-8"))
        store["books"] = [item for item in store.get("books", []) if item.get("id") != ARC9_BOOK_ID]
        store["books"].append(book)
        path.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"book": book["title"], "chapters": len(chapters), "sentences": sum(len(chapter["sentences"]) for chapter in chapters)}, ensure_ascii=False))


if __name__ == "__main__":
    write_store(read_all())
