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
});
