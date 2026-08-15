from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT = Path(__file__).resolve().parents[1]
SOURCE_DIR = PROJECT / "apps" / "web" / "public" / "re zero arc 7 - 9"
PUBLIC_DIR = PROJECT / "apps" / "web" / "public"
DATA_DIR = PROJECT / "apps" / "api" / "data"
CACHE_DIR = PROJECT / "tmp" / "pdfs" / "rezero-arcs"
LATIN = re.compile(r"[A-Za-z]")
LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z'’~-]*")
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]")
SPACE = re.compile(r"[ \t]+")
CHAPTER_HEADING = re.compile(
    r"^Arc\s+(?P<arc>[78])\s+(?P<kind>Chapter\s+(?P<number>\d+)|Intermission|Curtain[’']s\s+Close)\s*[–—―-]\s*(?P<title>.+?)\s*$",
    re.IGNORECASE,
)
VOLUME_HEADING = re.compile(r"Web\s+Novel\s+Volume\s+(?P<number>\d+)", re.IGNORECASE)
SOURCE_HEADER = re.compile(r"Re:\s*Zero\s+kara\s+Hajimeru\s+Isekai\s+Seikatsu", re.IGNORECASE)
ARC_HEADER = re.compile(r"Web\s+Novel\s+Arc\s+[78]\s*,[^\n]*", re.IGNORECASE)


@dataclass(frozen=True)
class ArcConfig:
    number: int
    pdf_name: str
    book_id: str
    slug: str
    title: str
    synopsis: str
    cover_url: str
    cover_theme: str


ARCS = {
    7: ArcConfig(
        number=7,
        pdf_name="695648558-WN-ReZero-Arc-7-Dark.pdf",
        book_id="book-rezero-arc-7",
        slug="rezero-arc-7-arabic",
        title="ري:زيرو — الآرك السابع: أرض الذئاب",
        synopsis=(
            "يجد ناتسوكي سوبارو نفسه في إمبراطورية فولّاكيا البعيدة، منفصلًا عن رفاقه، "
            "فيخوض صراعًا قاسيًا للعودة وحماية من معه وسط حرب تهز أرض الذئاب."
        ),
        cover_url="/covers/rezero-arc-7.webp",
        cover_theme="ember",
    ),
    8: ArcConfig(
        number=8,
        pdf_name="835410282-WN-ReZero-Arc-8-Dark.pdf",
        book_id="book-rezero-arc-8",
        slug="rezero-arc-8-arabic",
        title="ري:زيرو — الآرك الثامن: فنسنت فولّاكيا",
        synopsis=(
            "تدخل الإمبراطورية طور الكارثة الكبرى، ويقف سوبارو وفنسنت وحلفاؤهما في وجه جيش "
            "لا يعرف الموت، في معركة تحسم مصير فولّاكيا ومن بقي فيها."
        ),
        cover_url="/covers/rezero-arc-8.webp",
        cover_theme="indigo",
    ),
}


NAME_REPLACEMENTS = {
    "Natsuki Subaru": "ناتسوكي سوبارو",
    "Subaru Natsuki": "ناتسوكي سوبارو",
    "Subaru": "سوبارو",
    "Emilia": "إميليا",
    "Rem": "ريم",
    "Ram": "رام",
    "Beatrice": "بياتريس",
    "Vincent Vollachia": "فنسنت فولّاكيا",
    "Vincent": "فنسنت",
    "Vollachian Empire": "إمبراطورية فولّاكيا",
    "Vollachia": "فولّاكيا",
    "Louis Arneb": "لوي أرنيب",
    "Louis": "لوي",
    "Shaula": "شاولا",
    "Julius": "يوليوس",
    "Meili": "ميلي",
    "Priscilla Barielle": "بريسيلا بارييل",
    "Priscilla": "بريسيلا",
    "Abel": "أبيل",
    "Todd Fang": "تود فانغ",
    "Todd": "تود",
    "Cecilus Segmunt": "سيسيلوس سيغمونت",
    "Cecilus": "سيسيلوس",
    "Chisha Gold": "شيشا غولد",
    "Chisha": "شيشا",
    "Anastasia": "أناستازيا",
    "Echidna": "إيكيدنا",
    "Roswaal": "روزوال",
    "Garfiel": "غارفيل",
    "Petra": "بيترا",
    "Otto": "أوتو",
    "Patrasche": "باتراش",
    "Arakiya": "أراكيّا",
    "Medium O'Connell": "ميديوم أوكونيل",
    "Medium O’Connell": "ميديوم أوكونيل",
    "Berstetz Fondalfon": "بيرستيتز فوندالفون",
    "Olbart Dunkelkenn": "أولبارت دنكلكن",
    "Goz Ralfon": "غوز رالفون",
    "Ubilk": "أوبيلك",
    "Izmail": "إزمايل",
    "Sphinx": "سفينكس",
    "Shudraq": "شودراك",
    "Pleiades": "الثريا",
}

STORY_TERM_REPLACEMENTS = {
    "Return by Death": "العودة بالموت",
    "Witch Cult": "عبادة الساحرة",
    "Witch Beasts": "الوحوش الساحرة",
    "Witchbeasts": "الوحوش الساحرة",
    "Witch Beast": "وحش ساحر",
    "Witchbeast": "وحش ساحر",
    "Great Disaster": "الكارثة الكبرى",
    "Divine Generals": "الجنرالات السماويون",
    "Divine General": "جنرال سماوي",
    "Pleiades Watchtower": "برج مراقبة الثريا",
    "Earth Dragon": "تنين الأرض",
    "Miasma": "المياسما",
    "miasma": "المياسما",
    "Stargazers": "مراقبو النجوم",
    "Stargazer": "مراقب النجوم",
    "Undead": "الموتى الأحياء",
    "undead": "الموتى الأحياء",
}

EDITORIAL_TITLES = {
    (7, 1): "الاستهلال",
    (7, 10): "شعب شودراك",
    (7, 11): "طقوس دم الحياة",
    (7, 19): "لقاء مثير للحنق",
    (7, 25): "لقاء كدمٍ متّقد",
    (7, 26): "مؤتمر المائدة المستديرة الراقص",
    (7, 30): "ناتسوكي سوبارو، البطل الذي نصّب نفسه",
    (7, 31): "حديث بين أبناء الوطن",
    (7, 33): "والآن، إلى الرحلة صوب مدينة الشياطين",
    (7, 38): "مكافأة انتُظرت ثمانية أعوام",
    (7, 39): "شرس",
    (7, 47): "غير الفاني ■■",
    (7, 54): "يوتوبيا كايوس فليم",
    (7, 56): "الكارثة الكبرى",
    (7, 60): "غرس شتلة الفوضى",
    (7, 68): "إرشاد ذئب السيف",
    (7, 75): "أنا أعرف",
    (7, 77): "التواء القدر",
    (7, 79): "قهقهة قرمزية مدوّية",
    (7, 82): "مقصد المتمردين",
    (7, 86): "الحصون الخمسة",
    (7, 94): "عزيمة من أجل مَن؟",
    (7, 95): "أعداء عند كل الحصون",
    (7, 96): "لوحة حب عميق",
    (7, 97): "القادمون من وراء الغرب",
    (7, 98): "كتيبة الثريا",
    (7, 100): "تحولات لا تُحصى في الحصون",
    (7, 102): "جدار العزم",
    (7, 103): "العد التنازلي للنجوم",
    (7, 107): "شيشا غولد",
    (7, 108): "الكارثة الكبرى الوشيكة",
    (7, 109): "ذئب سيف الإمبراطورية",
    (8, 11): "اخرس بحق الجحيم",
    (8, 13): "لكلٍّ جراحه",
    (8, 16): "كارثة الموتى الأحياء",
    (8, 17): "تايشوهو سحرية",
    (8, 22): "أريد أن أصدق، لكنني لن أسامح",
    (8, 29): "لم أُرِد أن أحب",
    (8, 33): "الحكم على الحب",
    (8, 34): "لن أسامحك حتى تشرح",
    (8, 36): "لوبوغانا، عاصمة الموتى الأحياء",
    (8, 37): "وقت التمهيد",
    (8, 42): "العبد الأعظم",
    (8, 43): "لكلٍّ أمانيه التي طال انتظارها",
    (8, 44): "أوبيلك (الجزء أ)",
    (8, 45): "أوبيلك (الجزء ب)",
    (8, 47): "كيف تُسقَط النجوم",
    (8, 54): "ميديوم أوكونيل",
    (8, 55): "القناص السحري",
    (8, 56): "سوماتو",
    (8, 58): "أراكيّا",
    (8, 59): "سيسيلوس سيغمونت",
    (8, 61): "سفينكس",
    (8, 66): "أبٌ وابنٌ من الإمبراطورية",
    (8, 69): "ما في اليد من أوراق",
    (8, 70): "الرجل الذي أحببته",
    (8, 71): "لقد سامحتك",
    (8, 73): "أحلام بطولية",
    (8, 75): "خصمان جمعهما القدر",
    (8, 76): "الحب",
}


TRANSLATION_SYSTEM = """أنت مترجم ومحرر أدبي عربي متخصص في رواية ري:زيرو.
ترجم كل قيمة في كائن JSON المرسل من الإنجليزية إلى عربية فصيحة روائية طبيعية، من دون اختصار أو حذف أو إضافة.
أعد كائن JSON صالحًا فقط، وبالمفاتيح نفسها تمامًا. لا تستخدم Markdown ولا تكتب أي شرح خارج JSON.
حافظ على الحوار، النبرة، الفواصل المشهدية، أرقام الحواشي، والمعنى الدقيق. ترجم ملاحظات المترجم نفسها إلى العربية.
حوّل أسماء المتحدثين والمصطلحات الإنجليزية إلى العربية، ولا تُبقِ كلمات إنجليزية إلا إذا استحال نقلها، وفي هذه الحالة عرّب لفظها.
أي ظهور لحرف لاتيني في الناتج مرفوض؛ عرّب حتى الأصوات المختصرة والكلمات اليابانية المكتوبة باللاتينية.
اعتمد هذه الصيغ دائمًا: Natsuki Subaru=ناتسوكي سوبارو، Subaru=سوبارو، Emilia=إميليا، Rem=ريم، Ram=رام، Beatrice=بياتريس، Vincent Vollachia=فنسنت فولّاكيا، Vollachia=فولّاكيا، Louis=لوي، Shaula=شاولا، Julius=يوليوس، Meili=ميلي، Priscilla=بريسيلا، Cecilus=سيسيلوس، Chisha=شيشا، Todd=تود، Echidna=إيكيدنا.
استخدم علامات الترقيم العربية واتجاهًا طبيعيًا من اليمين إلى اليسار. لا تترجم أسماء الشخصيات إلى معانيها الحرفية."""


def atomic_json(path: Path, value: Any, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps(
        value,
        ensure_ascii=False,
        indent=2 if pretty else None,
        separators=None if pretty else (",", ":"),
    )
    temporary.write_text(payload + ("\n" if pretty else ""), encoding="utf-8")
    for attempt in range(12):
        try:
            temporary.replace(path)
            return
        except PermissionError:
            if attempt == 11:
                raise
            time.sleep(0.15 * (attempt + 1))


def load_project_env() -> None:
    for candidate in (PROJECT / ".env.local", PROJECT / ".env"):
        if not candidate.exists():
            continue
        for raw in candidate.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def clean_text(value: str) -> str:
    value = value.replace("\u00ad", "").replace("\ufeff", "")
    value = value.replace("�", "\"").replace("…", "…")
    value = value.replace(" - ", " — ")
    value = re.sub(r"\s+([،؛؟.!…])", r"\1", value)
    value = re.sub(r"([،؛؟])(?=\S)", r"\1 ", value)
    return SPACE.sub(" ", value).strip()


def public_url(path: Path) -> str:
    return "/" + path.relative_to(PUBLIC_DIR).as_posix().replace(" ", "%20")


def heading_from_line(line: str, arc: int) -> re.Match[str] | None:
    stripped = SPACE.sub(" ", line).strip()
    if "..." in stripped or "…" in stripped:
        return None
    match = CHAPTER_HEADING.fullmatch(stripped)
    if not match or int(match.group("arc")) != arc:
        return None
    if re.search(r"\s\d+\s*$", match.group("title")):
        return None
    return match


def paragraph_chunks(layout: str, arc: int) -> list[str]:
    normalized_lines: list[str] = []
    for raw in layout.replace("\r", "").split("\n"):
        line = SOURCE_HEADER.sub("", raw)
        line = ARC_HEADER.sub("", line)
        line = VOLUME_HEADING.sub("", line)
        line = SPACE.sub(" ", line).strip()
        if not line:
            normalized_lines.append("")
            continue
        if re.fullmatch(r"\d+", line):
            continue
        if heading_from_line(line, arc):
            continue
        normalized_lines.append(line)

    paragraphs: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        if not buffer:
            return
        value = clean_text(" ".join(buffer))
        buffer.clear()
        if value:
            paragraphs.append(value)

    for line in normalized_lines:
        if not line:
            flush()
        else:
            buffer.append(line)
    flush()

    ignored_starts = (
        "Light Novel Adaptation",
        "Original Web Novel Chapter",
        "Original Translation by",
        "Edited Machine Translation by",
        "Partial Human Translation by",
        "Partial Edited Machine Translation by",
        "Translated by",
        "Proofread by",
        "Character Pages for Volume",
        "Illustration from Volume",
        "Light Novel Illustration",
        "Colored Light Novel Illustration",
        "Commissioned Illustration",
        "Table of Contents",
        "Other Volumes",
    )
    return [
        value
        for value in paragraphs
        if not value.startswith(ignored_starts)
        and not (
            "Witch Cult Translations" in value
            and ("Translation" in value or "Proofread" in value)
        )
        and not SOURCE_HEADER.search(value)
        and not ARC_HEADER.search(value)
        and (any(character.isalnum() for character in value) or len(value) > 2)
    ]


def join_page_fragments(existing: list[dict[str, Any]], incoming: list[str], page: int) -> None:
    if incoming and existing:
        previous = existing[-1]["text"].rstrip()
        current = incoming[0].lstrip()
        should_join = bool(
            previous
            and current
            and (
                previous.endswith((",", ";", ":", "—"))
                or (
                    previous[-1].isalnum()
                    and current[0].islower()
                )
            )
        )
        if should_join:
            existing[-1]["text"] = clean_text(previous + " " + current)
            existing[-1]["endPage"] = page
            incoming = incoming[1:]
    for value in incoming:
        existing.append({"text": value, "startPage": page, "endPage": page})


def extract_page_images(page: Any, arc: int, page_number: int) -> list[str]:
    urls: list[str] = []
    target_dir = PUBLIC_DIR / "illustrations" / f"rezero-arc-{arc}"
    target_dir.mkdir(parents=True, exist_ok=True)
    for image_index, image in enumerate(page.images, start=1):
        if len(image.data) < 50_000:
            continue
        size = getattr(getattr(image, "image", None), "size", (0, 0))
        if size[0] * size[1] < 300_000:
            continue
        extension = Path(image.name).suffix.lower()
        if extension not in {".jpg", ".jpeg", ".png", ".webp"}:
            extension = ".jpg"
        filename = f"page-{page_number:04d}-image-{image_index:02d}{extension}"
        target = target_dir / filename
        if not target.exists():
            target.write_bytes(image.data)
        urls.append(public_url(target))
    return urls


def extract_arc(config: ArcConfig, refresh: bool = False) -> dict[str, Any]:
    cache_path = CACHE_DIR / f"arc-{config.number}" / "extracted.json"
    if cache_path.exists() and not refresh:
        return json.loads(cache_path.read_text(encoding="utf-8"))

    from pypdf import PdfReader

    pdf_path = SOURCE_DIR / config.pdf_name
    if not pdf_path.exists():
        raise FileNotFoundError(pdf_path)
    reader = PdfReader(str(pdf_path))
    current_volume: int | None = None
    current: dict[str, Any] | None = None
    chapters: list[dict[str, Any]] = []

    for page_number, page in enumerate(reader.pages, start=1):
        layout = page.extract_text(extraction_mode="layout") or ""
        if current is not None and any(
            SPACE.sub(" ", line).strip().lower() == "other volumes"
            for line in layout.splitlines()
        ):
            break
        volume_matches = list(VOLUME_HEADING.finditer(layout))
        if volume_matches:
            current_volume = int(volume_matches[-1].group("number"))

        detected: re.Match[str] | None = None
        for line in layout.splitlines():
            match = heading_from_line(line, config.number)
            if match:
                detected = match
                break
        if detected:
            kind = detected.group("kind")
            source_title = clean_text(detected.group("title"))
            identity = f"{kind.lower()}::{source_title.lower()}"
            if current is None or current["identity"] != identity:
                current = {
                    "identity": identity,
                    "kind": kind,
                    "number": int(detected.group("number")) if detected.group("number") else None,
                    "sourceTitle": source_title,
                    "volumeNumber": current_volume,
                    "startPage": page_number,
                    "endPage": page_number,
                    "paragraphs": [],
                    "images": [],
                }
                chapters.append(current)

        if current is None:
            if page_number % 100 == 0:
                print(f"arc={config.number} extracting page={page_number}/{len(reader.pages)}", flush=True)
            continue

        current["endPage"] = page_number
        chunks = paragraph_chunks(layout, config.number)
        if chunks and chunks[-1].startswith("Other Volumes"):
            chunks = chunks[:-1]
        join_page_fragments(current["paragraphs"], chunks, page_number)
        for source in extract_page_images(page, config.number, page_number):
            current["images"].append({"src": source, "page": page_number})

        if page_number % 100 == 0:
            print(f"arc={config.number} extracting page={page_number}/{len(reader.pages)}", flush=True)

    for index, chapter in enumerate(chapters, start=1):
        chapter.pop("identity", None)
        chapter["position"] = index
        if chapter["volumeNumber"] is None:
            raise ValueError(f"volume missing for arc {config.number}, chapter {index}")
        for paragraph_index, paragraph in enumerate(chapter["paragraphs"], start=1):
            paragraph["id"] = f"a{config.number}-c{index:03d}-p{paragraph_index:04d}"

    result = {
        "arc": config.number,
        "pageCount": len(reader.pages),
        "source": str(pdf_path),
        "chapters": chapters,
    }
    atomic_json(cache_path, result)
    return result


def parse_json_object(content: str) -> dict[str, str]:
    value = content.strip()
    if value.startswith("```"):
        value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.IGNORECASE)
        value = re.sub(r"\s*```$", "", value)
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        start = value.find("{")
        end = value.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(value[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("translation response is not an object")
    return {str(key): str(item).strip() for key, item in parsed.items()}


def arabic_ratio(value: str) -> float:
    letters = [character for character in value if character.isalpha()]
    if not letters:
        return 1.0
    arabic = sum("\u0600" <= character <= "\u06ff" for character in letters)
    return arabic / len(letters)


def replace_known_names(value: str) -> str:
    for source, target in sorted(NAME_REPLACEMENTS.items(), key=lambda pair: len(pair[0]), reverse=True):
        value = re.sub(rf"\b{re.escape(source)}\b", target, value, flags=re.IGNORECASE)
    value = value.replace("\u200e", "").replace("\u200f", "").replace("\ufeff", "")
    value = value.replace("...", "…")
    value = value.replace("“", "«").replace("”", "»")
    value = value.replace("『", "«").replace("』", "»")
    value = value.replace("「", "«").replace("」", "»")
    value = re.sub(r'"([^"\n]+)"', r"«\1»", value)
    # The English source occasionally includes the original Japanese spelling
    # in parentheses. The Arabic text already carries the meaning, so keeping
    # those glyphs only creates mixed-direction reader and TTS glitches.
    value = re.sub(
        r"\s*[\(（][^()（）\n]*[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff][^()（）\n]*[\)）]",
        "",
        value,
    )
    value = CJK.sub("", value)
    value = re.sub(r"[«‹‘]\s*[»›’]", "", value)
    for source, target in {
        "باتراشي": "باتراش",
        "أستازيا": "أناستازيا",
        "اناستازيا": "أناستازيا",
        "فولاشيا": "فولّاكيا",
        "فولاتشيا": "فولّاكيا",
        "فولاكيا": "فولّاكيا",
        "فينسنت": "فنسنت",
        "سيجمونت": "سيغمونت",
        "لويس أرنيب": "لوي أرنيب",
        "لويس": "لوي",
        "أبو الهول": "سفينكس",
        "أوندد": "الموتى الأحياء",
        "شدرق": "شودراك",
        "اراكيا": "أراكيّا",
        "الكارثة العظيمة": "الكارثة الكبرى",
        "الكارثة العظمى": "الكارثة الكبرى",
    }.items():
        value = value.replace(source, target)
    value = re.sub(r"\s+([،؛؟.!…])", r"\1", value)
    value = re.sub(r"([،؛؟])(?=[^\s؟:])", r"\1 ", value)
    value = re.sub(
        r"((?:؟\s*){2,})\s*:",
        lambda match: match.group(1).replace(" ", "") + ":",
        value,
    )
    return SPACE.sub(" ", value).strip()


def protect_source_terms(value: str) -> str:
    value = "".join(
        character
        for character in unicodedata.normalize("NFKD", value)
        if unicodedata.category(character) != "Mn"
    )
    replacements = {**STORY_TERM_REPLACEMENTS, **NAME_REPLACEMENTS}
    for source, target in sorted(replacements.items(), key=lambda pair: len(pair[0]), reverse=True):
        value = re.sub(rf"\b{re.escape(source)}\b", target, value, flags=re.IGNORECASE)
    return value


def valid_translation(source: str, value: str) -> bool:
    if not value or LATIN.search(value) or CJK.search(value):
        return False
    return len(source) <= 40 or arabic_ratio(value) >= 0.72


def is_editorial_note(value: str) -> bool:
    stripped = value.strip()
    if re.match(
        r"^\(?\s*(?:TL|TN|Translator(?:'s)?|Translation|Editor(?:'s)?)\s+Note\s*:",
        stripped,
        flags=re.IGNORECASE,
    ):
        return True
    return bool(re.match(r"^\d{1,3}\s+", stripped) and CJK.search(stripped))


def phonetic_arabize(word: str) -> str:
    value = word.lower().replace("’", "'")
    groups = (
        ("tch", "تش"), ("sch", "ش"), ("ch", "تش"), ("sh", "ش"),
        ("th", "ث"), ("ph", "ف"), ("kh", "خ"), ("gh", "غ"),
        ("ck", "ك"), ("qu", "كو"), ("ee", "ي"), ("oo", "و"),
    )
    for source, target in groups:
        value = value.replace(source, target)
    letters = {
        "a": "ا", "b": "ب", "c": "ك", "d": "د", "e": "ي", "f": "ف",
        "g": "غ", "h": "ه", "i": "ي", "j": "ج", "k": "ك", "l": "ل",
        "m": "م", "n": "ن", "o": "و", "p": "ب", "q": "ق", "r": "ر",
        "s": "س", "t": "ت", "u": "و", "v": "ف", "w": "و", "x": "كس",
        "y": "ي", "z": "ز", "'": "",
    }
    return "".join(letters.get(character, character) for character in value) or "لفظ"


def clean_residual_latin(value: str, translate_word: Any) -> str:
    fixed_terms = {
        "Re:Zero": "ري:زيرو",
        "ReZero": "ري:زيرو",
        "MVP": "أفضل لاعب",
        "SFX": "مؤثر صوتي",
        "Engrish": "إنجليزية ركيكة",
        "hanamichi": "هاناميتشي",
        "Witchbeast": "وحش ساحر",
        "Witchbeasts": "الوحوش الساحرة",
        "Miasma": "المياسما",
    }
    for source, target in fixed_terms.items():
        value = value.replace(source, target)
    for word in sorted(set(LATIN_WORD.findall(value)), key=len, reverse=True):
        try:
            translated = replace_known_names(translate_word(word, "en"))
        except Exception:
            translated = ""
        if not translated or LATIN.search(translated):
            translated = phonetic_arabize(word)
        value = value.replace(word, translated)
    return replace_known_names(value)


class Translator:
    def __init__(self, workers: int) -> None:
        load_project_env()
        self.api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
        if not self.api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required for the literary translation")
        self.model = os.environ.get("OPENROUTER_TRANSLATION_MODEL") or os.environ.get("OPENROUTER_MODEL") or "openai/gpt-4o-mini"
        self.workers = max(1, workers)

    def request(self, items: dict[str, str], attempts: int = 7) -> dict[str, str]:
        body = json.dumps(
            {
                "model": self.model,
                "temperature": 0.15,
                "max_tokens": 12000,
                "messages": [
                    {"role": "system", "content": TRANSLATION_SYSTEM},
                    {"role": "user", "content": json.dumps(items, ensure_ascii=False)},
                ],
            },
            ensure_ascii=False,
        ).encode("utf-8")
        failure: Exception | None = None
        for attempt in range(attempts):
            request = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                    "HTTP-Referer": "https://rethox.online",
                    "X-Title": "rethox",
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
                translated = parse_json_object(content)
                if set(translated) != set(items):
                    raise ValueError("translation keys changed")
                cleaned = {key: replace_known_names(value) for key, value in translated.items()}
                invalid = [key for key, value in cleaned.items() if not valid_translation(items[key], value)]
                if invalid:
                    raise ValueError(f"translation validation failed: {invalid[:3]}")
                return cleaned
            except (OSError, ValueError, KeyError, IndexError, json.JSONDecodeError) as error:
                failure = error
                if attempt + 1 == attempts:
                    break
                delay = min(60, 2 ** attempt)
                if isinstance(error, urllib.error.HTTPError) and error.code == 429:
                    delay = max(delay, 20)
                time.sleep(delay)
        raise RuntimeError(f"OpenRouter translation failed: {failure}")

    def translate_group(self, group: list[dict[str, str]]) -> dict[str, str]:
        items = {item["id"]: item["text"] for item in group}
        try:
            return self.request(items)
        except RuntimeError:
            if len(group) == 1:
                raise
            middle = len(group) // 2
            return {
                **self.translate_group(group[:middle]),
                **self.translate_group(group[middle:]),
            }


class GoogleTranslator:
    def __init__(self, workers: int) -> None:
        self.workers = max(1, workers)
        self.max_group_chars = 3_800
        self.max_group_items = 48

    def translate_text(self, text: str, source: str = "en", attempts: int = 7) -> str:
        query = urllib.parse.urlencode(
            {"client": "gtx", "sl": source, "tl": "ar", "dt": "t", "q": text}
        )
        url = "https://translate.googleapis.com/translate_a/single?" + query
        failure: Exception | None = None
        for attempt in range(attempts):
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Rethox/1.0"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                translated = "".join(part[0] for part in payload[0] if part and part[0]).strip()
                if translated:
                    return translated
            except (OSError, ValueError, IndexError, json.JSONDecodeError) as error:
                failure = error
                if attempt + 1 < attempts:
                    time.sleep(min(30, 2 ** attempt))
        raise RuntimeError(f"Google translation failed: {failure}")

    def request(self, items: dict[str, str]) -> dict[str, str]:
        payload = "\n".join(
            f"[[[{key}]]] {protect_source_terms(value)}"
            for key, value in items.items()
        )
        translated = self.translate_text(payload)
        marker = re.compile(r"\[\[\[([a-z0-9-]+)\]\]\]\s*", re.IGNORECASE)
        matches = list(marker.finditer(translated))
        result: dict[str, str] = {}
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(translated)
            result[match.group(1)] = translated[match.end() : end].strip()
        if set(result) != set(items):
            raise RuntimeError("Google translation markers changed")
        return {
            key: clean_residual_latin(value, self.translate_text)
            for key, value in result.items()
        }

    def translate_group(self, group: list[dict[str, str]]) -> dict[str, str]:
        items = {item["id"]: item["text"] for item in group}
        try:
            translated = self.request(items)
            invalid = [key for key, value in translated.items() if not valid_translation(items[key], value)]
            if invalid:
                raise RuntimeError(f"Google translation validation failed: {invalid[:3]}")
            return translated
        except RuntimeError:
            if len(group) == 1:
                key = group[0]["id"]
                value = clean_residual_latin(self.translate_text(group[0]["text"]), self.translate_text)
                if not valid_translation(group[0]["text"], value):
                    raise
                return {key: value}
            middle = len(group) // 2
            return {
                **self.translate_group(group[:middle]),
                **self.translate_group(group[middle:]),
            }


def translation_groups(
    paragraphs: list[dict[str, Any]],
    cache: dict[str, str],
    max_chars: int = 12_000,
    max_items: int = 80,
) -> list[list[dict[str, str]]]:
    groups: list[list[dict[str, str]]] = []
    current: list[dict[str, str]] = []
    size = 0
    for paragraph in paragraphs:
        if paragraph["id"] in cache:
            continue
        item = {"id": paragraph["id"], "text": paragraph["text"]}
        addition = len(item["text"]) + len(item["id"]) + 8
        if current and (size + addition > max_chars or len(current) >= max_items):
            groups.append(current)
            current = []
            size = 0
        current.append(item)
        size += addition
    if current:
        groups.append(current)
    return groups


def translate_titles(
    translator: Translator,
    config: ArcConfig,
    chapters: list[dict[str, Any]],
) -> dict[str, str]:
    cache_path = CACHE_DIR / f"arc-{config.number}" / "titles.json"
    cache: dict[str, str] = {}
    if cache_path.exists():
        cache = {
            key: replace_known_names(value)
            for key, value in json.loads(cache_path.read_text(encoding="utf-8")).items()
        }
    source_by_key = {
        f"chapter-{chapter['position']:03d}": chapter["sourceTitle"]
        for chapter in chapters
    }
    cache = {
        key: value
        for key, value in cache.items()
        if key in source_by_key and valid_translation(source_by_key[key], value)
    }
    pending = [
        {"id": f"chapter-{chapter['position']:03d}", "text": chapter["sourceTitle"]}
        for chapter in chapters
        if f"chapter-{chapter['position']:03d}" not in cache
    ]
    groups = [pending[index : index + 24] for index in range(0, len(pending), 24)]
    if groups:
        with concurrent.futures.ThreadPoolExecutor(max_workers=translator.workers) as executor:
            futures = [executor.submit(translator.translate_group, group) for group in groups]
            for future in concurrent.futures.as_completed(futures):
                cache.update(future.result())
                atomic_json(cache_path, cache, pretty=True)
    return cache


def title_label(config: ArcConfig, chapter: dict[str, Any], subtitle: str) -> str:
    subtitle = re.sub(r"\d+\s*$", "", subtitle).strip(" .—–-")
    subtitle = EDITORIAL_TITLES.get((config.number, int(chapter["position"])), subtitle)
    kind = str(chapter["kind"]).lower()
    if kind.startswith("chapter"):
        return f"الفصل {chapter['number']} — {subtitle}"
    if kind.startswith("intermission"):
        return f"فاصل — {subtitle}"
    return f"الخاتمة — {subtitle}"


def chapter_payload(
    config: ArcConfig,
    chapter: dict[str, Any],
    title: str,
    translations: dict[str, str],
    volume_position: int,
) -> dict[str, Any]:
    chapter_id = f"ch-rezero-{config.number}-{chapter['position']:03d}"
    sentences: list[dict[str, Any]] = []
    paragraph_pages: list[tuple[int, str]] = []
    for paragraph in chapter["paragraphs"]:
        if paragraph["id"] not in translations:
            continue
        text = translations[paragraph["id"]]
        position = len(sentences) + 1
        sentence_id = f"rz{config.number}-c{chapter['position']:03d}-p{position:04d}"
        sentences.append({"id": sentence_id, "position": position, "text": text, "tokens": []})
        paragraph_pages.append((int(paragraph["endPage"]), sentence_id))

    illustrations: list[dict[str, Any]] = []
    for image_index, image in enumerate(chapter["images"], start=1):
        page = int(image["page"])
        anchor = next(
            (sentence_id for end_page, sentence_id in reversed(paragraph_pages) if end_page < page),
            sentences[0]["id"] if sentences else None,
        )
        illustration: dict[str, Any] = {
            "id": f"rz{config.number}-c{chapter['position']:03d}-i{image_index:02d}",
            "src": image["src"],
            "alt": f"رسم من الآرك {config.number}، {title}",
            "position": image_index,
        }
        if anchor:
            illustration["afterSentenceId"] = anchor
        illustrations.append(illustration)

    words = sum(len(sentence["text"].split()) for sentence in sentences)
    return {
        "id": chapter_id,
        "bookId": config.book_id,
        "title": title,
        "position": chapter["position"],
        "durationMs": max(45_000, words * 430),
        "isSample": True,
        "volumeNumber": chapter["volumeNumber"],
        "volumePosition": volume_position,
        "sentences": sentences,
        "illustrations": illustrations,
    }


def write_arc(config: ArcConfig, extracted: dict[str, Any], translator: Translator) -> dict[str, Any]:
    derived = DATA_DIR / "books" / f"ReZero Arc {config.number}" / "derived"
    derived.mkdir(parents=True, exist_ok=True)
    volume_chapters: dict[int, list[dict[str, Any]]] = {}
    volume_positions: dict[int, int] = {}
    titles = translate_titles(translator, config, extracted["chapters"])

    for chapter in extracted["chapters"]:
        cache_path = CACHE_DIR / f"arc-{config.number}" / "translations" / f"chapter-{chapter['position']:03d}.json"
        cache: dict[str, str] = {}
        if cache_path.exists():
            cache = {
                key: replace_known_names(value)
                for key, value in json.loads(cache_path.read_text(encoding="utf-8")).items()
            }
        included_paragraphs = [
            paragraph
            for paragraph in chapter["paragraphs"]
            if not is_editorial_note(paragraph["text"])
        ]
        source_by_id = {paragraph["id"]: paragraph["text"] for paragraph in included_paragraphs}
        original_cache_size = len(cache)
        cache = {
            key: value
            for key, value in cache.items()
            if key in source_by_id and valid_translation(source_by_id[key], value)
        }
        if len(cache) != original_cache_size:
            atomic_json(cache_path, cache)
        groups = translation_groups(
            included_paragraphs,
            cache,
            getattr(translator, "max_group_chars", 12_000),
            getattr(translator, "max_group_items", 80),
        )
        if groups:
            print(
                f"arc={config.number} chapter={chapter['position']:03d} pending_groups={len(groups)}",
                flush=True,
            )
            with concurrent.futures.ThreadPoolExecutor(max_workers=translator.workers) as executor:
                futures = {executor.submit(translator.translate_group, group): group for group in groups}
                for future in concurrent.futures.as_completed(futures):
                    result = future.result()
                    cache.update(result)
                    atomic_json(cache_path, cache)
                    first = futures[future][0]["id"]
                    last = futures[future][-1]["id"]
                    print(f"arc={config.number} translated={first}-{last}", flush=True)
        missing = [paragraph["id"] for paragraph in included_paragraphs if paragraph["id"] not in cache]
        if missing:
            raise ValueError(f"missing translations for chapter {chapter['position']}: {missing[:3]}")

        volume = int(chapter["volumeNumber"])
        volume_positions[volume] = volume_positions.get(volume, 0) + 1
        title_key = f"chapter-{chapter['position']:03d}"
        title = title_label(config, chapter, titles[title_key])
        payload = chapter_payload(config, chapter, title, cache, volume_positions[volume])
        volume_chapters.setdefault(volume, []).append(payload)

    chapter_meta: list[dict[str, Any]] = []
    for volume, chapters in sorted(volume_chapters.items()):
        filename = f"volume-{volume:02d}.json"
        atomic_json(derived / filename, {"bookId": config.book_id, "chapters": chapters})
        for chapter in chapters:
            meta = {key: value for key, value in chapter.items() if key != "sentences"}
            meta["sentences"] = []
            meta["sentenceCount"] = len(chapter["sentences"])
            meta["contentFile"] = f"books/ReZero Arc {config.number}/derived/{filename}"
            chapter_meta.append(meta)

    return {
        "id": config.book_id,
        "slug": config.slug,
        "title": config.title,
        "author": "تَابي ناغاتسوكي",
        "synopsis": config.synopsis,
        "priceMinor": 0,
        "currency": "SAR",
        "genre": "فانتازيا",
        "tags": ["ري:زيرو", f"الآرك {config.number}", "فانتازيا", "رواية مترجمة"],
        "coverTheme": config.cover_theme,
        "coverUrl": config.cover_url,
        "status": "PUBLISHED",
        "rating": 4.9,
        "pageCount": extracted["pageCount"],
        "contentUnitLabel": "فصل",
        "contentUnitLabelPlural": "فصول",
        "chapters": sorted(chapter_meta, key=lambda item: item["position"]),
    }


def update_store(books: list[dict[str, Any]]) -> None:
    for store_path in (DATA_DIR / "deploy-seed.json", DATA_DIR / "runtime-store.json"):
        if not store_path.exists():
            continue
        store = json.loads(store_path.read_text(encoding="utf-8"))
        ids = {book["id"] for book in books}
        slugs = {book["slug"] for book in books}
        store["books"] = [
            book
            for book in store.get("books", [])
            if book.get("id") not in ids and book.get("slug") not in slugs
        ]
        store["books"].extend(books)
        atomic_json(store_path, store, pretty=True)


def select_arcs(value: str) -> list[ArcConfig]:
    if value == "both":
        return [ARCS[7], ARCS[8]]
    return [ARCS[int(value)]]


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract, translate, and import Re:Zero Web Novel arcs 7 and 8")
    parser.add_argument("--arc", choices=("7", "8", "both"), default="both")
    parser.add_argument("--extract-only", action="store_true")
    parser.add_argument("--refresh-extraction", action="store_true")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--provider", choices=("openrouter", "google"), default="openrouter")
    args = parser.parse_args()

    selected = select_arcs(args.arc)
    extracted_arcs = [extract_arc(config, refresh=args.refresh_extraction) for config in selected]
    for config, extracted in zip(selected, extracted_arcs, strict=True):
        paragraph_count = sum(len(chapter["paragraphs"]) for chapter in extracted["chapters"])
        character_count = sum(
            len(paragraph["text"])
            for chapter in extracted["chapters"]
            for paragraph in chapter["paragraphs"]
        )
        print(
            f"arc={config.number} chapters={len(extracted['chapters'])} pages={extracted['pageCount']} "
            f"paragraphs={paragraph_count} characters={character_count}",
            flush=True,
        )
    if args.extract_only:
        return 0

    translator = GoogleTranslator(args.workers) if args.provider == "google" else Translator(args.workers)
    books = [write_arc(config, extracted, translator) for config, extracted in zip(selected, extracted_arcs, strict=True)]
    update_store(books)
    print("Imported books: " + ", ".join(book["title"] for book in books), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted; completed translation caches were preserved.", file=sys.stderr)
        raise SystemExit(130)
