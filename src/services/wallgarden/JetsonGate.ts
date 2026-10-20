/**
 * Wallgarden-only admission gate in front of the Jetson.
 *
 * Why (measured 2026-10-20): the Jetson vLLM runs `nemotron35` with only 2
 * running slots. Wallgarden fired ~135 calls in 20 min; vLLM queued 24 of them
 * and the queue wait alone was 60-77 s. Browser callers abort long before that
 * (classify at 12 s, /similar at 60 s, extract at 110 s via nginx), so most of
 * the GPU work finished for nobody and was re-requested later.
 *
 * The gate keeps at most `maxInFlight` (2 = the Jetson's running slots) wallgarden
 * completions on the box at once and orders the rest in-process:
 *   priority 0 — brainstorm, similar, extract-topics (what the user waits on)
 *   priority 1 — judge-topics
 *   priority 2 — taste-profile, recommend-channels, anything else
 * FIFO within a priority. A queued job of priority >= 1 that has waited longer
 * than `maxWaitMs` is rejected with {@link JetsonGateRejectedError} (routes map
 * it to HTTP 503) so browsers fail fast instead of piling up behind the box.
 * Priority-0 jobs never expire in the queue.
 *
 * In-process and per-container only; it does not see other services' Jetson
 * traffic. No dependencies.
 */

export type WallgardenPriority = 0 | 1 | 2;

export const WALLGARDEN_PRIORITY = {
  /** brainstorm, similar, extract-topics (and the rating pass they run). */
  USER_FACING: 0,
  /** judge-topics */
  JUDGE: 1,
  /** taste-profile, recommend-channels, anything else */
  BACKGROUND: 2,
} as const satisfies Record<string, WallgardenPriority>;

export class JetsonGateRejectedError extends Error {
  readonly statusCode = 503;
  readonly code = "WALLGARDEN_JETSON_BUSY";
  constructor(
    readonly priority: WallgardenPriority,
    readonly waitedMs: number,
  ) {
    super(
      `Jetson busy: wallgarden priority-${priority} request waited ${Math.round(waitedMs / 1000)}s ` +
        `in the gate queue and was rejected; retry later`,
    );
    this.name = "JetsonGateRejectedError";
  }
}

export interface JetsonGateStats {
  maxInFlight: number;
  maxWaitMs: number;
  inFlight: number;
  queued: { p0: number; p1: number; p2: number; total: number };
  rejected: number;
  completed: number;
}

interface QueuedJob {
  priority: WallgardenPriority;
  enqueuedAt: number;
  start: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface JetsonGateOptions {
  maxInFlight?: number;
  maxWaitMs?: number;
}

export class JetsonGate {
  readonly maxInFlight: number;
  readonly maxWaitMs: number;
  private inFlight = 0;
  private rejected = 0;
  private completed = 0;
  /** One FIFO per priority level; index = priority. */
  private readonly queues: [QueuedJob[], QueuedJob[], QueuedJob[]] = [[], [], []];

  constructor(opts: JetsonGateOptions = {}) {
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? 2);
    this.maxWaitMs = opts.maxWaitMs ?? 90_000;
  }

  /** Run `fn` once a slot is free. Rejects with JetsonGateRejectedError if a
   *  priority >= 1 job waits in the queue longer than maxWaitMs. */
  run<T>(priority: WallgardenPriority, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        this.inFlight++;
        let result: Promise<T>;
        try {
          result = fn();
        } catch (err) {
          result = Promise.reject(err);
        }
        result.then(resolve, reject).finally(() => {
          this.inFlight--;
          this.completed++;
          this.drain();
        });
      };

      if (this.inFlight < this.maxInFlight && this.queuedTotal() === 0) {
        execute();
        return;
      }

      const job: QueuedJob = { priority, enqueuedAt: Date.now(), start: execute };
      if (priority >= 1) {
        job.timer = setTimeout(() => {
          const q = this.queues[priority];
          const idx = q.indexOf(job);
          if (idx === -1) return; // already started
          q.splice(idx, 1);
          this.rejected++;
          reject(new JetsonGateRejectedError(priority, Date.now() - job.enqueuedAt));
        }, this.maxWaitMs);
      }
      this.queues[priority].push(job);
    });
  }

  stats(): JetsonGateStats {
    const [p0, p1, p2] = this.queues.map(q => q.length);
    return {
      maxInFlight: this.maxInFlight,
      maxWaitMs: this.maxWaitMs,
      inFlight: this.inFlight,
      queued: { p0, p1, p2, total: p0 + p1 + p2 },
      rejected: this.rejected,
      completed: this.completed,
    };
  }

  private queuedTotal(): number {
    return this.queues[0].length + this.queues[1].length + this.queues[2].length;
  }

  private drain(): void {
    while (this.inFlight < this.maxInFlight) {
      const q = this.queues.find(level => level.length > 0);
      if (!q) return;
      const job = q.shift()!;
      if (job.timer) clearTimeout(job.timer);
      job.start();
    }
  }
}

/** The single gate every WallgardenService LLM call goes through. */
export const wallgardenJetsonGate = new JetsonGate({ maxInFlight: 2, maxWaitMs: 90_000 });
