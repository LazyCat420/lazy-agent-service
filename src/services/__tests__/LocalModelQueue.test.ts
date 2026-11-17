// C24b: the per-instance local-model queue was unbounded and acquire() never
// timed out, so a stuck slot holder made every later request wait forever.
// The queue now rejects past a documented maximum and each waiter times out.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import localModelQueue, {
  DEFAULT_ACQUIRE_TIMEOUT_MS,
  DEFAULT_MAX_PENDING,
  LocalModelQueueFullError,
  LocalModelQueueTimeoutError,
} from "../LocalModelQueue.ts";

const registry = vi.hoisted(() => ({ concurrency: new Map<string, number>() }));

vi.mock("../../providers/instance-registry.ts", () => ({
  getInstance: (id: string) =>
    registry.concurrency.has(id)
      ? { id, concurrency: registry.concurrency.get(id) }
      : undefined,
  isInstance: (id: string) => registry.concurrency.has(id),
}));

vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The queue map is process-wide, so every test uses its own instance id.
let instanceCounter = 0;
function freshInstance(concurrency = 1): string {
  const id = `test-box-${++instanceCounter}`;
  registry.concurrency.set(id, concurrency);
  return id;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("LocalModelQueue bounds", () => {
  it("documents a finite default maximum and timeout", () => {
    expect(DEFAULT_MAX_PENDING).toBe(256);
    expect(DEFAULT_ACQUIRE_TIMEOUT_MS).toBe(600_000);
  });

  it("still grants slots in FIFO order as holders release", async () => {
    const id = freshInstance(1);
    const order: string[] = [];
    const releaseFirst = await localModelQueue.acquire(id);
    const second = localModelQueue.acquire(id).then((release) => {
      order.push("second");
      return release;
    });
    const third = localModelQueue.acquire(id).then((release) => {
      order.push("third");
      return release;
    });
    expect(localModelQueue.pending(id)).toBe(2);

    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(["second", "third"]);
    releaseThird();

    expect(localModelQueue.pending(id)).toBe(0);
    expect(localModelQueue._getQueue(id).activeCount).toBe(0);
  });

  it("rejects at once when the maximum number of requests already wait", async () => {
    vi.stubEnv("LOCAL_MODEL_QUEUE_MAX_PENDING", "2");
    const id = freshInstance(1);
    const releaseHolder = await localModelQueue.acquire(id);
    const waiting = [localModelQueue.acquire(id), localModelQueue.acquire(id)];

    const overflow = localModelQueue.acquire(id);
    await expect(overflow).rejects.toBeInstanceOf(LocalModelQueueFullError);
    await expect(overflow).rejects.toMatchObject({
      code: "LOCAL_MODEL_QUEUE_FULL",
      instanceId: id,
      maxPending: 2,
    });
    expect(localModelQueue.pending(id)).toBe(2);

    // The rejected request took nothing: both waiters still get their turn.
    releaseHolder();
    (await waiting[0])();
    (await waiting[1])();
    expect(localModelQueue._getQueue(id).activeCount).toBe(0);
  });

  it("rejects a waiter after the timeout and removes it from the queue", async () => {
    const id = freshInstance(1);
    const releaseHolder = await localModelQueue.acquire(id);

    const timedOut = localModelQueue.acquire(id, 1_000);
    const rejection = expect(timedOut).rejects.toMatchObject({
      name: "LocalModelQueueTimeoutError",
      code: "LOCAL_MODEL_QUEUE_TIMEOUT",
      instanceId: id,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(localModelQueue.pending(id)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    await expect(timedOut).rejects.toBeInstanceOf(LocalModelQueueTimeoutError);
    expect(localModelQueue.pending(id)).toBe(0);

    // The slot the holder frees must not go to the request that gave up.
    releaseHolder();
    expect(localModelQueue._getQueue(id).activeCount).toBe(0);
    const releaseNext = await localModelQueue.acquire(id);
    expect(localModelQueue._getQueue(id).activeCount).toBe(1);
    releaseNext();
  });

  it("uses the env timeout when the caller passes none", async () => {
    vi.stubEnv("LOCAL_MODEL_QUEUE_TIMEOUT_MS", "250");
    const id = freshInstance(1);
    const releaseHolder = await localModelQueue.acquire(id);

    const rejection = expect(localModelQueue.acquire(id)).rejects.toMatchObject({
      code: "LOCAL_MODEL_QUEUE_TIMEOUT",
      timeoutMs: 250,
    });
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    releaseHolder();
  });

  it("a granted waiter is not rejected when its timeout would have fired", async () => {
    const id = freshInstance(1);
    const releaseHolder = await localModelQueue.acquire(id);
    const waiter = localModelQueue.acquire(id, 1_000);

    releaseHolder();
    const release = await waiter;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(localModelQueue._getQueue(id).activeCount).toBe(1);
    release();
    expect(localModelQueue._getQueue(id).activeCount).toBe(0);
  });
});
