# -*- coding: utf-8 -*-
from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import uuid
import webbrowser
from pathlib import Path
from typing import Any


# =========================================================
# تثبيت المكتبات تلقائيًا
# =========================================================

def ensure_package(package: str, module: str) -> None:
    try:
        importlib.import_module(module)
    except ImportError:
        print(f"جاري تثبيت {package}...")

        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--upgrade",
                package,
            ]
        )

        importlib.invalidate_caches()


ensure_package("Flask>=3.0", "flask")
ensure_package("PyMuPDF>=1.24", "fitz")
ensure_package("edge-tts>=7.0", "edge_tts")


import edge_tts
import fitz

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    request,
    send_file,
)


# =========================================================
# الإعدادات
# =========================================================

HOST = "127.0.0.1"

# صوت حامد السعودي الرجالي
VOICE = "ar-SA-HamedNeural"

TICKS_PER_SECOND = 10_000_000
MAX_UPLOAD_SIZE = 500 * 1024 * 1024

WORK_DIR = (
    Path(tempfile.gettempdir())
    / "arabic_pdf_hamed_reader_v3"
)

PDF_DIR = WORK_DIR / "pdf"
PAGE_DIR = WORK_DIR / "pages"
AUDIO_DIR = WORK_DIR / "audio"

for folder in (PDF_DIR, PAGE_DIR, AUDIO_DIR):
    folder.mkdir(
        parents=True,
        exist_ok=True,
    )


app = Flask(__name__)

app.config["MAX_CONTENT_LENGTH"] = (
    MAX_UPLOAD_SIZE
)

sessions: dict[str, dict[str, Any]] = {}


# =========================================================
# أدوات عامة
# =========================================================

def clean_text(value: str) -> str:
    text = unicodedata.normalize(
        "NFKC",
        str(value or ""),
    )

    text = re.sub(
        r"[\u200B-\u200F\u202A-\u202E\u2066-\u2069]",
        "",
        text,
    )

    text = (
        text
        .replace("\u0640", "")
        .replace("�", " ")
    )

    text = re.sub(
        r"[■□▪◼◾▮▯]+",
        " ",
        text,
    )

    text = re.sub(
        r"\s+([،؛؟.!:])",
        r"\1",
        text,
    )

    text = re.sub(
        r"([،؛؟.!:])(?=\S)",
        r"\1 ",
        text,
    )

    return re.sub(
        r"\s+",
        " ",
        text,
    ).strip()


def find_free_port() -> int:
    with socket.socket(
        socket.AF_INET,
        socket.SOCK_STREAM,
    ) as server_socket:

        server_socket.bind((HOST, 0))

        return int(
            server_socket.getsockname()[1]
        )


def get_session(
    session_id: str,
) -> dict[str, Any]:

    session = sessions.get(session_id)

    if not session:
        abort(
            404,
            description="جلسة الملف غير موجودة.",
        )

    path = Path(session["path"])

    if not path.exists():
        sessions.pop(
            session_id,
            None,
        )

        abort(
            404,
            description="ملف PDF لم يعد موجودًا.",
        )

    return session


def clean_old_files(
    maximum_age_hours: int = 48,
) -> None:

    cutoff = (
        time.time()
        - maximum_age_hours * 3600
    )

    for folder in (
        PDF_DIR,
        PAGE_DIR,
        AUDIO_DIR,
    ):
        for item in folder.iterdir():
            try:
                if (
                    item.is_file()
                    and item.stat().st_mtime < cutoff
                ):
                    item.unlink(
                        missing_ok=True
                    )
            except OSError:
                pass


# =========================================================
# توليد صوت حامد مع إعادة المحاولة
# =========================================================

async def generate_audio_once(
    text: str,
    audio_path: Path,
) -> list[dict[str, Any]]:

    communicator = edge_tts.Communicate(
        text=text,
        voice=VOICE,
        rate="+0%",
        volume="+0%",
        pitch="+0Hz",
    )

    temporary_path = (
        audio_path.with_suffix(
            f".{uuid.uuid4().hex}.tmp"
        )
    )

    marks: list[dict[str, Any]] = []

    try:
        with temporary_path.open("wb") as output:
            async for chunk in communicator.stream():
                chunk_type = chunk.get("type")

                if chunk_type == "audio":
                    output.write(
                        chunk["data"]
                    )

                elif chunk_type == "WordBoundary":
                    marks.append(
                        {
                            "text": str(
                                chunk.get(
                                    "text",
                                    "",
                                )
                            ),
                            "start": (
                                float(
                                    chunk.get(
                                        "offset",
                                        0,
                                    )
                                )
                                / TICKS_PER_SECOND
                            ),
                            "duration": (
                                float(
                                    chunk.get(
                                        "duration",
                                        0,
                                    )
                                )
                                / TICKS_PER_SECOND
                            ),
                        }
                    )

        if (
            not temporary_path.exists()
            or temporary_path.stat().st_size == 0
        ):
            raise RuntimeError(
                "لم تصل بيانات صوتية."
            )

        temporary_path.replace(
            audio_path
        )

        return marks

    finally:
        temporary_path.unlink(
            missing_ok=True
        )


async def generate_audio_with_retry(
    text: str,
    audio_path: Path,
) -> list[dict[str, Any]]:

    last_error: Exception | None = None

    for attempt in range(1, 4):
        try:
            return await generate_audio_once(
                text,
                audio_path,
            )

        except Exception as error:
            last_error = error

            audio_path.unlink(
                missing_ok=True
            )

            if attempt < 3:
                await asyncio.sleep(
                    attempt * 1.5
                )

    raise RuntimeError(
        f"فشل الصوت بعد 3 محاولات: {last_error}"
    )


def generate_audio(
    text: str,
    audio_path: Path,
) -> list[dict[str, Any]]:

    return asyncio.run(
        generate_audio_with_retry(
            text,
            audio_path,
        )
    )


# =========================================================
# الموقع كاملًا داخل نفس الملف
# =========================================================

HTML = r"""
<!DOCTYPE html>

<html lang="ar" dir="rtl">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1"
>

<title>
    قارئ PDF العربي بصوت حامد
</title>

<script
    src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js">
</script>

<style>

:root {
    --background: #e9edf4;
    --panel: #ffffff;
    --text: #172033;
    --muted: #697386;
    --primary: #5848e9;
    --primary-dark: #4034c4;
    --border: #dce2eb;
    --highlight: rgba(255, 205, 24, 0.72);
    --danger: #c82d25;
}

* {
    box-sizing: border-box;
}

html,
body {
    margin: 0;
    min-height: 100%;
    font-family: Tahoma, Arial, sans-serif;
    color: var(--text);
    background: var(--background);
}

button,
input {
    font: inherit;
}

button {
    cursor: pointer;
}

header {
    background:
        linear-gradient(
            135deg,
            #111827,
            #312e81
        );

    color: white;
    padding: 14px;
    position: relative;
    z-index: 30;
}

.header-inner {
    width: min(1450px, 100%);
    margin: auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 9px;
}

.brand {
    margin-left: auto;
}

.brand h1 {
    margin: 0;
    font-size: 22px;
}

.brand p {
    margin: 4px 0 0;
    opacity: 0.78;
    font-size: 13px;
}

#fileInput {
    display: none;
}

.button,
.file-button {
    min-height: 42px;
    border: 0;
    border-radius: 10px;
    padding: 9px 14px;
    background: #efefff;
    color: #352ba4;
    font-weight: bold;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}

.button.primary {
    background: var(--primary);
    color: white;
}

.button.primary:hover {
    background: var(--primary-dark);
}

.button.danger {
    color: var(--danger);
    background: #ffe5e2;
}

.button:disabled {
    opacity: 0.43;
    cursor: not-allowed;
}

.button:hover,
.file-button:hover {
    filter: brightness(0.96);
}

.toolbar {
    position: sticky;
    top: 0;
    z-index: 20;
    padding: 9px;
    background: white;
    border-bottom: 1px solid var(--border);
    box-shadow:
        0 5px 18px
        rgba(25, 33, 52, 0.06);
}

.toolbar-inner {
    width: min(1450px, 100%);
    margin: auto;
    display: flex;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px;
}

.group {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 7px;
    background: white;
    border: 1px solid var(--border);
    border-radius: 10px;
}

.small-button {
    width: 37px;
    height: 37px;
    border: 0;
    border-radius: 8px;
    background: #f0f2f7;
    font-weight: bold;
}

.small-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

#pageInput {
    width: 64px;
    height: 34px;
    text-align: center;
    border: 1px solid var(--border);
    border-radius: 7px;
}

.viewer {
    min-height: calc(100vh - 125px);
    overflow: auto;
    padding: 20px 10px 200px;
    display: flex;
    justify-content: center;
    align-items: flex-start;
}

.empty {
    max-width: 520px;
    margin-top: 80px;
    padding: 40px 27px;
    background: white;
    text-align: center;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 18px;
    box-shadow:
        0 14px 42px
        rgba(25, 33, 52, 0.1);
}

.empty-icon {
    font-size: 65px;
    margin-bottom: 12px;
}

.empty strong {
    display: block;
    margin-bottom: 8px;
    color: var(--text);
    font-size: 19px;
}

#pageStage {
    position: relative;
    width: 700px;
    background: white;
    overflow: hidden;
    border-radius: 5px;
    box-shadow:
        0 14px 42px
        rgba(25, 33, 52, 0.15);
}

#pageImage {
    display: block;
    width: 100%;
    height: auto;
    user-select: none;
}

#trackingLayer {
    position: absolute;
    inset: 0;
    z-index: 5;
    pointer-events: none;
}

.word-box {
    position: absolute;
    border-radius: 3px;
    background: transparent;
    pointer-events: auto;
    cursor: pointer;
    transition: 0.08s;
}

.word-box:hover {
    background:
        rgba(88, 71, 235, 0.14);
}

.word-box.active {
    background: var(--highlight);
    box-shadow:
        inset 0 0 0 1px
        rgba(172, 122, 0, 0.68);
}

.player {
    position: fixed;
    right: 9px;
    left: 9px;
    bottom: 9px;
    z-index: 40;
    padding: 11px;
    background:
        rgba(255, 255, 255, 0.97);
    border: 1px solid var(--border);
    border-radius: 17px;
    box-shadow:
        0 15px 45px
        rgba(25, 33, 52, 0.22);
    backdrop-filter: blur(10px);
}

.player-inner {
    width: min(1400px, 100%);
    margin: auto;
    display: grid;
    gap: 8px;
}

.controls,
.settings {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 7px;
}

.voice-name,
.speed-box,
.option-box {
    min-height: 38px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: white;
    font-size: 14px;
}

.speed-box,
.option-box {
    display: inline-flex;
    align-items: center;
    gap: 8px;
}

input[type="range"] {
    accent-color: var(--primary);
}

#speedRange {
    width: 150px;
}

.progress-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 10px;
}

#progressRange {
    width: 100%;
}

.time-text {
    min-width: 110px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
}

.status {
    min-height: 19px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
}

.status.error {
    color: var(--danger);
}

.loading-bar {
    height: 4px;
    overflow: hidden;
    border-radius: 5px;
    background: #eceef4;
}

.loading-fill {
    width: 0;
    height: 100%;
    background: var(--primary);
    transition: width 0.2s;
}

@media (max-width: 760px) {

    .brand {
        width: 100%;
        margin: 0;
        text-align: center;
    }

    .header-inner {
        justify-content: center;
    }

    .viewer {
        padding-bottom: 270px;
    }

    .player {
        right: 4px;
        left: 4px;
        bottom: 4px;
        border-radius: 13px;
    }

    .controls .button {
        flex: 1;
        min-width: 95px;
    }

    .progress-row {
        grid-template-columns: 1fr;
        gap: 2px;
    }
}

</style>

</head>

<body>

<header>

<div class="header-inner">

    <div class="brand">

        <h1>
            قارئ PDF العربي
        </h1>

        <p>
            عرض سريع، صوت حامد، وتتبع الكلمات
        </p>

    </div>

    <label
        class="file-button"
        for="fileInput"
    >
        📄 اختيار PDF
    </label>

    <input
        id="fileInput"
        type="file"
        accept=".pdf,application/pdf"
    >

    <button
        id="downloadButton"
        class="button"
        disabled
    >
        ⬇ تحميل PDF
    </button>

    <button
        id="fullscreenButton"
        class="button"
    >
        ⛶ ملء الشاشة
    </button>

</div>

</header>

<nav class="toolbar">

<div class="toolbar-inner">

    <button
        id="previousButton"
        class="small-button"
        disabled
    >
        ➜
    </button>

    <div class="group">

        <span>صفحة</span>

        <input
            id="pageInput"
            type="number"
            min="1"
            value="1"
            disabled
        >

        <span>من</span>

        <strong id="totalPages">
            0
        </strong>

    </div>

    <button
        id="nextButton"
        class="small-button"
        disabled
    >
        ←
    </button>

    <div class="group">

        <button
            id="zoomOutButton"
            class="small-button"
            disabled
        >
            −
        </button>

        <strong id="zoomText">
            100%
        </strong>

        <button
            id="zoomInButton"
            class="small-button"
            disabled
        >
            +
        </button>

    </div>

</div>

</nav>

<main
    id="viewer"
    class="viewer"
>

<section
    id="emptyState"
    class="empty"
>

    <div class="empty-icon">
        📖
    </div>

    <strong>
        اختر ملف PDF
    </strong>

    <div>
        الصفحة ستظهر أولًا، ثم يتم تجهيز
        الصوت والتتبع في الخلفية.
    </div>

</section>

<div
    id="pageStage"
    hidden
>

    <img
        id="pageImage"
        alt="صفحة PDF"
    >

    <div id="trackingLayer"></div>

</div>

</main>

<section class="player">

<div class="player-inner">

    <div class="controls">

        <button
            id="playButton"
            class="button primary"
            disabled
        >
            ▶ تشغيل
        </button>

        <button
            id="pauseButton"
            class="button"
            disabled
        >
            ⏸ إيقاف مؤقت
        </button>

        <button
            id="backButton"
            class="button"
            disabled
        >
            ↩ 5 ثوانٍ
        </button>

        <button
            id="forwardButton"
            class="button"
            disabled
        >
            5 ثوانٍ ↪
        </button>

        <button
            id="stopButton"
            class="button danger"
            disabled
        >
            ⏹ إيقاف
        </button>

    </div>

    <div class="settings">

        <div class="voice-name">
            🎙 المؤدي: حامد السعودي
        </div>

        <div class="speed-box">

            <label for="speedRange">
                السرعة
            </label>

            <input
                id="speedRange"
                type="range"
                min="0.5"
                max="3"
                step="0.1"
                value="1"
            >

            <strong id="speedText">
                1.0×
            </strong>

        </div>

        <label class="option-box">

            <input
                id="autoNext"
                type="checkbox"
                checked
            >

            الانتقال التلقائي

        </label>

    </div>

    <div class="progress-row">

        <input
            id="progressRange"
            type="range"
            min="0"
            max="1000"
            value="0"
            disabled
        >

        <span
            id="timeText"
            class="time-text"
        >
            0:00 / 0:00
        </span>

    </div>

    <div class="loading-bar">
        <div
            id="loadingFill"
            class="loading-fill"
        ></div>
    </div>

    <div
        id="status"
        class="status"
    >
        اختر ملف PDF.
    </div>

    <audio
        id="audioPlayer"
        preload="metadata"
    ></audio>

</div>

</section>

<script>

const PAGE_RENDER_SCALE = 1.8;

const get = id =>
    document.getElementById(id);

const fileInput = get("fileInput");
const downloadButton = get("downloadButton");
const fullscreenButton = get("fullscreenButton");

const previousButton = get("previousButton");
const nextButton = get("nextButton");
const pageInput = get("pageInput");
const totalPagesElement = get("totalPages");

const zoomOutButton = get("zoomOutButton");
const zoomInButton = get("zoomInButton");
const zoomText = get("zoomText");

const viewer = get("viewer");
const emptyState = get("emptyState");
const pageStage = get("pageStage");
const pageImage = get("pageImage");
const trackingLayer = get("trackingLayer");

const playButton = get("playButton");
const pauseButton = get("pauseButton");
const backButton = get("backButton");
const forwardButton = get("forwardButton");
const stopButton = get("stopButton");

const speedRange = get("speedRange");
const speedText = get("speedText");
const autoNext = get("autoNext");

const progressRange = get("progressRange");
const timeText = get("timeText");

const loadingFill = get("loadingFill");
const statusElement = get("status");

const audioPlayer = get("audioPlayer");


let sessionId = "";
let totalPages = 0;
let currentPage = 1;

let zoom = 1;
let basePageWidth = 700;

let ocrWorkerPromise = null;
let ocrQueue = Promise.resolve();

let currentRequestToken = 0;
let currentPageData = null;
let currentWordIndex = -1;

let automaticAdvanceRunning = false;

const pageCache = new Map();
const preparationPromises = new Map();


function setStatus(
    message,
    isError = false
) {
    statusElement.textContent = message;

    statusElement.classList.toggle(
        "error",
        isError
    );
}


function setLoading(percent) {
    const safePercent = Math.max(
        0,
        Math.min(
            Number(percent) || 0,
            100
        )
    );

    loadingFill.style.width =
        `${safePercent}%`;
}


function enableControls(enabled) {
    downloadButton.disabled = !enabled;
    pageInput.disabled = !enabled;

    zoomOutButton.disabled = !enabled;
    zoomInButton.disabled = !enabled;

    playButton.disabled = !enabled;
    pauseButton.disabled = !enabled;
    backButton.disabled = !enabled;
    forwardButton.disabled = !enabled;
    stopButton.disabled = !enabled;
    progressRange.disabled = !enabled;

    updateNavigationButtons();
}


function updateNavigationButtons() {
    previousButton.disabled =
        !sessionId
        ||
        currentPage <= 1;

    nextButton.disabled =
        !sessionId
        ||
        currentPage >= totalPages;
}


function formatTime(seconds) {
    if (!Number.isFinite(seconds)) {
        return "0:00";
    }

    const minutes =
        Math.floor(seconds / 60);

    const remainingSeconds =
        Math.floor(seconds % 60)
        .toString()
        .padStart(2, "0");

    return `${minutes}:${remainingSeconds}`;
}


function cleanToken(text) {
    return String(text || "")
        .normalize("NFKC")

        .replace(
            /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
            ""
        )

        .replace(/ـ/g, "")

        .replace(
            /[�■□▪◼◾▮▯]+/g,
            ""
        )

        .replace(/\s+/g, " ")

        .trim();
}


function normalizeForMatch(text) {
    return cleanToken(text)

        .replace(
            /[\u064B-\u065F\u0670]/g,
            ""
        )

        .replace(
            /[^\u0600-\u06FFa-zA-Z0-9]/g,
            ""
        )

        .toLowerCase();
}


function containsArabic(text) {
    return /[\u0600-\u06FF]/.test(
        text
    );
}


function pageImageUrl(pageNumber) {
    return (
        `/api/page/${sessionId}/${pageNumber}`
        +
        `?scale=${PAGE_RENDER_SCALE}`
    );
}


function loadImage(pageNumber) {
    return new Promise(
        (resolve, reject) => {
            const image = new Image();

            image.onload = () =>
                resolve(image);

            image.onerror = () =>
                reject(
                    new Error(
                        "تعذر تحميل صورة الصفحة."
                    )
                );

            image.src =
                pageImageUrl(pageNumber);
        }
    );
}


async function getOcrWorker() {
    if (!ocrWorkerPromise) {
        ocrWorkerPromise = (
            async () => {
                setStatus(
                    "جاري تحميل محرك العربية لأول مرة..."
                );

                const worker =
                    await Tesseract.createWorker(
                        "ara",
                        1,
                        {
                            logger: message => {
                                if (
                                    message.status
                                    ===
                                    "recognizing text"
                                ) {
                                    setLoading(
                                        Math.round(
                                            (
                                                message.progress
                                                ||
                                                0
                                            )
                                            *
                                            100
                                        )
                                    );
                                }
                            }
                        }
                    );

                await worker.setParameters({
                    tessedit_pageseg_mode:
                        "3",

                    preserve_interword_spaces:
                        "1"
                });

                return worker;
            }
        )();
    }

    return ocrWorkerPromise;
}


function runOcrInQueue(task) {
    const nextTask = ocrQueue.then(
        task,
        task
    );

    ocrQueue = nextTask.catch(
        () => {}
    );

    return nextTask;
}


function orderArabicWords(rawWords) {
    const words = rawWords
        .map(word => {
            const box = word.bbox || {};

            const x0 =
                Number(box.x0 || 0);

            const y0 =
                Number(box.y0 || 0);

            const x1 =
                Number(box.x1 || 0);

            const y1 =
                Number(box.y1 || 0);

            return {
                text:
                    cleanToken(
                        word.text
                    ),

                confidence:
                    Number(
                        word.confidence
                        ||
                        0
                    ),

                x0,
                y0,
                x1,
                y1,

                width:
                    Math.max(
                        1,
                        x1 - x0
                    ),

                height:
                    Math.max(
                        1,
                        y1 - y0
                    ),

                centerY:
                    (y0 + y1) / 2,

                element: null
            };
        })

        .filter(word =>
            word.text
            &&
            word.width > 2
            &&
            word.height > 2
            &&
            word.confidence >= 8
        );


    words.sort(
        (first, second) =>
            first.centerY
            -
            second.centerY
    );


    const lines = [];


    for (const word of words) {
        let targetLine = null;

        for (const line of lines) {
            const tolerance =
                Math.max(
                    8,
                    Math.min(
                        word.height,
                        line.averageHeight
                    )
                    *
                    0.7
                );

            if (
                Math.abs(
                    word.centerY
                    -
                    line.centerY
                )
                <=
                tolerance
            ) {
                targetLine = line;
                break;
            }
        }


        if (!targetLine) {
            targetLine = {
                words: [],
                centerY:
                    word.centerY,
                averageHeight:
                    word.height
            };

            lines.push(
                targetLine
            );
        }


        targetLine.words.push(
            word
        );


        targetLine.centerY =
            targetLine.words.reduce(
                (total, current) =>
                    total
                    +
                    current.centerY,
                0
            )
            /
            targetLine.words.length;


        targetLine.averageHeight =
            targetLine.words.reduce(
                (total, current) =>
                    total
                    +
                    current.height,
                0
            )
            /
            targetLine.words.length;
    }


    lines.sort(
        (first, second) =>
            first.centerY
            -
            second.centerY
    );


    const orderedWords = [];


    for (const line of lines) {
        const arabicCount =
            line.words.filter(
                word =>
                    containsArabic(
                        word.text
                    )
            ).length;


        const isArabicLine =
            arabicCount
            >=
            line.words.length / 2;


        line.words.sort(
            isArabicLine

                ? (
                    first,
                    second
                ) =>
                    second.x0
                    -
                    first.x0

                : (
                    first,
                    second
                ) =>
                    first.x0
                    -
                    second.x0
        );


        orderedWords.push(
            ...line.words
        );
    }


    return orderedWords;
}


async function fetchJsonWithRetry(
    url,
    options,
    maximumAttempts = 3
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= maximumAttempts;
        attempt += 1
    ) {
        const controller =
            new AbortController();

        const timeout =
            setTimeout(
                () =>
                    controller.abort(),
                120000
            );

        try {
            const response =
                await fetch(
                    url,
                    {
                        ...options,
                        signal:
                            controller.signal
                    }
                );

            const data =
                await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error
                    ||
                    "تعذر إكمال الطلب."
                );
            }

            clearTimeout(timeout);

            return data;

        } catch (error) {
            clearTimeout(timeout);

            lastError = error;

            if (attempt < maximumAttempts) {
                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            attempt * 1300
                        )
                );
            }
        }
    }

    throw lastError;
}


function alignMarksToWords(
    marks,
    words
) {
    let cursor = 0;

    return marks.map(mark => {
        const markText =
            normalizeForMatch(
                mark.text
            );

        let foundIndex = -1;

        for (
            let index = cursor;
            index <
                Math.min(
                    words.length,
                    cursor + 14
                );
            index += 1
        ) {
            const wordText =
                normalizeForMatch(
                    words[index].text
                );

            if (
                wordText === markText
                ||
                (
                    wordText
                    &&
                    markText
                    &&
                    (
                        wordText.includes(
                            markText
                        )
                        ||
                        markText.includes(
                            wordText
                        )
                    )
                )
            ) {
                foundIndex = index;
                break;
            }
        }

        if (foundIndex < 0) {
            foundIndex =
                Math.min(
                    cursor,
                    Math.max(
                        0,
                        words.length - 1
                    )
                );
        }

        cursor =
            Math.min(
                foundIndex + 1,
                words.length
            );

        return {
            ...mark,
            wordIndex:
                foundIndex
        };
    });
}


async function preparePage(
    pageNumber,
    silent = false
) {
    if (pageCache.has(pageNumber)) {
        return pageCache.get(
            pageNumber
        );
    }

    if (
        preparationPromises.has(
            pageNumber
        )
    ) {
        return preparationPromises.get(
            pageNumber
        );
    }


    const preparationPromise =
        (async () => {
            if (!silent) {
                setStatus(
                    "جاري تجهيز النص..."
                );

                setLoading(5);
            }


            const image =
                await loadImage(
                    pageNumber
                );


            const worker =
                await getOcrWorker();


            const result =
                await runOcrInQueue(
                    () =>
                        worker.recognize(
                            image
                        )
                );


            const words =
                orderArabicWords(
                    result.data.words
                    ||
                    []
                );


            if (!words.length) {
                const emptyResult = {
                    page:
                        pageNumber,

                    words: [],

                    marks: [],

                    audio_url: "",

                    imageWidth:
                        image.naturalWidth,

                    imageHeight:
                        image.naturalHeight,

                    noText: true
                };

                pageCache.set(
                    pageNumber,
                    emptyResult
                );

                return emptyResult;
            }


            const text =
                words
                .map(word => word.text)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();


            if (!silent) {
                setStatus(
                    "جاري تجهيز صوت حامد..."
                );

                setLoading(82);
            }


            const voiceData =
                await fetchJsonWithRetry(
                    "/api/tts",
                    {
                        method:
                            "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body:
                            JSON.stringify({
                                text
                            })
                    }
                );


            const resultData = {
                page:
                    pageNumber,

                words,

                text,

                marks:
                    alignMarksToWords(
                        voiceData.marks
                        ||
                        [],
                        words
                    ),

                audio_url:
                    voiceData.audio_url,

                imageWidth:
                    image.naturalWidth,

                imageHeight:
                    image.naturalHeight,

                noText: false
            };


            pageCache.set(
                pageNumber,
                resultData
            );


            return resultData;
        })();


    preparationPromises.set(
        pageNumber,
        preparationPromise
    );


    try {
        return await preparationPromise;

    } finally {
        preparationPromises.delete(
            pageNumber
        );
    }
}


function drawTrackingLayer(data) {
    trackingLayer.innerHTML = "";

    for (
        let index = 0;
        index < data.words.length;
        index += 1
    ) {
        const word =
            data.words[index];

        const element =
            document.createElement(
                "div"
            );

        element.className =
            "word-box";

        element.style.left =
            `${
                word.x0
                /
                data.imageWidth
                *
                100
            }%`;

        element.style.top =
            `${
                word.y0
                /
                data.imageHeight
                *
                100
            }%`;

        element.style.width =
            `${
                word.width
                /
                data.imageWidth
                *
                100
            }%`;

        element.style.height =
            `${
                word.height
                /
                data.imageHeight
                *
                100
            }%`;

        element.title =
            word.text;


        element.addEventListener(
            "click",
            () => {
                const mark =
                    data.marks.find(
                        item =>
                            item.wordIndex
                            ===
                            index
                    );

                if (mark) {
                    audioPlayer.currentTime =
                        mark.start;

                    highlightWord(
                        index,
                        true
                    );
                }
            }
        );


        word.element =
            element;

        trackingLayer.appendChild(
            element
        );
    }
}


function highlightWord(
    index,
    scrollToWord = true
) {
    const words =
        currentPageData?.words
        ||
        [];


    if (!words.length) {
        return;
    }


    if (
        currentWordIndex >= 0
        &&
        words[currentWordIndex]
    ) {
        words[currentWordIndex]
            .element
            ?.classList
            .remove("active");
    }


    currentWordIndex =
        Math.max(
            0,
            Math.min(
                index,
                words.length - 1
            )
        );


    const activeElement =
        words[currentWordIndex]
        ?.element;


    activeElement
        ?.classList
        .add("active");


    if (
        scrollToWord
        &&
        activeElement
    ) {
        activeElement.scrollIntoView({
            behavior:
                "smooth",

            block:
                "center",

            inline:
                "center"
        });
    }
}


function usePageData(data) {
    currentPageData = data;
    currentWordIndex = -1;

    drawTrackingLayer(data);

    audioPlayer.pause();
    audioPlayer.src =
        data.audio_url;

    audioPlayer.playbackRate =
        Number(
            speedRange.value
        );

    progressRange.value = "0";
    timeText.textContent =
        "0:00 / 0:00";

    setLoading(100);

    if (data.words.length) {
        highlightWord(
            0,
            false
        );
    }

    setStatus(
        `الصفحة جاهزة: ${data.words.length} كلمة.`
    );
}


function applyZoom() {
    pageStage.style.width =
        `${basePageWidth * zoom}px`;

    zoomText.textContent =
        `${Math.round(
            zoom * 100
        )}%`;
}


async function loadPage(
    pageNumber,
    autoPlayAfterLoad = false
) {
    if (!sessionId) {
        return false;
    }


    const safePage =
        Math.max(
            1,
            Math.min(
                Number(pageNumber),
                totalPages
            )
        );


    currentPage = safePage;
    currentRequestToken += 1;

    const requestToken =
        currentRequestToken;


    audioPlayer.pause();
    currentPageData = null;
    currentWordIndex = -1;

    trackingLayer.innerHTML = "";

    progressRange.value = "0";
    timeText.textContent =
        "0:00 / 0:00";

    pageInput.value =
        String(currentPage);

    updateNavigationButtons();


    setStatus(
        `جاري عرض الصفحة ${currentPage}...`
    );

    setLoading(2);


    pageImage.src =
        pageImageUrl(
            currentPage
        );


    try {
        await pageImage.decode();

    } catch (error) {
        setStatus(
            "تعذر عرض الصفحة.",
            true
        );

        return false;
    }


    if (
        requestToken
        !==
        currentRequestToken
    ) {
        return false;
    }


    basePageWidth =
        pageImage.naturalWidth
        /
        PAGE_RENDER_SCALE;


    applyZoom();

    emptyState.hidden = true;
    pageStage.hidden = false;

    viewer.scrollTo({
        top: 0,
        behavior: "smooth"
    });


    setStatus(
        "تم عرض الصفحة. جاري تجهيز الصوت في الخلفية..."
    );


    let data;

    try {
        data =
            await preparePage(
                currentPage,
                false
            );

    } catch (error) {
        console.error(error);

        if (
            requestToken
            ===
            currentRequestToken
        ) {
            setStatus(
                error.message
                ||
                "تعذر تجهيز الصفحة.",
                true
            );

            setLoading(0);
        }

        return false;
    }


    if (
        requestToken
        !==
        currentRequestToken
    ) {
        return false;
    }


    if (data.noText) {
        currentPageData = data;
        trackingLayer.innerHTML = "";

        setStatus(
            "هذه الصفحة لا تحتوي نصًا واضحًا."
        );

        setLoading(100);

        return false;
    }


    usePageData(data);


    if (autoPlayAfterLoad) {
        await playCurrentAudio();
    }


    const nextPage =
        currentPage + 1;


    if (nextPage <= totalPages) {
        preparePage(
            nextPage,
            true
        ).catch(
            error =>
                console.log(
                    "تعذر التجهيز المسبق:",
                    error
                )
        );
    }


    return true;
}


async function playCurrentAudio() {
    if (
        !currentPageData
        ||
        !currentPageData.audio_url
    ) {
        return false;
    }


    audioPlayer.playbackRate =
        Number(
            speedRange.value
        );


    try {
        await audioPlayer.play();

        pauseButton.textContent =
            "⏸ إيقاف مؤقت";

        setStatus(
            `جاري التشغيل بسرعة ${speedRange.value}×`
        );

        return true;

    } catch (error) {
        setStatus(
            "اضغط تشغيل مرة أخرى."
        );

        return false;
    }
}


function findMarkAtTime(time) {
    const marks =
        currentPageData?.marks
        ||
        [];


    if (!marks.length) {
        return null;
    }


    let low = 0;
    let high =
        marks.length - 1;

    let result =
        marks[0];


    while (low <= high) {
        const middle =
            Math.floor(
                (low + high) / 2
            );


        if (
            marks[middle].start
            <=
            time
        ) {
            result =
                marks[middle];

            low =
                middle + 1;

        } else {
            high =
                middle - 1;
        }
    }


    return result;
}


async function playNextReadablePage() {
    if (automaticAdvanceRunning) {
        return;
    }


    automaticAdvanceRunning = true;


    try {
        let nextPage =
            currentPage + 1;


        while (
            nextPage
            <=
            totalPages
        ) {
            setStatus(
                `الانتقال إلى الصفحة ${nextPage}...`
            );


            const ready =
                await loadPage(
                    nextPage,
                    false
                );


            if (
                ready
                &&
                currentPageData
                &&
                currentPageData.audio_url
            ) {
                await playCurrentAudio();
                return;
            }


            nextPage += 1;
        }


        setStatus(
            "انتهت قراءة الملف بالكامل."
        );

    } finally {
        automaticAdvanceRunning = false;
    }
}


fileInput.addEventListener(
    "change",
    async () => {
        const file =
            fileInput.files?.[0];


        if (!file) {
            return;
        }


        if (
            !file.name
                .toLowerCase()
                .endsWith(".pdf")
        ) {
            alert(
                "اختر ملف PDF فقط."
            );

            return;
        }


        audioPlayer.pause();

        pageCache.clear();
        preparationPromises.clear();

        sessionId = "";
        totalPages = 0;
        currentPage = 1;

        enableControls(false);

        setStatus(
            "جاري فتح ملف PDF..."
        );

        setLoading(4);


        const formData =
            new FormData();

        formData.append(
            "file",
            file
        );


        try {
            const responseData =
                await fetchJsonWithRetry(
                    "/api/upload",
                    {
                        method:
                            "POST",

                        body:
                            formData
                    }
                );


            sessionId =
                responseData.session_id;

            totalPages =
                responseData.pages;


            totalPagesElement.textContent =
                String(totalPages);


            pageInput.max =
                String(totalPages);


            zoom = 1;

            enableControls(true);

            await loadPage(
                1,
                false
            );

        } catch (error) {
            console.error(error);

            setStatus(
                error.message
                ||
                "تعذر فتح الملف.",
                true
            );

            setLoading(0);

            alert(
                error.message
                ||
                "تعذر فتح الملف."
            );
        }
    }
);


playButton.addEventListener(
    "click",
    async () => {
        if (
            audioPlayer.paused
            &&
            audioPlayer.src
        ) {
            await playCurrentAudio();
            return;
        }


        if (!currentPageData) {
            const ready =
                await loadPage(
                    currentPage,
                    false
                );

            if (!ready) {
                return;
            }
        }


        await playCurrentAudio();
    }
);


pauseButton.addEventListener(
    "click",
    async () => {
        if (audioPlayer.paused) {
            await playCurrentAudio();

        } else {
            audioPlayer.pause();

            pauseButton.textContent =
                "▶ متابعة";

            setStatus(
                "تم إيقاف الصوت مؤقتًا."
            );
        }
    }
);


stopButton.addEventListener(
    "click",
    () => {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;

        pauseButton.textContent =
            "⏸ إيقاف مؤقت";

        progressRange.value = "0";

        highlightWord(
            0,
            false
        );

        setStatus(
            "تم إيقاف الصوت."
        );
    }
);


backButton.addEventListener(
    "click",
    () => {
        audioPlayer.currentTime =
            Math.max(
                0,
                audioPlayer.currentTime - 5
            );
    }
);


forwardButton.addEventListener(
    "click",
    () => {
        const duration =
            Number.isFinite(
                audioPlayer.duration
            )
                ? audioPlayer.duration
                : audioPlayer.currentTime + 5;


        audioPlayer.currentTime =
            Math.min(
                duration,
                audioPlayer.currentTime + 5
            );
    }
);


audioPlayer.addEventListener(
    "loadedmetadata",
    () => {
        timeText.textContent =
            `0:00 / ${formatTime(
                audioPlayer.duration
            )}`;
    }
);


audioPlayer.addEventListener(
    "timeupdate",
    () => {
        if (
            Number.isFinite(
                audioPlayer.duration
            )
            &&
            audioPlayer.duration > 0
        ) {
            progressRange.value =
                String(
                    Math.round(
                        audioPlayer.currentTime
                        /
                        audioPlayer.duration
                        *
                        1000
                    )
                );


            timeText.textContent =
                `${formatTime(
                    audioPlayer.currentTime
                )} / ${formatTime(
                    audioPlayer.duration
                )}`;
        }


        const mark =
            findMarkAtTime(
                audioPlayer.currentTime
            );


        if (
            mark
            &&
            mark.wordIndex
            !==
            currentWordIndex
        ) {
            highlightWord(
                mark.wordIndex,
                true
            );
        }
    }
);


audioPlayer.addEventListener(
    "ended",
    async () => {
        setStatus(
            "انتهت الصفحة."
        );


        if (
            autoNext.checked
            &&
            currentPage < totalPages
        ) {
            await playNextReadablePage();

        } else if (
            currentPage >= totalPages
        ) {
            setStatus(
                "انتهت قراءة الملف بالكامل."
            );
        }
    }
);


audioPlayer.addEventListener(
    "error",
    () => {
        setStatus(
            "حدث خطأ في تشغيل الصوت. اضغط تشغيل لإعادة المحاولة.",
            true
        );
    }
);


progressRange.addEventListener(
    "input",
    () => {
        if (
            Number.isFinite(
                audioPlayer.duration
            )
        ) {
            audioPlayer.currentTime =
                (
                    Number(
                        progressRange.value
                    )
                    /
                    1000
                )
                *
                audioPlayer.duration;
        }
    }
);


speedRange.addEventListener(
    "input",
    () => {
        const speed =
            Number(
                speedRange.value
            );


        speedText.textContent =
            `${speed.toFixed(1)}×`;


        audioPlayer.playbackRate =
            speed;


        setStatus(
            `السرعة: ${speed.toFixed(1)}×`
        );
    }
);


previousButton.addEventListener(
    "click",
    () => {
        loadPage(
            currentPage - 1,
            false
        );
    }
);


nextButton.addEventListener(
    "click",
    () => {
        loadPage(
            currentPage + 1,
            false
        );
    }
);


pageInput.addEventListener(
    "change",
    () => {
        loadPage(
            pageInput.value,
            false
        );
    }
);


zoomInButton.addEventListener(
    "click",
    () => {
        zoom =
            Math.min(
                2.2,
                zoom + 0.1
            );

        applyZoom();
    }
);


zoomOutButton.addEventListener(
    "click",
    () => {
        zoom =
            Math.max(
                0.6,
                zoom - 0.1
            );

        applyZoom();
    }
);


downloadButton.addEventListener(
    "click",
    () => {
        if (sessionId) {
            location.href =
                `/api/download/${sessionId}`;
        }
    }
);


fullscreenButton.addEventListener(
    "click",
    async () => {
        try {
            if (
                !document.fullscreenElement
            ) {
                await document
                    .documentElement
                    .requestFullscreen();

            } else {
                await document
                    .exitFullscreen();
            }

        } catch (error) {
            console.error(error);
        }
    }
);

</script>

</body>

</html>
"""


# =========================================================
# مسارات الموقع
# =========================================================

@app.get("/")
def home() -> Response:
    return Response(
        HTML,
        mimetype="text/html",
    )


@app.post("/api/upload")
def upload_pdf() -> Response:
    uploaded = request.files.get("file")

    if (
        not uploaded
        or not uploaded.filename
    ):
        return jsonify(
            {
                "error":
                    "اختر ملف PDF أولًا."
            }
        ), 400


    filename = uploaded.filename

    if not filename.lower().endswith(".pdf"):
        return jsonify(
            {
                "error":
                    "الملف يجب أن يكون PDF."
            }
        ), 400


    session_id = uuid.uuid4().hex

    pdf_path = (
        PDF_DIR
        / f"{session_id}.pdf"
    )

    uploaded.save(pdf_path)


    try:
        with fitz.open(pdf_path) as document:
            page_count = document.page_count

            if page_count < 1:
                raise ValueError(
                    "الملف لا يحتوي صفحات."
                )

    except Exception as error:
        pdf_path.unlink(
            missing_ok=True
        )

        return jsonify(
            {
                "error":
                    f"تعذر فتح PDF: {error}"
            }
        ), 400


    sessions[session_id] = {
        "path":
            str(pdf_path),

        "name":
            filename,

        "pages":
            page_count,

        "created":
            time.time(),
    }


    return jsonify(
        {
            "session_id":
                session_id,

            "filename":
                filename,

            "pages":
                page_count,

            "voice":
                VOICE,
        }
    )


@app.get(
    "/api/page/<session_id>/<int:page_number>"
)
def page_image(
    session_id: str,
    page_number: int,
) -> Response:

    session = get_session(
        session_id
    )


    try:
        scale = float(
            request.args.get(
                "scale",
                "1.8",
            )
        )

    except ValueError:
        scale = 1.8


    scale = max(
        1.0,
        min(
            scale,
            3.0,
        ),
    )


    scale_name = (
        str(round(scale, 2))
        .replace(".", "_")
    )


    cached_image = (
        PAGE_DIR
        /
        (
            f"{session_id}_"
            f"{page_number}_"
            f"{scale_name}.png"
        )
    )


    if not cached_image.exists():
        with fitz.open(
            session["path"]
        ) as document:

            if (
                page_number < 1
                or
                page_number > document.page_count
            ):
                abort(404)


            page = document.load_page(
                page_number - 1
            )


            pixmap = page.get_pixmap(
                matrix=fitz.Matrix(
                    scale,
                    scale,
                ),

                colorspace=fitz.csRGB,

                alpha=False,
            )


            temporary_image = (
                cached_image.with_suffix(
                    f".{uuid.uuid4().hex}.tmp"
                )
            )


            temporary_image.write_bytes(
                pixmap.tobytes("png")
            )


            temporary_image.replace(
                cached_image
            )


    response = send_file(
        cached_image,
        mimetype="image/png",
    )


    response.headers["Cache-Control"] = (
        "private, max-age=86400"
    )


    return response


@app.get(
    "/api/download/<session_id>"
)
def download_pdf(
    session_id: str,
) -> Response:

    session = get_session(
        session_id
    )


    return send_file(
        session["path"],

        as_attachment=True,

        download_name=
            session["name"],

        mimetype=
            "application/pdf",
    )


@app.post("/api/tts")
def create_voice() -> Response:
    payload = (
        request.get_json(
            silent=True
        )
        or {}
    )


    text = clean_text(
        payload.get(
            "text",
            "",
        )
    )


    if not text:
        return jsonify(
            {
                "error":
                    "لا يوجد نص لتوليد الصوت."
            }
        ), 400


    if len(text) > 25_000:
        return jsonify(
            {
                "error":
                    "نص الصفحة طويل جدًا."
            }
        ), 400


    cache_key = hashlib.sha256(
        f"{VOICE}|{text}".encode(
            "utf-8"
        )
    ).hexdigest()


    audio_path = (
        AUDIO_DIR
        / f"{cache_key}.mp3"
    )


    marks_path = (
        AUDIO_DIR
        / f"{cache_key}.json"
    )


    try:
        if (
            audio_path.exists()
            and marks_path.exists()
        ):
            marks = json.loads(
                marks_path.read_text(
                    encoding="utf-8"
                )
            )

        else:
            marks = generate_audio(
                text,
                audio_path,
            )


            marks_path.write_text(
                json.dumps(
                    marks,
                    ensure_ascii=False,
                ),

                encoding="utf-8",
            )

    except Exception as error:
        return jsonify(
            {
                "error":
                    (
                        "تعذر توليد صوت حامد: "
                        f"{error}"
                    )
            }
        ), 500


    return jsonify(
        {
            "voice":
                VOICE,

            "audio_url":
                f"/api/audio/{cache_key}",

            "marks":
                marks,
        }
    )


@app.get(
    "/api/audio/<cache_key>"
)
def audio_file(
    cache_key: str,
) -> Response:

    if not re.fullmatch(
        r"[a-f0-9]{64}",
        cache_key,
    ):
        abort(404)


    audio_path = (
        AUDIO_DIR
        / f"{cache_key}.mp3"
    )


    if not audio_path.exists():
        abort(404)


    response = send_file(
        audio_path,

        mimetype="audio/mpeg",

        conditional=True,
    )


    response.headers["Cache-Control"] = (
        "private, max-age=86400"
    )


    return response


@app.errorhandler(413)
def file_too_large(
    _error: Exception,
) -> Response:

    return jsonify(
        {
            "error":
                "حجم الملف أكبر من 500 ميجابايت."
        }
    ), 413


# =========================================================
# التشغيل
# =========================================================

if __name__ == "__main__":
    clean_old_files()

    port = find_free_port()

    url = f"http://{HOST}:{port}"

    print("")
    print("قارئ PDF العربي يعمل الآن:")
    print(url)
    print("")
    print(
        "اترك نافذة CMD مفتوحة أثناء الاستخدام."
    )
    print("")

    threading.Timer(
        1.2,
        lambda: webbrowser.open(url),
    ).start()

    app.run(
        host=HOST,
        port=port,
        debug=False,
        threaded=True,
        use_reloader=False,
    )