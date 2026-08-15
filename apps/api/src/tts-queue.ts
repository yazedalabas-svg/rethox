type PendingJob<T> = {
  key: string;
  priority: "foreground" | "background";
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

/** Keeps Edge TTS requests serial and merges duplicate cache misses. */
export class TtsGenerationQueue {
  private readonly pending: PendingJob<unknown>[] = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private running = false;

  constructor(private readonly gapMs = 450) {}

  run<T>(key: string, work: () => Promise<T>, priority: "foreground" | "background" = "foreground"): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      // A pre-warm request may already be waiting when the reader reaches that
      // paragraph. Promote the same job instead of leaving audible playback
      // behind unrelated cache warming work.
      if (priority === "foreground") {
        const queuedIndex = this.pending.findIndex((job) => job.key === key);
        if (queuedIndex >= 0 && this.pending[queuedIndex].priority === "background") {
          const [queued] = this.pending.splice(queuedIndex, 1);
          queued.priority = "foreground";
          const firstBackground = this.pending.findIndex((job) => job.priority === "background");
          this.pending.splice(firstBackground < 0 ? this.pending.length : firstBackground, 0, queued);
        }
      }
      return existing as Promise<T>;
    }
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    this.inFlight.set(key, promise);
    const job = { key, priority, work: work as () => Promise<unknown>, resolve: resolve as (value: unknown) => void, reject };
    if (priority === "foreground") {
      const firstBackground = this.pending.findIndex((item) => item.priority === "background");
      this.pending.splice(firstBackground < 0 ? this.pending.length : firstBackground, 0, job);
    } else {
      this.pending.push(job);
    }
    void this.drain();
    return promise;
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const job = this.pending.shift();
        if (!job) continue;
        try { job.resolve(await job.work()); }
        catch (error) { job.reject(error); }
        finally { this.inFlight.delete(job.key); }
        if (this.pending.length && this.gapMs) await new Promise((resolve) => setTimeout(resolve, this.gapMs));
      }
    } finally {
      this.running = false;
      if (this.pending.length) void this.drain();
    }
  }
}
