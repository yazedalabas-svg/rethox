from __future__ import annotations

import argparse
import concurrent.futures
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

BOOK_ID = "book-mushoku-tensei"
BOOK_SLUG = "mushoku-tensei-arabic"
BOOK_TITLE = "موشوكو تينسي: التجسد العاطل"
BOOK_AUTHOR = "ريفوجين نا ماغونوتي"
SPACE = re.compile(r"\s+")
PAGE_NUMBER = re.compile(r"^(?:Page\s+)?\d+$", re.I)
AD_MARKERS = (
    "stay up to date on light novels",
    "get the latest news on your favorite seven seas books",
    "visit us online: gomanga.com/newsletter",
    "download all your favorite light novels",
    "zerobooks universal",
    "jnovels.com",
    "thank you for reading",
)
META_MARKERS = (
    "table of contents",
    "copyrights and credits",
    "seven seas entertainment",
)
GLOSSARY = {
    "روديوس جرايرات": "روديوس غريرات",
    "روديوس غري رات": "روديوس غريرات",
    "روكسي ميجورديا": "روكسي ميغورديا",
    "سيلفييت": "سيلفييت",
    "سيلفي": "سيلفي",
    "إيريس بورياس غريرات": "إيريس بورياس غريرات",
    "أورستيد": "أورستد",
    "بيروجيوس": "بيروغيوس",
    "رويجيرد": "رويجيرد",
    "زانوبا": "زانوبا",
    "إله الإنسان": "إله البشر",
}
EDITORIAL_FIXES = {
    "كنت في الجانب الثقيل": "كنت بدينًا بعض الشيء",
    "كنت في خضم الندم طوال حياتي": "قضيت حياتي غارقًا في الندم",
    "عذرًا قمامة للإنسان": "إنسانًا تافهًا عديم القيمة",
    "لقد حصلت على طول مع الناس": "كنت أتفاهم مع الآخرين",
    "منغلقًا تمامًا على العمل": "منقطعًا تمامًا عن العمل",
    "أوراق السيرة الذاتية": "نماذج السيرة الذاتية",
    "متجر القرطاسية": "محل القرطاسية",
    "المتجر الصغير": "المتجر القريب",
    "لقد كنت مسقيًا": "كنت في ورطة حقيقية",
    "كان المشهد رائعًا عندما طردوني": "كانت فوضى عارمة حين طردوني",
    "لم يجذب أي شخص": "لم يكسبني ودّ أحد",
    "في منتصف طريقي للاستمناء": "أمارس العادة السرية",
    "مقدمات فرص العمل": "تعريف الباحثين بفرص العمل",
    "شخصًا غريب الأطوار ظهر كما فعلت": "شخصًا مريبًا ظهر بتلك الهيئة",
    "There were three reasons for this.": "كانت هناك ثلاثة أسباب لذلك.",
    "Dragon Meat، Nanahoshi Style Alba Fish Stew": "لحم التنين، وحساء سمك ألبا على طريقة ناناهوشي",
    "Fittoa Liege Lord James Boreas Greyrat": "حاكم فيتوا الإقطاعي، جيمس بورياس غريرات",
    "Berserker Sword King Eris": "إيريس، ملكة السيف الهائجة",
    "Sword King Nina Farion": "نينا فاريون، ملكة السيف",
    "Sword King Nina Falion": "نينا فاريون، ملكة السيف",
    "Abyssal Dragon King Maxwell": "ملك التنين السحيق ماكسويل",
    "Maniacal Dragon King Chaos": "ملك التنين المجنون كايوس",
    "King Dragon Blade Kajakut": "نصل ملك التنين كاجاكوت",
    "King Dragon Blade Kajukut": "نصل ملك التنين كاجاكوت",
    "Dragon God Urupen": "إله التنين أوروبين",
    "Armored Dragon King Perugius": "ملك التنين المدرع بيروغيوس",
    "Dragoned Dragon King Perugius": "ملك التنين المدرع بيروغيوس",
    "Dragon God Orsted": "إله التنين أورستد",
    "MAGIC ARMOR VERSION ZERO": "الدرع السحري، الإصدار صفر",
    "MAGIC ARMOR VERSION THREE": "الدرع السحري، الإصدار الثالث",
    "Magic Armor Version Zero": "الدرع السحري، الإصدار صفر",
    "Magic Armor": "الدرع السحري",
    "Sword Sanctum": "حرم السيف",
    "Ghislaine": "غيسلين",
    "Isolde": "إيزولدي",
    "Sylphie": "سيلفي",
    "Zanoba": "زانوبا",
    "Julia": "جولي",
    "Ginger": "جينجر",
    "Rudeus": "روديوس",
    "Eris": "إيريس",
    "Roxy": "روكسي",
    "Geese": "غيس",
    "Linia Dedoldia": "لينيا ديدولديا",
    "Pursena Adoldia": "بورسينا أدولديا",
    "Silent Sevenstar": "النجمة السباعية الصامتة",
    "Immortal Demon King Badigadi": "ملك الشياطين الخالد باديغادي",
}


def atomic_json(path: Path, value: Any, pretty: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    if pretty:
        payload = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    else:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    temp.write_text(payload, encoding="utf-8")
    for attempt in range(12):
        try:
            temp.replace(path)
            return
        except PermissionError:
            if attempt == 11:
                raise
            time.sleep(0.15 * (attempt + 1))


def clean_source_page(value: str) -> str:
    value = value.replace("\u00ad", "").replace("\ufeff", "")
    lines: list[str] = []
    for raw in value.replace("\t", " ").splitlines():
        line = SPACE.sub(" ", raw).strip()
        lowered = line.lower()
        if not line or PAGE_NUMBER.fullmatch(line):
            continue
        if "goldenagato" in lowered or "mp4directs.com" in lowered:
            continue
        if any(marker in lowered for marker in AD_MARKERS):
            continue
        lines.append(line)
    combined = "\n".join(lines).strip()
    lowered = combined.lower()
    if any(marker in lowered for marker in META_MARKERS):
        return ""
    return combined


def source_paragraphs(value: str) -> list[str]:
    lines = [line.strip() for line in value.splitlines() if line.strip()]
    result: list[str] = []
    buffer = ""
    heading = re.compile(r"^(?:prologue|epilogue|interlude|chapter\s+\d+|extra chapter|side story)", re.I)
    for line in lines:
        if heading.search(line):
            if buffer:
                result.append(buffer)
                buffer = ""
            result.append(line)
            continue
        candidate = f"{buffer} {line}".strip() if buffer else line
        if len(candidate) >= 760 or (len(candidate) >= 180 and re.search(r"[.!?\u201d\"]$", line)):
            result.append(candidate)
            buffer = ""
        else:
            buffer = candidate
    if buffer:
        result.append(buffer)
    return [item for item in result if len(item) > 1]


def translate_chunk(text: str, attempts: int = 7) -> str:
    query = urllib.parse.urlencode(
        {"client": "gtx", "sl": "en", "tl": "ar", "dt": "t", "q": text}
    )
    url = "https://translate.googleapis.com/translate_a/single?" + query
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.loads(response.read().decode("utf-8"))
            translated = "".join(part[0] for part in payload[0] if part and part[0])
            translated = SPACE.sub(" ", translated).strip()
            for old, new in GLOSSARY.items():
                translated = translated.replace(old, new)
            if translated:
                return translated
        except Exception:
            if attempt + 1 == attempts:
                raise
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError("translation failed")


def source_blocks(extracted: dict[str, Any]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    buffer = ""
    buffer_page = 0
    heading = re.compile(
        r"^(?:prologue|epilogue|interlude|chapter\s+\d+|extra chapter|side story)", re.I
    )

    def flush(end_page: int) -> None:
        nonlocal buffer, buffer_page
        if buffer.strip():
            blocks.append(
                {
                    "id": f"P{len(blocks) + 1:05d}",
                    "startPage": buffer_page or end_page,
                    "endPage": end_page,
                    "text": buffer.strip(),
                }
            )
        buffer = ""
        buffer_page = 0

    for page in extracted["pages"]:
        page_number = int(page["page"])
        if page["images"] and not page["text"]:
            flush(max(1, page_number - 1))
            continue
        lines = [line.strip() for line in page["text"].splitlines() if line.strip()]
        for line in lines:
            if heading.search(line):
                flush(page_number)
                blocks.append(
                    {
                        "id": f"P{len(blocks) + 1:05d}",
                        "startPage": page_number,
                        "endPage": page_number,
                        "text": line,
                    }
                )
                continue
            if not buffer:
                buffer_page = page_number
            candidate = f"{buffer} {line}".strip() if buffer else line
            if len(candidate) >= 900 or (
                len(candidate) >= 180 and re.search(r"[.!?\u201d\"]$", line)
            ):
                buffer = candidate
                flush(page_number)
            else:
                buffer = candidate
    if extracted["pages"]:
        flush(int(extracted["pages"][-1]["page"]))
    return blocks


def grouped_blocks(blocks: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    size = 0
    for block in blocks:
        addition = len(block["text"]) + 18
        if current and size + addition > 4100:
            groups.append(current)
            current = []
            size = 0
        current.append(block)
        size += addition
    if current:
        groups.append(current)
    return groups


def translate_group(group: list[dict[str, Any]]) -> dict[str, str]:
    payload = "\n".join(f"[[[{item['id']}]]] {item['text']}" for item in group)
    translated = translate_chunk(payload)
    marker = re.compile(r"\[\[\[(P\d{5})\]\]\]\s*")
    matches = list(marker.finditer(translated))
    if len(matches) != len(group):
        return {item["id"]: translate_chunk(item["text"]) for item in group}
    result: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(translated)
        result[match.group(1)] = translated[match.end():end].strip()
    if set(result) != {item["id"] for item in group}:
        return {item["id"]: translate_chunk(item["text"]) for item in group}
    return result


def polish_translation(value: str) -> str:
    value = value.replace("\u200e", "").replace("\u200f", "")
    value = value.replace("\u00a0", " ").replace("...", "…").replace("***", "—")
    for old, new in EDITORIAL_FIXES.items():
        value = value.replace(old, new)
    for marker in (
        "احصل على آخر الأخبار حول كتب Seven Seas",
        "أو قم بزيارتنا عبر الإنترنت: gomanga.com/newsletter",
    ):
        if marker in value:
            value = value.split(marker, 1)[0].rstrip()
    if value.startswith("يقوم الفريق بإنشاء تحويل عن طريق الحصول على"):
        value = (
            "خطة الفرق: يتولى فريق سيلفي، برفقة غيسلين وإيزولدي، إحضار نينا من حرم السيف "
            "لصنع تمويه. يتوجه زانوبا وجولي وجينجر إلى العاصمة، وروديوس إلى المدينة الثانية، "
            "وإيريس وروكسي إلى المدينة الثالثة. ينشئ كل فريق دائرة انتقال آني، ثم يبدأ البحث "
            "عن غيس وإله الشمال. وستلتزم سيلفي بالخطة التي ناقشناها."
        )
    value = re.sub(r"\s+([،؛؟.!])", r"\1", value)
    value = re.sub(r"([،؛؟])(?=\S)", r"\1 ", value)
    value = re.sub(r"([،؛؟.!…])\s+\"", r'\1"', value)
    value = value.replace("كانت زانوبا", "كان زانوبا").replace("قالت زانوبا", "قال زانوبا")
    value = value.replace("زانوبا هي الوحيدة", "زانوبا هو الوحيد")
    value = value.replace("نبوءة الإنسان الإله", "نبوءة إله البشر")
    return SPACE.sub(" ", value).strip()


def volume_number(path: Path) -> int:
    match = re.search(r"Vol\.\s*(\d+)", path.name, re.I)
    if not match:
        raise ValueError(f"volume number missing from {path.name}")
    return int(match.group(1))


def extract_volume(pdf_path: Path, cache_dir: Path, asset_root: Path) -> dict[str, Any]:
    number = volume_number(pdf_path)
    extracted_path = cache_dir / f"volume-{number:02d}-extracted.json"
    if extracted_path.exists():
        return json.loads(extracted_path.read_text(encoding="utf-8"))

    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    if reader.is_encrypted and not reader.decrypt(""):
        raise RuntimeError(f"unable to open {pdf_path.name}")
    pages: list[dict[str, Any]] = []
    volume_assets = asset_root / f"volume-{number:02d}"
    volume_assets.mkdir(parents=True, exist_ok=True)

    for page_number, page in enumerate(reader.pages, start=1):
        raw_text = page.extract_text() or ""
        images: list[str] = []
        for image_number, image in enumerate(page.images, start=1):
            if len(image.data) < 30_000:
                continue
            extension = Path(image.name).suffix.lower() or ".jpg"
            filename = f"page-{page_number:03d}-image-{image_number:02d}{extension}"
            target = volume_assets / filename
            if not target.exists():
                target.write_bytes(image.data)
            images.append(
                f"/Mushoku%20Tensei/assets/volume-{number:02d}/{urllib.parse.quote(filename)}"
            )
        text = clean_source_page(raw_text)
        if images and len(text) < 120:
            text = ""
        pages.append({"page": page_number, "text": text, "images": images})

    result = {"volume": number, "pageCount": len(reader.pages), "pages": pages}
    atomic_json(extracted_path, result)
    return result


def translate_volume(extracted: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    number = int(extracted["volume"])
    translated_path = cache_dir / f"volume-{number:02d}-translated-v2.json"
    cache: dict[str, str] = {}
    if translated_path.exists():
        cache = json.loads(translated_path.read_text(encoding="utf-8")).get("blocks", {})
    blocks = source_blocks(extracted)
    pending = [item for item in blocks if item["id"] not in cache]

    jobs: dict[concurrent.futures.Future[dict[str, str]], list[dict[str, Any]]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        for group in grouped_blocks(pending):
            jobs[executor.submit(translate_group, group)] = group
        for future in concurrent.futures.as_completed(jobs):
            group = jobs[future]
            cache.update(future.result())
            atomic_json(translated_path, {"volume": number, "blocks": cache})
            print(
                f"volume={number:02d} translated_blocks={group[0]['id']}-{group[-1]['id']}",
                flush=True,
            )

    atomic_json(translated_path, {"volume": number, "blocks": cache})
    return {"volume": number, "blocks": cache, "sourceBlocks": blocks}


def build_volume(extracted: dict[str, Any], translated: dict[str, Any]) -> dict[str, Any]:
    number = int(extracted["volume"])
    sentences: list[dict[str, Any]] = []
    illustrations: list[dict[str, Any]] = []
    sentence_pages: list[tuple[int, str]] = []
    for block in translated["sourceBlocks"]:
        paragraph = polish_translation(translated["blocks"][block["id"]])
        if not paragraph:
            continue
        position = len(sentences) + 1
        sentence_id = f"mt-v{number:02d}-p{position:05d}"
        sentences.append(
            {"id": sentence_id, "position": position, "text": paragraph, "tokens": []}
        )
        sentence_pages.append((int(block["endPage"]), sentence_id))
    for page in extracted["pages"]:
        page_number = int(page["page"])
        last_sentence_id = next(
            (sentence_id for end_page, sentence_id in reversed(sentence_pages) if end_page < page_number),
            None,
        )
        for image_number, source in enumerate(page["images"], start=1):
            illustration: dict[str, Any] = {
                "id": f"mt-v{number:02d}-page{page_number:03d}-img{image_number:02d}",
                "src": source,
                "alt": f"رسم أصلي من المجلد {number} - الصفحة {page_number}",
                "position": len(illustrations) + 1,
            }
            if last_sentence_id:
                illustration["afterSentenceId"] = last_sentence_id
            illustrations.append(illustration)
    words = sum(len(item["text"].split()) for item in sentences)
    return {
        "id": f"ch-mushoku-tensei-vol-{number:02d}",
        "bookId": BOOK_ID,
        "title": f"المجلد {number}",
        "position": number,
        "durationMs": max(1, words * 430),
        "isSample": True,
        "sentences": sentences,
        "illustrations": illustrations,
    }


def update_stores(project: Path, volumes: list[dict[str, Any]], page_counts: dict[int, int]) -> None:
    derived = project / "apps" / "api" / "data" / "books" / "Mushoku Tensei" / "derived"
    derived.mkdir(parents=True, exist_ok=True)
    chapter_meta: list[dict[str, Any]] = []
    for volume in sorted(volumes, key=lambda item: item["position"]):
        number = int(volume["position"])
        filename = f"volume-{number:02d}.json"
        atomic_json(derived / filename, {"bookId": BOOK_ID, "chapters": [volume]}, pretty=False)
        meta = {key: value for key, value in volume.items() if key != "sentences"}
        meta["sentences"] = []
        meta["sentenceCount"] = len(volume["sentences"])
        meta["contentFile"] = f"books/Mushoku Tensei/derived/{filename}"
        chapter_meta.append(meta)

    cover = "/covers/mushoku-tensei.jpg"
    book = {
        "id": BOOK_ID,
        "slug": BOOK_SLUG,
        "title": BOOK_TITLE,
        "author": BOOK_AUTHOR,
        "synopsis": "يُمنح رجل أخفق في حياته فرصة جديدة حين يولد في عالم من السحر والسيوف باسم روديوس غريرات، فيعزم على عيش حياته الثانية بلا ندم.",
        "priceMinor": 0,
        "currency": "SAR",
        "genre": "فانتازيا",
        "tags": ["موشوكو تينسي", "إيسيكاي", "فانتازيا", "رواية مترجمة"],
        "coverTheme": "indigo",
        "coverUrl": cover,
        "status": "PUBLISHED",
        "rating": 0,
        "contentUnitLabel": "مجلد",
        "contentUnitLabelPlural": "مجلدات",
        "pageCount": sum(page_counts.values()),
        "chapters": chapter_meta,
    }
    for store_path in (
        project / "apps" / "api" / "data" / "deploy-seed.json",
        project / "apps" / "api" / "data" / "runtime-store.json",
    ):
        if not store_path.exists():
            continue
        store = json.loads(store_path.read_text(encoding="utf-8"))
        books = store.setdefault("books", [])
        index = next((i for i, item in enumerate(books) if item.get("id") == BOOK_ID), None)
        if index is None:
            books.append(book)
        else:
            books[index] = book
        atomic_json(store_path, store)


def main() -> None:
    parser = argparse.ArgumentParser(description="Import and translate Mushoku Tensei PDFs")
    parser.add_argument("source", type=Path)
    parser.add_argument("project", type=Path)
    parser.add_argument("--from-volume", type=int, default=1)
    parser.add_argument("--to-volume", type=int, default=26)
    args = parser.parse_args()
    source = args.source.resolve()
    project = args.project.resolve()
    cache_dir = project / "tmp" / "pdfs" / "mushoku-tensei"
    asset_root = source / "assets"
    pdfs = {volume_number(path): path for path in source.glob("*.pdf")}
    selected = range(args.from_volume, args.to_volume + 1)
    missing = [number for number in selected if number not in pdfs]
    if missing:
        raise RuntimeError(f"missing PDF volumes: {missing}")

    completed: list[dict[str, Any]] = []
    page_counts: dict[int, int] = {}
    derived = project / "apps" / "api" / "data" / "books" / "Mushoku Tensei" / "derived"
    for existing in sorted(derived.glob("volume-*.json")) if derived.exists() else []:
        payload = json.loads(existing.read_text(encoding="utf-8"))
        if payload.get("chapters"):
            volume = payload["chapters"][0]
            completed.append(volume)
            page_counts[int(volume["position"])] = 0

    for number in selected:
        print(f"volume={number:02d} extracting", flush=True)
        extracted = extract_volume(pdfs[number], cache_dir, asset_root)
        page_counts[number] = int(extracted["pageCount"])
        translated = translate_volume(extracted, cache_dir)
        volume = build_volume(extracted, translated)
        completed = [item for item in completed if item["position"] != number]
        completed.append(volume)
        update_stores(project, completed, page_counts)
        print(
            f"volume={number:02d} complete sentences={len(volume['sentences'])} "
            f"images={len(volume['illustrations'])}",
            flush=True,
        )


if __name__ == "__main__":
    main()
