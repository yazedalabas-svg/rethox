import { spawn } from "node:child_process";

type ProcessOptions = {
  input?: string;
  timeoutMs?: number;
  stderrLimit?: number;
};

/** Runs a child process without allowing it or its error output to grow forever. */
export const runProcess = (
  command: string,
  args: string[],
  options: ProcessOptions = {},
) => new Promise<void>((resolve, reject) => {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const stderrLimit = options.stderrLimit ?? 16_384;
  const child = spawn(command, args, {
    stdio: [options.input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
  });
  let stderr = "";
  let settled = false;

  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve();
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(new Error(`${command} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  child.stderr?.on("data", (chunk) => {
    if (stderr.length < stderrLimit)
      stderr += chunk.toString().slice(0, stderrLimit - stderr.length);
  });
  child.on("error", (error) => finish(error));
  child.on("close", (code) => finish(
    code === 0 ? undefined : new Error(stderr.trim() || `${command} exited ${code}`),
  ));
  child.stdin?.on("error", () => undefined);
  if (options.input !== undefined) child.stdin?.end(options.input, "utf8");
});
