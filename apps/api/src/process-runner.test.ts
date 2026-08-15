import { describe, expect, it } from "vitest";
import { runProcess } from "./process-runner.js";

describe("runProcess", () => {
  it("resolves after a successful process", async () => {
    await expect(runProcess(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 2_000 }))
      .resolves.toBeUndefined();
  });

  it("terminates a process that stops responding", async () => {
    await expect(runProcess(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 50 },
    )).rejects.toThrow("timed out");
  });
});
