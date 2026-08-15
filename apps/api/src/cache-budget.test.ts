import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trimPairedCache } from "./cache-budget.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("trimPairedCache", () => {
  it("removes old cache pairs while preserving the active item", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "rethox-cache-"));
    temporaryDirectories.push(directory);
    for (const base of ["a", "b", "c"]) {
      await writeFile(resolve(directory, `${base}.mp3`), Buffer.alloc(10));
      await writeFile(resolve(directory, `${base}.json`), Buffer.alloc(5));
    }
    const old = new Date(Date.now() - 60_000);
    await utimes(resolve(directory, "a.mp3"), old, old);
    await utimes(resolve(directory, "a.json"), old, old);

    expect(await trimPairedCache(directory, 20, "c")).toBe(30);
    await expect(statExists(resolve(directory, "a.mp3"))).resolves.toBe(false);
    await expect(statExists(resolve(directory, "c.mp3"))).resolves.toBe(true);
  });
});

const statExists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
