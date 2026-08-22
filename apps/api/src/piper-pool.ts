import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type PiperJob = {
  voice: string;
  text: string;
  /** Absolute path the worker writes the MP3 (and sibling `.json` metadata) to. */
  out: string;
  timeoutMs: number;
};

type Pending = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Worker = {
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  busy: boolean;
  pending: Map<string, Pending>;
};

/**
 * A small pool of persistent Piper worker processes.
 *
 * `tools/tts_piper.py` reloads the ONNX voice model from disk on every call,
 * which dominates latency for short narration paragraphs. This pool instead
 * keeps `size` long-lived `piper_server.py` processes running, each with the
 * model resident after its first request, and hands work to whichever one is
 * idle — turning per-request "load model, synth, exit" into "synth" only.
 *
 * Concurrency itself is *not* enforced here: the caller (see the Piper
 * `TtsGenerationQueue` in index.ts) must never have more jobs in flight than
 * `size`, so this pool can assume an idle worker always exists when
 * `synthesize` is called.
 */
export class PiperPool {
  private readonly workers: Worker[] = [];
  private shuttingDown = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly size: number,
  ) {}

  private spawnWorker(): Worker {
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    const worker: Worker = { child, buffer: "", busy: false, pending: new Map() };

    child.stdout.on("data", (chunk: Buffer) => {
      worker.buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = worker.buffer.indexOf("\n")) >= 0) {
        const line = worker.buffer.slice(0, newlineIndex).trim();
        worker.buffer = worker.buffer.slice(newlineIndex + 1);
        if (!line) continue;
        this.handleLine(worker, line);
      }
    });

    const failAllPending = (error: Error) => {
      for (const job of worker.pending.values()) {
        clearTimeout(job.timer);
        job.reject(error);
      }
      worker.pending.clear();
    };

    child.on("exit", (code, signal) => {
      failAllPending(new Error(`piper worker exited (code=${code}, signal=${signal})`));
      const index = this.workers.indexOf(worker);
      if (index >= 0) this.workers.splice(index, 1);
      // A worker that dies mid-job (OOM, killed for a hung request, crash on
      // a malformed voice file) must not permanently shrink the pool — respawn
      // it so capacity stays at `size` for the rest of the process lifetime.
      if (!this.shuttingDown) this.workers.push(this.spawnWorker());
    });
    child.on("error", (error) => failAllPending(error));
    child.stdin.on("error", () => undefined);

    return worker;
  }

  private handleLine(worker: Worker, line: string) {
    let parsed: { id?: string; ok?: boolean; error?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // stray stderr-like noise on stdout; ignore rather than crash the pool
    }
    const job = parsed.id ? worker.pending.get(parsed.id) : undefined;
    if (!job) return;
    worker.pending.delete(parsed.id!);
    clearTimeout(job.timer);
    worker.busy = worker.pending.size > 0;
    if (parsed.ok) job.resolve();
    else job.reject(new Error(parsed.error || "piper worker reported an unspecified error"));
  }

  /** Starts the pool's processes if they are not already running. Safe to call repeatedly. */
  ensureStarted(): void {
    while (this.workers.length < this.size) this.workers.push(this.spawnWorker());
  }

  /**
   * Runs one synthesis job on an idle worker.
   *
   * Callers are responsible for never having more than `size` jobs in flight
   * at once (the reserved-slot queue in index.ts guarantees this) — if every
   * worker is busy anyway, the job is rejected immediately rather than
   * silently queuing a second time behind the outer queue's own bookkeeping.
   */
  synthesize(job: PiperJob): Promise<void> {
    this.ensureStarted();
    const worker = this.workers.find((candidate) => !candidate.busy);
    if (!worker) return Promise.reject(new Error("piper pool exhausted: no idle worker available"));
    worker.busy = true;
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.pending.delete(id);
        // Deliberately leave `busy` true: the worker is still alive (and
        // possibly still writing) until its `exit` handler fires and splices
        // it out of the pool, so it must stay unselectable in the meantime —
        // otherwise a concurrent synthesize() could hand a fresh job to a
        // worker that is already being killed.
        worker.child.kill("SIGKILL");
        reject(new Error(`piper worker timed out after ${job.timeoutMs}ms`));
      }, job.timeoutMs);
      timer.unref?.();
      worker.pending.set(id, { resolve, reject, timer });
      worker.child.stdin.write(
        `${JSON.stringify({ id, voice: job.voice, text: job.text, out: job.out })}\n`,
        (error) => {
          if (!error) return;
          worker.pending.delete(id);
          clearTimeout(timer);
          worker.busy = worker.pending.size > 0;
          reject(error);
        },
      );
    });
  }

  /** Kills every worker. Call on process shutdown to avoid orphaned Python processes. */
  shutdown(): void {
    this.shuttingDown = true;
    for (const worker of this.workers) worker.child.kill();
  }
}
