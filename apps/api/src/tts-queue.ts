type PendingJob<T> = {
  key: string;
  priority: "foreground" | "background";
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Serializes (or, with `concurrency` > 1, bounds) TTS generation and merges
 * duplicate cache misses for the same audio key.
 *
 * `reservedForegroundSlots` keeps that many slots off-limits to background
 * (pre-warm) jobs, so a reader who reaches a paragraph mid-playback never
 * queues behind a pool full of background warming work — at most
 * `concurrency - reservedForegroundSlots` background jobs run at once, no
 * matter how many are pending, leaving the rest free for foreground requests.
 * It has no effect when `concurrency` is 1 (there is nothing to reserve).
 */
export class TtsGenerationQueue {
  private readonly pending: PendingJob<unknown>[] = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private runningCount = 0;
  private runningBackgroundCount = 0;

  constructor(
    private readonly gapMs = 450,
    private readonly concurrency = 1,
    private readonly reservedForegroundSlots = concurrency > 1 ? 1 : 0,
  ) {}

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
    this.pump();
    return promise;
  }

  /** The next pending job this queue has capacity to start right now, if any. */
  private nextRunnableIndex(): number {
    const backgroundCapacity = Math.max(0, this.concurrency - this.reservedForegroundSlots);
    for (let index = 0; index < this.pending.length; index += 1) {
      const job = this.pending[index];
      if (job.priority === "background" && this.runningBackgroundCount >= backgroundCapacity) continue;
      return index;
    }
    return -1;
  }

  private pump() {
    while (this.runningCount < this.concurrency) {
      const index = this.nextRunnableIndex();
      if (index < 0) break;
      const [job] = this.pending.splice(index, 1);
      this.runningCount += 1;
      if (job.priority === "background") this.runningBackgroundCount += 1;
      void this.execute(job);
    }
  }

  private async execute(job: PendingJob<unknown>) {
    try {
      job.resolve(await job.work());
    } catch (error) {
      job.reject(error);
    } finally {
      this.inFlight.delete(job.key);
      this.runningCount -= 1;
      if (job.priority === "background") this.runningBackgroundCount -= 1;
      if (this.gapMs && this.pending.length) await new Promise((resolve) => setTimeout(resolve, this.gapMs));
      this.pump();
    }
  }
}
