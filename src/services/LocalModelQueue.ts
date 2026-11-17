// ─── Per-Instance Counting Semaphore for Local GPU Models ───

import logger from "../utils/logger.ts";
import { getInstance, isInstance } from "../providers/instance-registry.ts";
import { LOCAL_PROVIDER_TYPES } from "./local-provider/constants.ts";

// Providers that hit the local GPU — sourced from LocalProviderGateway
const LOCAL_PROVIDERS = LOCAL_PROVIDER_TYPES;

/** Per-instance semaphore queues */
const queues = new Map<string, InstanceQueue>();

/** Default concurrency for instances not in the registry. */
const DEFAULT_CONCURRENCY = 1;

/**
 * Most requests that may WAIT for one instance (running ones are not counted).
 * The next one is rejected at once with {@link LocalModelQueueFullError}
 * instead of growing the queue. Override: LOCAL_MODEL_QUEUE_MAX_PENDING.
 */
export const DEFAULT_MAX_PENDING = 256;

/**
 * Longest one request may wait for a slot. After it the request leaves the
 * queue and is rejected with {@link LocalModelQueueTimeoutError}; it never
 * takes a slot later. Override: LOCAL_MODEL_QUEUE_TIMEOUT_MS.
 */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 600_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** The instance already has the maximum number of requests waiting. */
export class LocalModelQueueFullError extends Error {
  readonly code = "LOCAL_MODEL_QUEUE_FULL";
  constructor(
    readonly instanceId: string,
    readonly maxPending: number,
  ) {
    super(
      `Local model queue for "${instanceId}" is full (${maxPending} requests already waiting); request rejected`,
    );
    this.name = "LocalModelQueueFullError";
  }
}

/** The request waited the full timeout without getting a slot. */
export class LocalModelQueueTimeoutError extends Error {
  readonly code = "LOCAL_MODEL_QUEUE_TIMEOUT";
  constructor(
    readonly instanceId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Timed out after ${timeoutMs}ms waiting for a local model slot on "${instanceId}"`,
    );
    this.name = "LocalModelQueueTimeoutError";
  }
}

class InstanceQueue {
  instanceId: string;
  maxConcurrency: number;
  _queue: (() => void)[];
  _activeCount: number;
  _totalProcessed: number;

  constructor(instanceId: string, maxConcurrency: number) {
    this.instanceId = instanceId;
    this.maxConcurrency = maxConcurrency;
    this._queue = [];
    this._activeCount = 0;
    this._totalProcessed = 0;
  }

  acquire(timeoutMs?: number): Promise<() => void> {
    const { promise, resolve, reject } = Promise.withResolvers<() => void>();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this._activeCount--;
      this._totalProcessed++;
      const next = this._queue.shift();
      if (next) {
        this._activeCount++;
        next();
      }
    };

    if (this._activeCount < this.maxConcurrency) {
      this._activeCount++;
      resolve(release);
      return promise;
    }

    const maxPending = positiveIntFromEnv(
      "LOCAL_MODEL_QUEUE_MAX_PENDING",
      DEFAULT_MAX_PENDING,
    );
    if (this._queue.length >= maxPending) {
      logger.warn(
        `[LocalModelQueue:${this.instanceId}] Rejected request: queue full (${this._queue.length}/${maxPending} waiting, ${this._activeCount}/${this.maxConcurrency} active)`,
      );
      reject(new LocalModelQueueFullError(this.instanceId, maxPending));
      return promise;
    }

    const waitMs =
      timeoutMs ??
      positiveIntFromEnv(
        "LOCAL_MODEL_QUEUE_TIMEOUT_MS",
        DEFAULT_ACQUIRE_TIMEOUT_MS,
      );
    // A waiter that times out leaves the queue, so a later release can never
    // hand a slot to a request nobody is waiting on.
    const timer = setTimeout(() => {
      const index = this._queue.indexOf(grant);
      if (index !== -1) this._queue.splice(index, 1);
      logger.warn(
        `[LocalModelQueue:${this.instanceId}] Request timed out after ${waitMs}ms in the queue (${this._queue.length} still waiting, ${this._activeCount}/${this.maxConcurrency} active)`,
      );
      reject(new LocalModelQueueTimeoutError(this.instanceId, waitMs));
    }, waitMs);
    const grant = () => {
      clearTimeout(timer);
      resolve(release);
    };
    this._queue.push(grant);
    logger.info(
      `[LocalModelQueue:${this.instanceId}] Queued request (${this._queue.length} waiting, ${this._activeCount}/${this.maxConcurrency} active)`,
    );
    return promise;
  }

  get pending(): number {
    return this._queue.length;
  }
  get busy(): boolean {
    return this._activeCount >= this.maxConcurrency;
  }
  get activeCount(): number {
    return this._activeCount;
  }
  get totalProcessed(): number {
    return this._totalProcessed;
  }
  get totalInflight(): number {
    return this._activeCount + this._queue.length;
  }
}

class LocalModelQueue {
  constructor() {
    logger.info(
      `[LocalModelQueue] Initialized (default concurrency: ${DEFAULT_CONCURRENCY})`,
    );
  }

  /**
   * Check whether a provider requires the local GPU lock.
   * Checks both base provider types and instance IDs.
   */
  isLocal(provider: string): boolean {
    if (LOCAL_PROVIDERS.has(provider as any)) return true;
    // Check if it's a multi-instance ID (e.g. "lm-studio-2")
    if (isInstance(provider)) return true;
    return false;
  }
  _getQueue(instanceId: string): InstanceQueue {
    const existing = queues.get(instanceId);
    if (existing) return existing;

    // Look up concurrency from instance registry
    const instance = getInstance(instanceId);
    const concurrency = instance?.concurrency || DEFAULT_CONCURRENCY;

    const queue = new InstanceQueue(instanceId, concurrency);
    queues.set(instanceId, queue);
    logger.info(
      `[LocalModelQueue] Created queue for "${instanceId}" (concurrency: ${concurrency})`,
    );
    return queue;
  }

  /**
   * Acquire a semaphore slot for an instance. Resolves immediately if a
   * slot is available, otherwise enqueues and waits (FIFO order). Rejects with
   * LocalModelQueueFullError when DEFAULT_MAX_PENDING requests already wait,
   * and with LocalModelQueueTimeoutError after `timeoutMs`
   * (default DEFAULT_ACQUIRE_TIMEOUT_MS) without a slot.
   */
  acquire(
    instanceId: string = "_default",
    timeoutMs?: number,
  ): Promise<() => void> {
    return this._getQueue(instanceId).acquire(timeoutMs);
  }

  /** Number of requests waiting for a specific instance. */
  pending(instanceId: string = "_default"): number {
    return queues.get(instanceId)?.pending || 0;
  }

  /** Whether all slots are in use for a specific instance. */
  busy(instanceId: string = "_default"): boolean {
    return queues.get(instanceId)?.busy || false;
  }

  /** Number of active slots for a specific instance. */
  get activeCount(): number {
    let total = 0;
    for (const queue of queues.values()) total += queue.activeCount;
    return total;
  }

  /** Max concurrency for a specific instance (or default). */
  maxConcurrency(instanceId: string = "_default"): number {
    return queues.get(instanceId)?.maxConcurrency || DEFAULT_CONCURRENCY;
  }

  /** Total requests processed across all instances. */
  get totalProcessed(): number {
    let total = 0;
    for (const queue of queues.values()) total += queue.totalProcessed;
    return total;
  }
}

// Singleton — one queue manager for the entire process
const localModelQueue = new LocalModelQueue();
export default localModelQueue;
