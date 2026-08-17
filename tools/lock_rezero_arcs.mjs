import fs from "fs";
import path from "path";

const projectRoot = process.cwd();
const dataDir = path.join(projectRoot, "apps/api/data");

console.log("Updating Re:Zero Arc 7 & 8 locking configuration...");

const updateStoreFile = (filename) => {
  const filePath = path.join(dataDir, filename);
  if (!fs.existsSync(filePath)) return;
  const store = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  
  for (const book of store.books || []) {
    if (book.id === "book-rezero-arc-7" || book.id === "book-rezero-arc-8") {
      book.priceMinor = book.priceMinor || 2900;
      let isFirst = true;
      for (const ch of book.chapters || []) {
        if (ch.position === 1 || isFirst) {
          ch.isSample = true;
          isFirst = false;
        } else {
          ch.isSample = false;
        }
        if (ch.sections && ch.sections.length > 0) {
          ch.sections.forEach((sec, idx) => {
            sec.isSample = (ch.isSample && idx === 0);
          });
        }
      }
      console.log(`Updated ${book.id} in ${filename}: priceMinor=${book.priceMinor}, total chapters=${book.chapters.length}, sample chapters=${book.chapters.filter(c => c.isSample).length}`);
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
};

updateStoreFile("deploy-seed.json");
updateStoreFile("runtime-store.json");

// Now update derived volume files if any exist
for (const arcNum of [7, 8]) {
  const derivedDir = path.join(dataDir, `books/ReZero Arc ${arcNum}/derived`);
  if (fs.existsSync(derivedDir)) {
    const files = fs.readdirSync(derivedDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      const fullPath = path.join(derivedDir, file);
      const data = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      let updated = false;
      for (const ch of data.chapters || []) {
        const shouldBeSample = (ch.position === 1);
        if (ch.isSample !== shouldBeSample) {
          ch.isSample = shouldBeSample;
          updated = true;
        }
        if (ch.sections && ch.sections.length > 0) {
          ch.sections.forEach((sec, idx) => {
            sec.isSample = (shouldBeSample && idx === 0);
          });
          updated = true;
        }
      }
      if (updated) {
        fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), "utf-8");
        console.log(`Updated derived file ${file} for Arc ${arcNum}`);
      }
    }
  }
}

console.log("Done updating arcs!");
