/**
 * Real /health probes (LF-11). The endpoint used to answer a static
 * `{"status":"ok"}`, so the Docker healthcheck stayed green while Mongo or
 * every model box was dead. This module actually asks the two dependencies
 * the service cannot serve without:
 *
 *   - Mongo: a `{ping:1}` on the connection the service already holds;
 *   - each configured vLLM box: `GET <base>/v1/models` (the same URLs the
 *     providers use, so a box that cannot answer discovery cannot pass).
 *
 * Verdict rules (the deploy contract):
 *   - Mongo failing (including a 2 s timeout — the ping is raced against a
 *     timer, not just measured, because the driver's server-selection can
 *     hang ~30 s)  -> `down`, HTTP 503 (container goes unhealthy)
 *   - every enabled box failing  -> `down`,  HTTP 503
 *   - some enabled boxes failing -> `degraded`, HTTP 200 (wget still passes)
 *   - everything answering       -> `ok`,    HTTP 200
 *   - boxes disabled by default (jetson-2/vllm-3 unless ENABLE_JETSON_2=1)
 *     are reported `{ok: null, skipped: "disabled"}`, never probed, never
 *     counted; with zero enabled boxes the verdict follows Mongo alone.
 *
 * Results are cached for 10 s — and the in-flight probe is shared — so a
 * probe storm hits Mongo and the boxes once per TTL, not once per request.
 * Error text is sanitized (no `user:pass@` credentials) and length-capped.
 *
 * Dependency-injected (pingMongo / listBoxes / fetchImpl / now) so the
 * verdicts are testable without Mongo, boxes or sockets.
 */

export interface CheckResult {
  /** null for skipped boxes (registered but disabled, e.g. jetson-2). */
  ok: boolean | null;
  ms: number;
  error?: string;
  /** Set instead of `error` when the box was not probed at all. */
  skipped?: string;
}

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  status: HealthStatus;
  checks: Record<string, CheckResult>;
  /** Express status to answer with. `degraded` must stay 200 (healthcheck). */
  httpStatus: 200 | 503;
}

export interface BoxTarget {
  /** Stable key in the response, e.g. "vllm", "vllm-2". */
  name: string;
  /** Provider base URL; the probe GETs `<url>/v1/models`. */
  url: string;
  /**
   * False for registered-but-disabled boxes (jetson-2/vllm-3 unless
   * ENABLE_JETSON_2=1 — VllmShimService answers 404 by design). They are
   * reported as `{ok: null, skipped: "disabled"}`, never probed, and never
   * counted toward degraded/down. Undefined = enabled.
   */
  enabled?: boolean;
}

export interface HealthProbeDeps {
  /** Resolve only if the Mongo connection is truly usable. */
  pingMongo: () => Promise<unknown>;
  /** Current model boxes to probe. */
  listBoxes: () => BoxTarget[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface HealthProbe {
  check: () => Promise<HealthReport>;
  /** Drop the cached report (tests / forced re-probe). */
  reset: () => void;
}

export const HEALTH_PROBE_TIMEOUT_MS = 2_000;
export const HEALTH_PROBE_CACHE_TTL_MS = 10_000;

/** Response-safe error text: redact URL credentials, cap the length. */
export function publicErrorText(error: unknown): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.replace(/(\/\/)[^\s/@]*@[^\s/]*/g, "$1[redacted]@").slice(0, 200);
}

/**
 * Hard bound: reject with Error("timeout") if `task` has not settled within
 * timeoutMs, clearing the timer on both settle paths. The Mongo driver's own
 * server-selection can hang ~30 s (MongoManager builds the client with no
 * timeout options), so racing the promise — not just measuring it — is what
 * keeps /health inside its 2 s budget and under the 5 s healthcheck timeout.
 */
function withDeadline<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    task().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function probeBox(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const base = url.replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/v1/models`, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export function createHealthProbe(deps: HealthProbeDeps): HealthProbe {
  const timeoutMs = deps.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? HEALTH_PROBE_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;

  async function timed(task: () => Promise<unknown>): Promise<CheckResult> {
    const startedAt = now();
    try {
      await withDeadline(task, timeoutMs);
      return { ok: true, ms: now() - startedAt };
    } catch (error) {
      return { ok: false, ms: now() - startedAt, error: publicErrorText(error) };
    }
  }

  async function run(): Promise<HealthReport> {
    const boxes = deps.listBoxes();
    // Disabled boxes (registered but outside the shim's default pool) are
    // never probed and never counted — counting them would pin /health to
    // `degraded` forever, hiding genuine single-box outages.
    const enabled = boxes.filter((box) => box.enabled !== false);
    const [mongo, ...boxResults] = await Promise.all([
      timed(() => deps.pingMongo()),
      ...enabled.map((box) => timed(() => probeBox(fetchImpl, box.url, timeoutMs))),
    ]);

    const checks: Record<string, CheckResult> = { mongo };
    boxes.forEach((box) => {
      const index = enabled.findIndex((entry) => entry.name === box.name);
      checks[box.name] =
        index >= 0
          ? boxResults[index]
          : { ok: null, ms: 0, skipped: "disabled" };
    });

    const failedBoxes = boxResults.filter((result) => !result.ok).length;
    if (!mongo.ok) return { status: "down", checks, httpStatus: 503 };
    // Zero enabled boxes: the verdict follows Mongo alone.
    if (enabled.length > 0 && failedBoxes === enabled.length) {
      return { status: "down", checks, httpStatus: 503 };
    }
    if (failedBoxes > 0) return { status: "degraded", checks, httpStatus: 200 };
    return { status: "ok", checks, httpStatus: 200 };
  }

  let cached: { startedAt: number; report: Promise<HealthReport> } | null =
    null;

  function check(): Promise<HealthReport> {
    const nowMs = now();
    // Sharing the in-flight promise is what stops a probe storm: concurrent
    // requests await the same run instead of each launching their own.
    if (cached && nowMs - cached.startedAt < cacheTtlMs) return cached.report;
    const report = run();
    cached = { startedAt: nowMs, report };
    // A rejected run (only possible if listBoxes() itself throws) must not
    // stay cached — the next request should retry, not inherit the rejection.
    report.catch(() => {
      if (cached?.report === report) cached = null;
    });
    return report;
  }

  return {
    check,
    reset: () => {
      cached = null;
    },
  };
}
