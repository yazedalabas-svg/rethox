from __future__ import annotations

import concurrent.futures
import importlib.util
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BOOK_ID = "book-mushoku-tensei"
HEADING = re.compile(
    r"^(?P<kind>prologue zero|prologue|epilogue|interlude|chapter\s+\d+|extra chapter(?:\s+[IVX]+)?|side story)(?::)?$",
    re.I,
)


def load_importer():
    spec = importlib.util.spec_from_file_location("mushoku_importer", ROOT / "tools" / "import_mushoku_tensei.py")
    if not spec or not spec.loader:
        raise RuntimeError("Unable to load the Mushoku importer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def heading_titles(volume: int) -> list[tuple[str, str]]:
    source = ROOT / "tmp" / "pdfs" / "mushoku-tensei" / f"volume-{volume:02d}-extracted.json"
    pages = json.loads(source.read_text(encoding="utf-8"))["pages"]
    result: list[tuple[str, str]] = []
    for page in pages:
        lines = [line.strip() for line in page["text"].splitlines() if line.strip()]
        for index, line in enumerate(lines):
            match = HEADING.fullmatch(line)
            if not match:
                continue
            kind = match.group("kind").lower()
            title = ""
            if line.endswith(":") and index + 1 < len(lines):
                title = lines[index + 1]
                if kind == "side story" and index + 2 < len(lines):
                    continuation = lines[index + 2]
                    if len(continuation) < 80 and not continuation.endswith((".", "?", "!")):
                        title = f"{title} {continuation}"
            result.append((kind, title))
    return result


def label(kind: str, title: str, position: int) -> str:
    translated = title.strip()
    if kind.startswith("chapter"):
        number = re.search(r"\d+", kind).group(0)
        return f"الفصل {number} — {translated}"
    if kind.startswith("extra chapter"):
        return f"فصل إضافي — {translated}"
    if kind == "side story":
        return f"قصة جانبية — {translated}"
    if kind == "interlude":
        return f"فاصل — {translated}"
    if kind == "prologue":
        return f"المقدمة — {translated}" if translated else "المقدمة"
    if kind == "prologue zero":
        return "المقدمة صفر"
    if kind == "epilogue":
        return "الخاتمة"
    return translated or f"القسم {position}"


def update_chapters(chapters: list[dict], titles_by_volume: dict[int, list[str]]) -> None:
    for chapter in chapters:
        match = re.search(r"vol-(\d+)$", chapter.get("id", ""))
        if not match:
            continue
        titles = titles_by_volume[int(match.group(1))]
        sections = chapter.get("sections", [])
        if len(sections) != len(titles):
            raise ValueError(f"Section count mismatch for {chapter['id']}")
        for section, title in zip(sections, titles):
            section["title"] = title


def main() -> None:
    importer = load_importer()
    source_titles = {volume: heading_titles(volume) for volume in range(1, 27)}
    unique_titles = sorted({title for entries in source_titles.values() for _, title in entries if title})
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        translated = dict(zip(unique_titles, executor.map(importer.translate_chunk, unique_titles)))
    titles_by_volume = {
        volume: [label(kind, translated.get(title, ""), position) for position, (kind, title) in enumerate(entries, start=1)]
        for volume, entries in source_titles.items()
    }
    derived = ROOT / "apps" / "api" / "data" / "books" / "Mushoku Tensei" / "derived"
    for volume in range(1, 27):
        path = derived / f"volume-{volume:02d}.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        update_chapters(payload["chapters"], titles_by_volume)
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    for name in ("deploy-seed.json", "runtime-store.json"):
        path = ROOT / "apps" / "api" / "data" / name
        payload = json.loads(path.read_text(encoding="utf-8"))
        book = next(item for item in payload["books"] if item["id"] == BOOK_ID)
        update_chapters(book["chapters"], titles_by_volume)
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
