import fs from "fs";

for (const filepath of ["apps/api/data/deploy-seed.json", "apps/api/data/runtime-store.json"]) {
  if (!fs.existsSync(filepath)) continue;
  const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  console.log(`=== ${filepath} ===`);
  for (const b of data.books) {
    const sampleCount = (b.chapters || []).filter(c => c.isSample).length;
    const totalCount = (b.chapters || []).length;
    console.log(`Book: id=${b.id} title=${b.title} priceMinor=${b.priceMinor} chapters=${totalCount} samples=${sampleCount}`);
    if (b.chapters && b.chapters.length > 0) {
      console.log(`  Ch 1: id=${b.chapters[0].id} title=${b.chapters[0].title} isSample=${b.chapters[0].isSample}`);
      if (b.chapters.length > 1) {
        console.log(`  Ch 2: id=${b.chapters[1].id} title=${b.chapters[1].title} isSample=${b.chapters[1].isSample}`);
      }
    }
  }
}
