import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiperPool } from "./piper-pool.js";

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/fake-piper-worker.mjs",
);

// Exercises the pool against a fake worker (see the fixture) so these tests
// don't need Python or a real Piper voice model installed.
const makePool = (size: number) => new PiperPool(process.execPath, [fixture], size);

describe("PiperPool", () => {
  let pool: PiperPool | undefined;
  afterEach(() => {
    pool?.shutdown();
    pool = undefined;
  });

  it("runs jobs on separate workers and lets both complete", async () => {
    pool = makePool(2);
    await Promise.all([
      pool.synthesize({ voice: "v", text: "hello", out: "a.mp3", timeoutMs: 2000 }),
      pool.synthesize({ voice: "v", text: "world", out: "b.mp3", timeoutMs: 2000 }),
    ]);
  });

  it("rejects immediately when every worker is already busy", async () => {
    pool = makePool(1);
    const busy = pool.synthesize({ voice: "v", text: "HANG", out: "a.mp3", timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 10)); // let the job actually claim the only worker
    await expect(
      pool.synthesize({ voice: "v", text: "hello", out: "b.mp3", timeoutMs: 2000 }),
    ).rejects.toThrow("no idle worker available");
    busy.catch(() => undefined); // left pending; cleaned up by shutdown() in afterEach
  });

  it("surfaces a worker-reported error without killing the worker", async () => {
    pool = makePool(1);
    await expect(
      pool.synthesize({ voice: "v", text: "ERROR", out: "a.mp3", timeoutMs: 2000 }),
    ).rejects.toThrow("boom");
    // The worker is still alive (it replied, it didn't crash), so it can take more work.
    await pool.synthesize({ voice: "v", text: "hello", out: "b.mp3", timeoutMs: 2000 });
  });

  it("respawns a worker that crashes mid-job and keeps serving new work", async () => {
    pool = makePool(1);
    await expect(
      pool.synthesize({ voice: "v", text: "CRASH", out: "a.mp3", timeoutMs: 2000 }),
    ).rejects.toThrow(/exited/);
    // Give the exit handler a tick to splice out the dead worker and spawn its replacement.
    await new Promise((r) => setTimeout(r, 20));
    await pool.synthesize({ voice: "v", text: "hello", out: "b.mp3", timeoutMs: 2000 });
  });

  it("times out a wedged job, kills the worker, and recovers pool capacity", async () => {
    pool = makePool(1);
    await expect(
      pool.synthesize({ voice: "v", text: "HANG", out: "a.mp3", timeoutMs: 30 }),
    ).rejects.toThrow("timed out after 30ms");
    await new Promise((r) => setTimeout(r, 30)); // let SIGKILL land and the replacement spawn
    await pool.synthesize({ voice: "v", text: "hello", out: "b.mp3", timeoutMs: 2000 });
  });
});
