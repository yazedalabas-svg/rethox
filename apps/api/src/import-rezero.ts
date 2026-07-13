import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Book, Store } from "./types.js";

const storePath = resolve(process.cwd(), "data/runtime-store.json");
if (!existsSync(storePath)) throw new Error(`Store not found: ${storePath}`);

const store = JSON.parse(readFileSync(storePath, "utf8")) as Store;
const book: Book = {
  id: "book-rezero-arc-6",
  slug: "rezero-arc-6-arabic",
  title: "ري:زيرو — الآرك السادس",
  author: "تَابي ناغاتسوكي",
  synopsis:
    "رحلة طويلة نحو برج المراقبة في كثبان أوجريا، حيث يواجه سوبارو ورفاقه اختبارات الذاكرة والهوية والنجاة. النسخة متاحة بصيغة PDF كاملة داخل المنصة.",
  priceMinor: 0,
  currency: "SAR",
  genre: "فانتازيا",
  tags: ["ري:زيرو", "فانتازيا", "رواية مترجمة"],
  coverTheme: "ember",
  status: "PUBLISHED",
  rating: 4.9,
  documentFile: "rezero-arc-6-ar.pdf",
  pageCount: 980,
  chapters: [],
};

const index = store.books.findIndex(
  (item) => item.id === book.id || item.slug === book.slug,
);
if (index >= 0) store.books[index] = book;
else store.books.unshift(book);

writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
console.log(`Imported ${book.title} (${book.pageCount} pages)`);
