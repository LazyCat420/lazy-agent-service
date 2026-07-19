/**
 * ToolCallGuard — deterministic protection against runaway tool calling.
 *
 * WHY: on 2026-07-14 a verification harness fired ~1,200 identical
 * `get_sec_filings` calls for one ticker in six minutes. Nothing stopped it:
 *
 *   - the result cache only fills AFTER a call succeeds, so 200 concurrent
 *     identical calls all missed it and all hit the bridge;
 *   - the bridge aborts at EXECUTION_TIMEOUT_MS but trading-service keeps
 *     executing the abandoned request, so retries stacked work on a server
 *     already saturated — a positive feedback loop;
 *   - nothing noticed that the same (tool, args) had already been asked for.
 *
 * Latency scales linearly with concurrency on that path (measured: 837ms at
 * n=1 → 10.2s at n=20), so a burst walks itself into the timeout and every
 * call fails. Three deterministic layers, cheapest first:
 *
 *   1. COALESCE  identical in-flight call → await the existing promise.
 *                Always safe, and alone it collapses a stampede to one call.
 *   2. LEDGER    identical (tool, args) repeats inside a rolling window get
 *                escalating friction: cached-with-a-note, then a refusal whose
 *                text tells the model what to do instead. The detection is
 *                code, not another model — microseconds, and it cannot
 *                hallucinate.
 *   3. SEMAPHORE per-tool concurrency cap. When full, wait briefly then
 *                FAIL FAST rather than queueing into timeout territory.
 *
 * Thresholds are windowed rather than absolute on purpose: tools like
 * whiteboard_read are legitimately re-read during a cycle to observe changed
 * state. Refusing on the 2nd-ever call would break that; refusing on the 6th
 * identical call within 60s still kills the storm (which did ~200 in 10s)
 * while leaving normal polling untouched.
 */

import crypto from "node:crypto";
import logger from "../utils/logger.ts";

const num = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

export const GUARD_CONFIG = {
  /** Rolling window over which identical calls are counted. */
  REPEAT_WINDOW_MS: num("TOOL_REPEAT_WINDOW_MS", 60_000),
  /** At this repeat count, prefer a cached result and annotate it. */
  REPEAT_SOFT_AT: num("TOOL_REPEAT_SOFT_AT", 3),
  /** At this repeat count, refuse and tell the model how to proceed. */
  REPEAT_REFUSE_AT: num("TOOL_REPEAT_REFUSE_AT", 6),
  /** Max concurrent executions of any single tool. */
  MAX_CONCURRENCY: num("TOOL_MAX_CONCURRENCY", 8),
  /** How long to wait for a semaphore slot before failing fast. */
  ACQUIRE_TIMEOUT_MS: num("TOOL_ACQUIRE_TIMEOUT_MS", 5_000),
};

export interface GuardScope {
  agentName?: string;
  cycleId?: string;
}

export const callKey = (toolName: string, args: unknown): string =>
  crypto
    .createHash("sha256")
    .update(toolName + JSON.stringify(args ?? {}))
    .digest("hex");

/** Ledger is per cycle/agent so one runaway agent cannot starve another. */
const scopeOf = (scope?: GuardScope): string =>
  scope?.cycleId || scope?.agentName || "global";

// ─────────────────────────────── 1. coalescing ───────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();

// ───────────────────────────────── 2. ledger ─────────────────────────────────

interface LedgerEntry {
  count: number;
  windowStart: number;
  lastSeen: number;
}
const ledger = new Map<string, LedgerEntry>();

function pruneLedger(now: number): void {
  // Cheap sweep; the map only holds one entry per distinct (scope, tool, args).
  for (const [key, entry] of ledger) {
    if (now - entry.lastSeen > GUARD_CONFIG.REPEAT_WINDOW_MS * 5) ledger.delete(key);
  }
}

export type RepeatVerdict = "allow" | "prefer_cache" | "refuse";

export interface RepeatDecision {
  verdict: RepeatVerdict;
  count: number;
}

/** Record an attempt and decide how much friction it earns. */
export function recordAttempt(
  toolName: string,
  key: string,
  scope?: GuardScope,
): RepeatDecision {
  const now = Date.now();
  const ledgerKey = `${scopeOf(scope)}::${toolName}::${key}`;
  let entry = ledger.get(ledgerKey);

  if (!entry || now - entry.windowStart > GUARD_CONFIG.REPEAT_WINDOW_MS) {
    entry = { count: 0, windowStart: now, lastSeen: now };
    ledger.set(ledgerKey, entry);
    if (ledger.size > 500) pruneLedger(now);
  }

  entry.count += 1;
  entry.lastSeen = now;

  if (entry.count >= GUARD_CONFIG.REPEAT_REFUSE_AT) {
    return { verdict: "refuse", count: entry.count };
  }
  if (entry.count >= GUARD_CONFIG.REPEAT_SOFT_AT) {
    return { verdict: "prefer_cache", count: entry.count };
  }
  return { verdict: "allow", count: entry.count };
}

/**
 * The refusal handed back to the model. It is deliberately instructive: a bare
 * "rate limited" teaches the agent nothing and it simply retries, which is the
 * behaviour that caused the incident.
 */
export function repeatRefusal(toolName: string, count: number): Record<string, unknown> {
  return {
    error:
      `Repeat-call guard: '${toolName}' has already been called ${count} times ` +
      `with identical arguments in the last ${Math.round(GUARD_CONFIG.REPEAT_WINDOW_MS / 1000)}s. ` +
      `The result will not change. Do NOT call it again with these arguments. ` +
      `Use the result you already received; if it was insufficient, either change ` +
      `the arguments (e.g. a different ticker or period) or choose a different tool. ` +
      `If the data you need genuinely does not exist, say so and move on.`,
    is_error: true,
    guard: "repeat_call",
    repeat_count: count,
  };
}

export function busyError(toolName: string): Record<string, unknown> {
  return {
    error:
      `Concurrency guard: '${toolName}' is at its concurrency limit ` +
      `(${GUARD_CONFIG.MAX_CONCURRENCY} in flight) and did not free up in time. ` +
      `This is a transient load condition — continue with the information you have, ` +
      `or retry this tool later in the analysis rather than immediately.`,
    is_error: true,
    guard: "concurrency",
  };
}

// ─────────────────────────────── 3. semaphore ────────────────────────────────

interface Slot {
  active: number;
  waiters: Array<{ resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>;
}
const slots = new Map<string, Slot>();

const slotFor = (toolName: string): Slot => {
  let slot = slots.get(toolName);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    slots.set(toolName, slot);
  }
  return slot;
};

/** Resolves true when a slot is held, false when it timed out waiting. */
export function acquire(toolName: string): Promise<boolean> {
  const slot = slotFor(toolName);
  if (slot.active < GUARD_CONFIG.MAX_CONCURRENCY) {
    slot.active += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        const idx = slot.waiters.indexOf(waiter);
        if (idx >= 0) slot.waiters.splice(idx, 1);
        // Fail fast instead of queueing into the bridge timeout — an abandoned
        // request still costs trading-service a full execution.
        resolve(false);
      }, GUARD_CONFIG.ACQUIRE_TIMEOUT_MS),
    };
    slot.waiters.push(waiter);
  });
}

export function release(toolName: string): void {
  const slot = slotFor(toolName);
  const next = slot.waiters.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(true); // hand the slot straight over, active count unchanged
    return;
  }
  slot.active = Math.max(0, slot.active - 1);
}

// ───────────────────────────── orchestration ─────────────────────────────────

export interface GuardedRunOptions<T> {
  toolName: string;
  key: string;
  scope?: GuardScope;
  /** Cached value, if the caller has one. */
  cached?: () => T | undefined;
  run: () => Promise<T>;
}

/**
 * Run `run()` under all three layers. Returns the shared promise for any
 * identical call already in flight.
 */
// NOT async: everything up to registering the in-flight promise must happen in
// one synchronous tick. With an `await` before `inFlight.set`, a burst of
// identical calls all observe an empty map and execute in parallel — the exact
// stampede this is meant to stop (measured: 5 escaped before the fix).
export function guardedRun<T>(opts: GuardedRunOptions<T>): Promise<T | Record<string, unknown>> {
  const { toolName, key, scope, cached, run } = opts;

  // 1. Coalesce — an identical call is already running; ride along with it.
  const existing = inFlight.get(key);
  if (existing) {
    logger.info(JSON.stringify({ event: "tool_coalesced", toolName }));
    return existing as Promise<T>;
  }

  // 2. Ledger — how many identical calls has this scope already made?
  //    Coalesced callers never reach here, which is correct: riding along with
  //    an in-flight call is one call, not a repeat.
  const decision = recordAttempt(toolName, key, scope);
  if (decision.verdict !== "allow") {
    const hit = cached?.();
    if (hit !== undefined) {
      logger.warn(
        JSON.stringify({ event: "tool_repeat_cached", toolName, count: decision.count }),
      );
      return Promise.resolve(hit);
    }
    if (decision.verdict === "refuse") {
      logger.warn(
        JSON.stringify({ event: "tool_repeat_refused", toolName, count: decision.count }),
      );
      return Promise.resolve(repeatRefusal(toolName, decision.count));
    }
    // prefer_cache with nothing cached → fall through and execute.
  }

  // 3. Semaphore — acquired inside the promise so that coalescing is already
  //    in effect; identical calls share one slot instead of each taking one.
  const promise = (async () => {
    const got = await acquire(toolName);
    if (!got) {
      logger.warn(JSON.stringify({ event: "tool_busy", toolName }));
      return busyError(toolName);
    }
    try {
      return await run();
    } finally {
      release(toolName);
    }
  })();

  inFlight.set(key, promise);
  // Clear on settle either way; a leaked entry would pin a stale result.
  void promise.then(
    () => inFlight.delete(key),
    () => inFlight.delete(key),
  );
  return promise;
}

/** Test/ops helper — drop all guard state. */
export function resetGuard(): void {
  inFlight.clear();
  ledger.clear();
  slots.clear();
}

/** Snapshot for the platform dashboard / storm alarm. */
export function guardStats(): Record<string, unknown> {
  const busiest = [...slots.entries()]
    .map(([tool, s]) => ({ tool, active: s.active, waiting: s.waiters.length }))
    .filter((s) => s.active > 0 || s.waiting > 0)
    .sort((a, b) => b.active + b.waiting - (a.active + a.waiting));
  return {
    in_flight: inFlight.size,
    ledger_entries: ledger.size,
    config: GUARD_CONFIG,
    busiest_tools: busiest.slice(0, 10),
  };
}
