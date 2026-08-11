"""Restore the official chapter names in the Mushoku Tensei volume indexes.

The initial PDF importer intentionally split the text on "Chapter N" headings,
but those headings omit the descriptive part printed in each volume's contents
page.  This utility reads chapter-title metadata only, translates the short
labels to Arabic, and updates both the shipped catalog and externalized volume
content.  It never changes the translated novel text or illustrations.
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


BOOK_ID = "book-mushoku-tensei"
WIKI_API = "https://mushokutensei.fandom.com/api.php"
TRANSLATE_API = "https://translate.googleapis.com/translate_a/single"
PROJECT = Path(__file__).resolve().parents[1]
SEED_PATH = PROJECT / "apps" / "api" / "data" / "deploy-seed.json"
DERIVED_DIR = PROJECT / "apps" / "api" / "data" / "books" / "Mushoku Tensei" / "derived"

# These are the counts produced by the PDF import. They make the update fail
# loudly if a wiki page changes format rather than assigning a wrong title.
EXPECTED_SECTION_COUNTS = {
    1: 13, 2: 12, 3: 15, 4: 12, 5: 11, 6: 15, 7: 9, 8: 13, 9: 15,
    10: 14, 11: 16, 12: 16, 13: 13, 14: 12, 15: 14, 16: 10, 17: 15,
    18: 12, 19: 14, 20: 12, 21: 11, 22: 14, 23: 11, 24: 12, 25: 11,
    26: 5,
}

ORDINALS = {
    1: "الأول", 2: "الثاني", 3: "الثالث", 4: "الرابع", 5: "الخامس",
    6: "السادس", 7: "السابع", 8: "الثامن", 9: "التاسع", 10: "العاشر",
    11: "الحادي عشر", 12: "الثاني عشر", 13: "الثالث عشر",
    14: "الرابع عشر", 15: "الخامس عشر", 16: "السادس عشر",
}

# Machine translation is used only for the many short, ordinary labels.  Names,
# places, ranks, and idioms below get an editorial translation so the index
# agrees with the terminology used throughout the Arabic reader.
EDITORIAL_TITLES = {
    (1, "Chapter 2: The Creeped-Out Maid"): "الفصل الثاني: الخادمة المرتابة",
    (1, "Chapter 11: Parted"): "الفصل الحادي عشر: الفراق",
    (3, "Chapter 1: The Con Artist Who Claimed to Be a God"): "الفصل الأول: الدجال الذي ادّعى أنه إله",
    (3, "Chapter 2: The Superd"): "الفصل الثاني: السوبرد",
    (3, "Chapter 3: A Master's Secrets"): "الفصل الثالث: أسرار المعلم",
    (4, "Chapter 2: Missed Connections, the Prequel"): "الفصل الثاني: لقاءات فائتة، المقدمة",
    (4, "Chapter 3: Missed Connections, the Sequel"): "الفصل الثالث: لقاءات فائتة، التكملة",
    (4, "Side Story: Missed Connections, Extra Story"): "قصة جانبية: لقاءات فائتة، قصة إضافية",
    (4, "Chapter 4: The Sage on Board"): "الفصل الرابع: الحكيم على متن السفينة",
    (4, "Extra Chapter: Guardian Fitz"): "فصل إضافي: فيتز الحارس",
    (5, "Chapter 1: The Holy Country of Millis"): "الفصل الأول: بلاد ميليس المقدسة",
    (5, "Chapter 5: Objectives Confirmed"): "الفصل الخامس: تأكيد الأهداف",
    (5, "Chapter 6: One Week in Millishion"): "الفصل السادس: أسبوع في ميليشيون",
    (5, "Interlude: Eris The Goblin Slayer"): "فاصل: إيريس قاتلة الغوبلن",
    (6, "Chapter 8: An Adult"): "الفصل الثامن: بالغ",
    (6, "Chapter 10: The Wide, Gaping Hole In My Chest"): "الفصل العاشر: الفجوة الكبيرة في صدري",
    (6, "Chapter 13: The Young Miss's Resolution"): "الفصل الثالث عشر: قرار السيدة الشابة",
    (6, "Interlude: The Two She Encountered"): "فاصل: الفتاتان اللتان قابلتهما",
    (7, "Chapter 2: The Luster Grizzlies"): "الفصل الثاني: غريزليز لوستر",
    (7, "Chapter 3: Quagmire Rudeus"): "الفصل الثالث: روديوس المستنقع",
    (8, "Extra Chapter: Juliette & Manners"): "فصل إضافي: جولييت وآداب السلوك",
    (9, "Chapter 1: The Prodigy's Secret (Part 1)"): "الفصل الأول: سر العبقرية (الجزء الأول)",
    (9, "Chapter 2: The Prodigy's Secret (Part 2)"): "الفصل الثاني: سر العبقرية (الجزء الثاني)",
    (9, "Chapter 8: Clueless, but Perceptive"): "الفصل الثامن: غافل لكنه ثاقب البصيرة",
    (10, "Chapter 8: Life With a House"): "الفصل الثامن: الحياة في منزل",
    (10, "Extra Chapter: The Master Babysitter"): "فصل إضافي: جليسة الأطفال المحترفة",
    (11, "Chapter 9: To Begaritt"): "الفصل التاسع: إلى بيغاريت",
    (12, "Chapter 2: Confirming the Situation"): "الفصل الثاني: تقييم الوضع",
    (12, "Chapter 4: Her Emotional Perspective"): "الفصل الرابع: وجهة نظرها العاطفية",
    (12, "Chapter 6: Easy as Pie"): "الفصل السادس: في غاية السهولة",
    (12, "Chapter 10: Parents"): "الفصل العاشر: الوالدان",
    (14, "Chapter 2: An Audience with Perugius"): "الفصل الثاني: لقاء مع بيروغيوس",
    (15, "Chapter 3: Resolve"): "الفصل الثالث: العزم",
    (15, "Chapter 8: Quagmire vs. Dragon God"): "الفصل الثامن: روديوس المستنقع ضد إله التنين",
    (15, "Chapter 9: Berserker Sword King vs. Dragon God"): "الفصل التاسع: ملكة السيف الهائجة ضد إله التنين",
    (16, "Chapter 4: Mind Made Up"): "الفصل الرابع: القرار محسوم",
    (17, "Chapter 1: The First Mission"): "الفصل الأول: الطريق إلى أسورا",
    (17, "Chapter 2: The Red Wyrm’s Upper Jaw"): "الفصل الثاني: الفك العلوي للتنين الأحمر",
    (17, "Chapter 11: The Madness of Luke"): "الفصل الحادي عشر: جنون لوك",
    (18, "Chapter 2: The Borrowed Cat"): "الفصل الثاني: القطة المستعارة",
    (18, "Chapter 9: The Case of the Jerky Thief"): "الفصل التاسع: قضية سارق اللحم المجفف",
    (20, "Chapter 1: Plans for the Future and Cliff's Concerns"): "الفصل الأول: خطط المستقبل ومخاوف كليف",
    (20, "Interlude: A Country Bumpkin Visits the City"): "فاصل: قروي يزور المدينة",
    (20, "Chapter 6: Onward, to Millishion..."): "الفصل السادس: إلى ميليشيون...",
    (20, "Chapter 9: Headquarters of the Millis Church"): "الفصل التاسع: مقر كنيسة ميليس",
    (21, "Chapter 1: Playing Dumb"): "الفصل الأول: التظاهر بالغباء",
    (21, "Chapter 8: The Traitor Gets Away"): "الفصل الثامن: إفلات الخائن",
    (22, "Chapter 4: The Naughtiest Kid"): "الفصل الرابع: الطفل الأكثر شقاوة",
    (22, "Chapter 5: The King of the King Dragon Realm"): "الفصل الخامس: ملك مملكة ملك التنانين",
    (22, "Chapter 7: Dueling Atofe's Ultimate Four"): "الفصل السابع: مبارزة الأعضاء الأربعة الأقوى لأتوفي",
    (22, "Chapter 8: Imprisoned in Fort Necross"): "الفصل الثامن: مسجون في حصن نيكروس",
    (23, "Chapter 7: The Mad Dog's Old Stomping Grounds"): "الفصل السابع: الديار القديمة للكلب المجنون",
    (23, "Chapter 8: A North God, an Adventurer, and More..."): "الفصل الثامن: إله الشمال، مغامر، والمزيد...",
    (23, "Chapter 9: A North God, a Mercenary, and More..."): "الفصل التاسع: إله الشمال، مرتزق، والمزيد...",
    (23, "Extra Chapter: Geese and His Final Ally"): "فصل إضافي: غيس وحليفه الأخير",
    (24, "Chapter 1: A Strategy Meeting"): "الفصل الأول: اجتماع استراتيجي",
    (24, "Chapter 4: The Superd Villiage"): "الفصل الرابع: قرية السوبرد",
    (24, "Chapter 5: Abyssal King Vita"): "الفصل الخامس: ملك الأعماق فيتا",
    (24, "Interlude: Somebody to Someone"): "فاصل: من شخص إلى شخص",
    (24, "Chapter 9: Four-Day Educational Superd Village Tour"): "الفصل التاسع: جولة تعليمية لأربعة أيام في قرية السوبرد",
    (25, "Chapter 1: Someone Notices Something Amiss"): "الفصل الأول: يلاحظ أحدهم خللًا",
    (25, "Chapter 2: At the Bottom of the Ravine of the Earthwyrm"): "الفصل الثاني: في قاع وادي تنين الأرض",
    (25, "Chapter 3: A Shot at Victory"): "الفصل الثالث: فرصة للنصر",
    (25, "Chapter 4: The Mad Dog King vs. the Former Sword God"): "الفصل الرابع: ملك الكلب المجنون ضد إله السيف السابق",
    (25, "Chapter 6: Kalman III vs. Dead End and Co."): "الفصل السادس: كالمان الثالث ضد نهاية الطريق ورفاقه",
    (25, "Chapter 9: Making Peace with the Orge God"): "الفصل التاسع: صنع السلام مع إله الغول",
    (25, "Interlude: I want to Be a Hero"): "فاصل: أريد أن أكون بطلًا",
    (26, "Chapter 1: The Threat of the Fighting God"): "الفصل الأول: تهديد إله القتال",
    (26, "Chapter 2: The Trump Card"): "الفصل الثاني: الورقة الرابحة",
    (26, "Epilogue: Prologue Zero"): "الخاتمة: المقدمة صفر",
}


def write_json(path: Path, value: Any, *, compact: bool = False) -> None:
    payload = (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if compact
        else json.dumps(value, ensure_ascii=False, indent=2)
    )
    path.write_text(payload + "\n", encoding="utf-8")


def fetch_volume_titles(volume: int) -> list[str]:
    query = urllib.parse.urlencode(
        {
            "action": "parse",
            "page": f"Light Novel Volume {volume}",
            "prop": "wikitext",
            "format": "json",
        }
    )
    request = urllib.request.Request(
        f"{WIKI_API}?{query}",
        headers={"User-Agent": "RethoxCatalog/1.0 (chapter-title refresh)"},
    )
    with urllib.request.urlopen(request, timeout=35) as response:
        payload = json.loads(response.read().decode("utf-8"))
    raw = payload["parse"]["wikitext"]["*"]
    match = re.search(r"(?s)==\s*Chapters\s*==\s*(.*?)(?=\r?\n==|\Z)", raw)
    if not match:
        raise RuntimeError(f"Volume {volume}: chapter list was not found")
    titles: list[str] = []
    for line in match.group(1).splitlines():
        if not re.match(r"^\s*\*", line):
            continue
        title = re.sub(r"^\s*\*\s*", "", line).strip()
        title = re.sub(r"<ref[^>]*>.*?</ref>|<ref[^>]*/>", "", title, flags=re.I)
        title = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", title)
        title = title.replace("[[", "").replace("]]", "").strip()
        if title:
            titles.append(title)

    # The supplied volume 18 begins at Chapter 1; its contents-page "Rudeus's
    # Diary" is a framing label rather than one of the imported reader pages.
    if volume == 18:
        titles = titles[1:]
    # The original importer made two adjacent anchors for the same final text.
    # Keep the one that starts the actual ending and omit the empty duplicate.
    if volume == 26:
        titles = titles[:4] + [titles[9]]
    expected = EXPECTED_SECTION_COUNTS[volume]
    if len(titles) != expected:
        raise RuntimeError(
            f"Volume {volume}: expected {expected} names, received {len(titles)}"
        )
    return titles


def translate_title(title: str) -> str:
    query = urllib.parse.urlencode(
        {"client": "gtx", "sl": "en", "tl": "ar", "dt": "t", "q": title}
    )
    request = urllib.request.Request(
        f"{TRANSLATE_API}?{query}", headers={"User-Agent": "Mozilla/5.0"}
    )
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                payload = json.loads(response.read().decode("utf-8"))
            result = "".join(item[0] for item in payload[0] if item and item[0]).strip()
            if result:
                return result
        except Exception:
            if attempt == 4:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Could not translate title: {title}")


def arabic_title(volume: int, title: str, translated: str) -> str:
    # A small editorial pass keeps names and terminology consistent with the
    # existing Arabic novel text.  It also fixes the only intentionally unnamed
    # official entry without fabricating a chapter name.
    fixes = {
        "Prologue Zero": "المقدمة صفر",
        "Epilogue: Prologue Zero": "الخاتمة: المقدمة صفر",
        "Extra Chapter: ???": "فصل إضافي: ؟؟؟",
    }
    value = EDITORIAL_TITLES.get((volume, title), fixes.get(title, translated))
    chapter = re.fullmatch(r"Chapter\s+(\d+):\s*(.+)", title)
    if chapter and (volume, title) not in EDITORIAL_TITLES:
        subtitle = translated.split(":", 1)[-1].strip()
        value = f"الفصل {ORDINALS[int(chapter.group(1))]}: {subtitle}"
    if title.startswith("Interlude:") and (volume, title) not in EDITORIAL_TITLES:
        value = f"فاصل: {translated.split(':', 1)[-1].strip()}"
    value = value.replace("روديوس", "روديوس").replace("أورستيد", "أورستد")
    value = re.sub(r"[\u200b\ufeff]", "", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def refresh() -> None:
    seed = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    book = next(item for item in seed["books"] if item["id"] == BOOK_ID)
    volumes = {chapter["position"]: chapter for chapter in book["chapters"]}
    if set(volumes) != set(EXPECTED_SECTION_COUNTS):
        raise RuntimeError("Mushoku volume metadata is incomplete")

    source_titles = {volume: fetch_volume_titles(volume) for volume in volumes}
    unique_titles = sorted({title for titles in source_titles.values() for title in titles})
    translations: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=6) as executor:
        jobs = {executor.submit(translate_title, title): title for title in unique_titles}
        for future in as_completed(jobs):
            title = jobs[future]
            translations[title] = future.result()

    for volume, metadata in sorted(volumes.items()):
        sections = metadata.get("sections", [])
        if volume == 26:
            sections = sections[:5]
            metadata["sections"] = sections
        if len(sections) != EXPECTED_SECTION_COUNTS[volume]:
            raise RuntimeError(f"Volume {volume}: unexpected imported section count")
        for section, title in zip(sections, source_titles[volume], strict=True):
            section["title"] = arabic_title(volume, title, translations[title])

        content_path = DERIVED_DIR / f"volume-{volume:02d}.json"
        content = json.loads(content_path.read_text(encoding="utf-8"))
        chapter = content["chapters"][0]
        if volume == 26:
            chapter["sections"] = chapter.get("sections", [])[:5]
        if len(chapter.get("sections", [])) != len(sections):
            raise RuntimeError(f"Volume {volume}: derived section count does not match metadata")
        for section, title in zip(chapter["sections"], source_titles[volume], strict=True):
            section["title"] = arabic_title(volume, title, translations[title])
        write_json(content_path, content, compact=True)

    write_json(SEED_PATH, seed)
    print(f"Updated {sum(len(items) for items in source_titles.values())} Mushoku section titles.")


if __name__ == "__main__":
    refresh()
