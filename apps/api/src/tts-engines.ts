import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * The narration voices a reader can pick from.
 *
 * Every engine here is self-hosted or free with no per-character billing, so
 * adding voices never introduces a usage cap. A voice is only offered to the
 * reader once `availableEngines()` confirms its runtime is actually installed —
 * an engine that cannot generate must never appear as a choice, and a failed
 * generation must still surface as an error rather than silently swapping the
 * narrator for a different voice.
 */
export type TtsEngineKind = "edge" | "piper";

export type TtsEngine = {
  id: string;
  label: string;
  description: string;
  kind: TtsEngineKind;
  /** Engine-specific voice identifier passed to the generator script. */
  voice: string;
  /**
   * "exact" — the engine reports real word boundaries, so highlighting lands on
   * the exact spoken word. "estimated" — timings are derived from audio length,
   * so highlighting tracks closely but can drift within a sentence.
   */
  wordTimings: "exact" | "estimated";
};

export const ttsEngines: TtsEngine[] = [
  {
    id: "hamed",
    label: "حامد — فصحى (السعودية)",
    description: "الصوت الافتراضي. تظليل دقيق لكل كلمة.",
    kind: "edge",
    voice: "ar-SA-HamedNeural",
    wordTimings: "exact",
  },
  {
    id: "zariyah",
    label: "زارية — فصحى (السعودية)",
    description: "صوت نسائي هادئ. تظليل دقيق لكل كلمة.",
    kind: "edge",
    voice: "ar-SA-ZariyahNeural",
    wordTimings: "exact",
  },
  {
    id: "shakir",
    label: "شاكر — مصري",
    description: "صوت رجالي بلكنة مصرية. تظليل دقيق لكل كلمة.",
    kind: "edge",
    voice: "ar-EG-ShakirNeural",
    wordTimings: "exact",
  },
  {
    id: "salma",
    label: "سلمى — مصرية",
    description: "صوت نسائي بلكنة مصرية. تظليل دقيق لكل كلمة.",
    kind: "edge",
    voice: "ar-EG-SalmaNeural",
    wordTimings: "exact",
  },
  {
    id: "hala",
    label: "هلا — إماراتي",
    description: "صوت نسائي بلكنة إماراتية. تظليل دقيق لكل كلمة.",
    kind: "edge",
    voice: "ar-AE-FatimaNeural",
    wordTimings: "exact",
  },
  {
    id: "piper-kareem",
    label: "كريم — محلي (Piper)",
    description: "يعمل على خادمنا بالكامل بدون أي خدمة خارجية. التظليل تقريبي.",
    kind: "piper",
    voice: "ar_JO-kareem-medium",
    wordTimings: "estimated",
  },
];

export const defaultEngineId = "hamed";

/** Where Piper voice models (`<voice>.onnx` + `.onnx.json`) are expected. */
export const piperVoiceDir = process.env.PIPER_VOICE_DIR
  ? resolve(process.env.PIPER_VOICE_DIR)
  : resolve(process.cwd(), "data/piper-voices");

const probeCache = new Map<TtsEngineKind, boolean>();

const probeKind = (kind: TtsEngineKind, pythonCommand: string): boolean => {
  const cached = probeCache.get(kind);
  if (cached !== undefined) return cached;
  let available = false;
  if (kind === "edge") {
    available = spawnSync(pythonCommand, ["-c", "import edge_tts"], { stdio: "ignore" }).status === 0;
  } else if (kind === "piper") {
    available = spawnSync(pythonCommand, ["-c", "import piper"], { stdio: "ignore" }).status === 0;
  }
  probeCache.set(kind, available);
  return available;
};

const engineInstalled = (engine: TtsEngine, pythonCommand: string): boolean => {
  if (!probeKind(engine.kind, pythonCommand)) return false;
  // A Piper runtime without its voice model cannot speak, so treat the voice
  // file as part of the engine being installed.
  if (engine.kind === "piper")
    return existsSync(resolve(piperVoiceDir, `${engine.voice}.onnx`));
  return true;
};

/** The voices this deployment can actually generate right now. */
export const availableEngines = (pythonCommand: string): TtsEngine[] =>
  ttsEngines.filter((engine) => engineInstalled(engine, pythonCommand));

export const findEngine = (id: string): TtsEngine | undefined =>
  ttsEngines.find((engine) => engine.id === id);
