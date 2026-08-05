# rethox-tts-sideproject

Minimal standalone demo: accepts a plain UTF-8 text (BDF) file, generates cached Arabic narration (MP3) and per-word timing metadata (JSON), and provides a simple web player with synchronized highlighting and controls.

Quick start (requires Node.js 18+ and Python 3.8+):

1. Install Node deps:

```bash
cd tools/tts-sideproject
npm install
```

2. (Optional) Install Python dependencies for better results:

```bash
python -m pip install --user gtts pydub
# ffmpeg is required by pydub; install via your platform package manager
```

3. Start server:

```bash
npm run dev
```

Open http://localhost:5174 and upload a BDF/text file.

Notes:
- This project is intentionally standalone and uses a different metadata shape than the main repo.
- If `edge-tts` is available in your Python environment, you can edit `py/tts_gen.py` to use it; the current script uses `gtts` fallback and an approximate timing method when precise boundaries are unavailable.
