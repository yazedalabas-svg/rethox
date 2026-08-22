import { describe, expect, it } from "vitest";
import { TtsGenerationQueue } from "./tts-queue.js";

describe("TtsGenerationQueue", () => {
  it("serializes different jobs and joins identical work", async () => {
    const queue = new TtsGenerationQueue(0);
    let active = 0, peak = 0, calls = 0;
    const work = async (value: string) => {
      calls += 1; active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value;
    };
    const [first, duplicate, second] = await Promise.all([
      queue.run("same", () => work("first")),
      queue.run("same", () => work("first")),
      queue.run("next", () => work("second")),
    ]);
    expect([first, duplicate, second]).toEqual(["first", "first", "second"]);
    expect(calls).toBe(2);
    expect(peak).toBe(1);
  });

  it("continues processing after a failed generation", async () => {
    const queue = new TtsGenerationQueue(0);
    await expect(queue.run("bad", async () => { throw new Error("temporary"); })).rejects.toThrow("temporary");
    await expect(queue.run("good", async () => "ready")).resolves.toBe("ready");
  });

  it("runs narration work before queued background warming", async () => {
    const queue = new TtsGenerationQueue(0);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = queue.run("first", async () => {
      order.push("first");
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return "first";
    });
    await Promise.resolve();
    const warming = queue.run("warming", async () => { order.push("warming"); return "warming"; }, "background");
    const narration = queue.run("narration", async () => { order.push("narration"); return "narration"; });
    releaseFirst();

    await expect(Promise.all([first, warming, narration])).resolves.toEqual(["first", "warming", "narration"]);
    expect(order).toEqual(["first", "narration", "warming"]);
  });

  it("runs up to `concurrency` jobs in parallel", async () => {
    const queue = new TtsGenerationQueue(0, 3);
    let active = 0, peak = 0;
    const releases: Array<() => void> = [];
    const makeJob = () => queue.run(Math.random().toString(), async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    });
    const jobs = [makeJob(), makeJob(), makeJob(), makeJob()];
    await Promise.resolve(); await Promise.resolve();
    // The pool holds 3 workers, so the 4th job must still be waiting.
    expect(active).toBe(3);
    releases.forEach((release) => release());
    await Promise.resolve(); await Promise.resolve();
    releases.slice(3).forEach((release) => release());
    await Promise.all(jobs);
    expect(peak).toBe(3);
  });

  it("keeps a slot reserved for foreground work even when background jobs fill the rest of the pool", async () => {
    const queue = new TtsGenerationQueue(0, 3); // reservedForegroundSlots defaults to 1
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const makeJob = (name: string, priority: "foreground" | "background") =>
      queue.run(name, async () => {
        started.push(name);
        await new Promise<void>((resolve) => releases.set(name, resolve));
      }, priority);

    const bg1 = makeJob("bg1", "background");
    const bg2 = makeJob("bg2", "background");
    const bg3 = makeJob("bg3", "background");
    await Promise.resolve(); await Promise.resolve();
    // Background capacity is concurrency(3) - reserved(1) = 2, so only two of
    // the three background jobs may be running at once.
    expect(started).toEqual(["bg1", "bg2"]);

    const fg1 = makeJob("fg1", "foreground");
    await Promise.resolve(); await Promise.resolve();
    // The foreground job takes the third, reserved slot immediately instead
    // of queuing behind bg3.
    expect(started).toEqual(["bg1", "bg2", "fg1"]);

    releases.get("bg1")!();
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(["bg1", "bg2", "fg1", "bg3"]);

    releases.get("bg2")!();
    releases.get("bg3")!();
    releases.get("fg1")!();
    await Promise.all([bg1, bg2, bg3, fg1]);
  });
});
