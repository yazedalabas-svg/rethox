import { readFileSync } from "node:fs";

const root = "C:/Users/yazed/rethox/";
const files = ["apps/api/data/deploy-seed.json", "apps/api/data/runtime-store.json"];
const bookId = "book-rezero-arc-6";
const latin = /[A-Za-zÀ-ÿ]/;
const latinWord = /[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ•~'’\-]*/g;
const limit = Math.max(1, Number(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) || 60));

const terms = [
  ["Witch Beasts", "الوحوش الساحرة"],
  ["Witchbeasts", "الوحوش الساحرة"],
  ["Witchbeast", "وحش ساحر"],
  ["Witch Cult", "عبادة الساحرة"],
  ["Crimson Scorpion", "العقرب القرمزي"],
  ["Hungry Horse Kings", "ملوك الخيول الجائعة"],
  ["Earth Dragon", "تنين الأرض"],
  ["Return by Death", "العودة بالموت"],
  ["Cor Leonis", "كور ليونيس"],
  ["Ice Brand Arts", "فنون علامة الجليد"],
  ["Icicle Line", "خط الجليد"],
  ["Pleiades Watchtower", "برج مراقبة الثريا"],
  ["Witchbeast Den", "وكر الوحوش الساحرة"],
  ["Miasma", "مياسما"],
  ["Gluttony", "الشراهة"],
  ["Lust", "الشهوة"],
  ["Sage", "الحكيم"],
  ["Spirit", "روح"],
  ["Spirits", "الأرواح"],
  ["Subaru", "سوبارو"],
  ["Emilia", "إميليا"],
  ["Beatrice", "بياتريس"],
  ["Julius", "يوليوس"],
  ["Ram", "رام"],
  ["Rem", "ريم"],
  ["Meili", "ميلي"],
  ["Ley", "لي"],
  ["Lye", "لي"],
  ["Louis", "لويس"],
  ["Roy", "روي"],
  ["Reid", "ريد"],
  ["Regulus", "ريغولوس"],
  ["Volcanica", "فولكانيكا"],
  ["Echidna", "إيكيدنا"],
  ["Anastasia", "أنستازيا"],
  ["Shaula", "شاولا"],
  ["Flugel", "فلوغل"],
  ["Batenkaitos", "باتينكايتوس"],
  ["Patrasche", "باتراش"],
  ["Majuus", "الوحوش"],
  ["Majuu", "وحش"],
  ["SFX", "مؤثر صوتي"],
  ["T/N", "ملاحظة المترجم"],
];

const fallbackLetters = {
  a: "ا", b: "ب", c: "ك", d: "د", e: "ي", f: "ف", g: "غ", h: "ه", i: "ي", j: "ج",
  k: "ك", l: "ل", m: "م", n: "ن", o: "و", p: "ب", q: "ق", r: "ر", s: "س", t: "ت",
  u: "و", v: "ف", w: "و", x: "كس", y: "ي", z: "ز",
};

const translate = async (text, source = "auto") => {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", source);
  url.searchParams.set("tl", "ar");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text);
  let failure;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 Rethox/1.0" } });
      if (!response.ok) throw new Error(`translation ${response.status}`);
      const payload = await response.json();
      const value = payload?.[0]?.map((part) => part?.[0] || "").join("").trim();
      if (value) return value;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw failure || new Error("translation failed");
};

const parallel = async (items, worker, concurrency = 4) => {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
};

const arabizeFallback = (word) => [...word.toLowerCase()].map((letter) => fallbackLetters[letter] || "").join("") || "نص";

const clean = async (input) => {
  let value = await translate(input);
  for (const [from, to] of terms) value = value.replaceAll(from, to);
  const words = [...new Set(value.match(latinWord) || [])];
  const replacements = new Map();
  await parallel(words, async (word) => {
    try {
      const translated = await translate(word, "en");
      replacements.set(word, latin.test(translated) ? arabizeFallback(word) : translated);
    } catch {
      replacements.set(word, arabizeFallback(word));
    }
  });
  for (const [from, to] of replacements) value = value.replaceAll(from, to);
  return value.replace(latinWord, (word) => arabizeFallback(word)).replace(/\s+([،؛؟.!])/g, "$1").trim();
};

const source = JSON.parse(readFileSync(root + files[0], "utf8"));
const book = source.books.find((item) => item.id === bookId);
const targets = [];
for (const chapter of book.chapters) for (const sentence of chapter.sentences || []) {
  if (latin.test(sentence.text || "")) targets.push({ id: sentence.id, text: sentence.text });
}
const selected = targets.slice(0, limit);
const translated = await parallel(selected, async (item) => ({ ...item, next: await clean(item.text) }));

let patch = "*** Begin Patch\n";
for (const file of files) {
  const raw = readFileSync(root + file, "utf8");
  const lines = raw.split(/\r?\n/);
  patch += `*** Update File: ${root}${file}\n`;
  for (const { id, next } of translated) {
    const idLine = lines.findIndex((line) => line.includes(`"id": "${id}"`));
    const textLine = lines.slice(idLine, idLine + 6).find((line) => line.includes('"text": '));
    const positionLine = lines.slice(idLine, idLine + 4).find((line) => line.includes('"position": '));
    const prefix = textLine.match(/^(\s*"text": )/)[1];
    const old = JSON.parse(textLine.trim().replace(/^"text": /, "").replace(/,$/, ""));
    patch += `@@\n ${lines[idLine]}\n ${positionLine}\n-${textLine}\n+${prefix}${JSON.stringify(next)},\n`;
    if (!latin.test(old) || latin.test(next)) throw new Error(`Latin text remains in ${id}`);
  }
}
patch += "*** End Patch\n";
process.stdout.write(patch);
