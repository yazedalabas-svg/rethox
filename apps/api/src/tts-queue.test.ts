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
});
