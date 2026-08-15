type PendingJob<T> = {
  key: string;
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

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    this.inFlight.set(key, promise);
    this.pending.push({ key, work: work as () => Promise<unknown>, resolve: resolve as (value: unknown) => void, reject });
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
