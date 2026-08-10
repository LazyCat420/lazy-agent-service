import { type Request, type Response } from "express";
import logger from "../../logger.js";

/**
 * OpenAI-compat translation shim between prism-service and a vLLM endpoint.
 *
 * WHY THIS EXISTS (2026-08-03): prism's vLLM provider disables reasoning with
 * chat_template_kwargs={enable_thinking:false} — the Qwen3 spelling. When Gold
 * Spark (10.0.0.141) was swapped to deepseek-v4-flash-0731, that key became a
 * silent no-op: DeepSeek's chat template reads "thinking", not "enable_thinking".
 * Result: every "thinking-off" call reasoned anyway (measured 1.3k-18k chars per
 * call), routinely burning the entire output budget and intermittently leaking
 * the reasoning trace into content (flash_briefings 126/127 shipped corrupted).
 *
 * We cannot edit prism (Rod's repo — and upstream fixes are a dead end, this
 * shim is PERMANENT infrastructure), but prism learns endpoint URLs at boot
 * from vault-service/projects.json (PROVIDER_VLLM_*_URL) — ours. Pointing
 * them at this shim lets us mirror the Qwen key onto the DeepSeek key in
 * flight. Qwen ignores the unknown extra key, so any model swap is harmless.
 *
 * Everything else — /v1/models, /metrics, streaming SSE — forwards verbatim.
 */

/**
 * Named upstreams — one route per vLLM box, ALL of them behind the shim so a
 * model swap on ANY endpoint can never silently strand the thinking flag
 * again (that is exactly how Gold Spark broke: the swap needed no deploy, so
 * nothing we owned was in the path). Keys are the /vllm-shim/<name> segment;
 * values match PROVIDER_VLLM_{1,2,3}_URL in vault-service/projects.json.
 */
const UPSTREAMS: Record<string, string> = {
  "gold-spark": process.env.VLLM_SHIM_GOLD_SPARK_URL || "http://10.0.0.141:8000",
  // The vision path. :8899 is NOT a second engine — it is a small Python proxy
  // (Server: BaseHTTP, where :8000 is uvicorn) sitting in front of the SAME
  // vLLM instance: both report identical kv_cache_size_tokens (1,136,441) and
  // num_gpu_blocks (12,727). It accepts image payloads, turns them into text,
  // and forwards; vllm:mm_cache_queries_total stayed 0.0 across ~20 images, so
  // vLLM itself never sees a picture.
  //
  // It is routed here so vision traffic passes through code we own — it is not
  // part of prism and nothing else was governing it.
  "gold-spark-vision": process.env.VLLM_SHIM_GOLD_SPARK_VISION_URL || "http://10.0.0.141:8899",
  "jetson": process.env.VLLM_SHIM_JETSON_URL || "http://10.0.0.30:8000",
  "jetson-2": process.env.VLLM_SHIM_JETSON_2_URL || "http://10.0.0.30:8001",
};

/**
 * Upstreams that contend for the SAME GPU share one budget.
 *
 * This is the correction the routing above forces: `gold-spark` and
 * `gold-spark-vision` are two doors onto one engine, so two independent caps of
 * 4 would admit 8 concurrent generations to a box that runs 6 — reintroducing
 * the pile-up this cap exists to stop, through the door nobody was watching.
 *
 * Upstreams absent from this map are their own group.
 */
const CAPACITY_GROUPS: Record<string, string> = {
  "gold-spark": "gold-spark",
  "gold-spark-vision": "gold-spark",
};

/**
 * Headers timeout only — cleared once the upstream responds, so long
 * generations and SSE streams are never cut off mid-flight. Non-stream vLLM
 * calls hold headers until generation completes, so this needs the same large
 * budget PrismProxyService learned to give /agent (multi-minute generations).
 */
const UPSTREAM_HEADERS_TIMEOUT_MS = 900_000;

/**
 * Per-upstream generation concurrency caps.
 *
 * WHY (2026-08-09): Gold Spark collapsed under a trading fan-out — generation
 * throughput fell 23x in 150 seconds (118.7 -> 5.1 tok/s) with the engine at
 * `Running: 6, Waiting: 9` and the KV cache at 85.9%. Reconstructed from
 * prism's ledger, the harness had **16 requests in flight against a box that
 * runs 6**, and vLLM's own log agrees (6 running + 9 waiting = 15).
 *
 * `--max-num-seqs 6` on the server is an ADMISSION ceiling, not a reservation:
 * if callers never present more than N, the engine never runs more than N. So
 * the cap can live here, with no vLLM restart — and here is the right place
 * because this shim carries prism's traffic AND trading-service's. Measured
 * against vLLM's own request counters, <=7.1% of prompt tokens reach Gold Spark
 * without passing through prism.
 *
 * Past the KV cache's real capacity, extra concurrency does not buy
 * parallelism — vLLM preempts and re-prefills, which is why prompt throughput
 * spiked to ~3,700 tok/s while generation fell to 4. Queueing here is strictly
 * cheaper than thrashing there: waiting costs time, preemption costs the work
 * already done.
 *
 * 0 or unset = unlimited. Override per upstream with
 * VLLM_SHIM_MAX_CONCURRENT_<NAME>, e.g. VLLM_SHIM_MAX_CONCURRENT_GOLD_SPARK.
 */
const DEFAULT_MAX_CONCURRENT: Record<string, number> = {
  "gold-spark": 4,
};

/**
 * How long a request may wait for a slot before being shed with 503.
 *
 * This bound is NOT optional. Prism's idle watchdog kills a stream that has
 * received no bytes for 300s — that is the `Provider stream stalled` class in
 * the failure census. With a cap of 4 and agent calls running 60-200s, a burst
 * of 16 would leave the last one queued ~800s, and the cap would manufacture
 * the exact failure it was added to prevent. A 503 is backpressure a caller can
 * see and retry; a 300s silent stall is not.
 */
const QUEUE_TIMEOUT_MS =
  Number(process.env.VLLM_SHIM_QUEUE_TIMEOUT_MS) > 0
    ? Number(process.env.VLLM_SHIM_QUEUE_TIMEOUT_MS)
    : 120_000;

/** Raised when a request waited past QUEUE_TIMEOUT_MS without getting a slot. */
export class QueueTimeoutError extends Error {}

/**
 * FIFO counting semaphore. Deliberately tiny and dependency-free — it sits on
 * the path every generation takes.
 *
 * Exported for unit tests.
 */
export class UpstreamSemaphore {
  private active = 0;
  private readonly waiters: {
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(public readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Resolve to a release function, or reject with QueueTimeoutError.
   *
   * The returned releaser is IDEMPOTENT: the caller releases from a `finally`
   * that can be reached twice on some error paths, and a double decrement
   * would silently raise the effective cap — a limiter that loosens itself
   * under load is worse than none.
   */
  async acquire(timeoutMs: number): Promise<() => void> {
    const releaser = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.release();
      };
    };

    if (this.active < this.limit) {
      this.active += 1;
      return releaser();
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry = {
        resolve: () => resolve(releaser()),
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(entry);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(
            new QueueTimeoutError(
              `waited ${timeoutMs}ms for a slot (limit ${this.limit}, ${this.waiters.length} still queued)`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(entry);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight over rather than decrementing and re-incrementing
      // — an intermediate 0 would let an unrelated arrival jump the queue.
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

export class VllmShimService {
  /**
   * Mirror Qwen's enable_thinking onto DeepSeek's thinking key.
   * Exported for unit tests. Mutates and returns the body.
   */
  public static translateChatTemplateKwargs(body: Record<string, unknown>): Record<string, unknown> {
    const ctk = body?.chat_template_kwargs;
    if (
      ctk &&
      typeof ctk === "object" &&
      !Array.isArray(ctk) &&
      "enable_thinking" in (ctk as Record<string, unknown>) &&
      !("thinking" in (ctk as Record<string, unknown>))
    ) {
      (ctk as Record<string, unknown>).thinking = (ctk as Record<string, unknown>).enable_thinking;
    }
    return body;
  }

  /** Rolling tallies for the thinking-flag arrival report. */
  private static thinkingSeen = { absent: 0, off: 0, on: 0, alreadyMirrored: 0 };
  private static thinkingReportedAt = 0;

  /**
   * Count whether a thinking instruction actually reached the shim, and say so
   * periodically. Diagnostic only — never alters the request.
   *
   * `absent` is the interesting bucket: it means the caller's thinking-off
   * intent was dropped somewhere ABOVE us, so the mirror never fires and the
   * model reasons by default.
   */
  public static recordThinkingFlag(body: Record<string, unknown>): void {
    const ctk = body?.chat_template_kwargs as Record<string, unknown> | undefined;
    if (!ctk || typeof ctk !== "object" || Array.isArray(ctk)) {
      this.thinkingSeen.absent += 1;
    } else if ("thinking" in ctk) {
      this.thinkingSeen.alreadyMirrored += 1;
    } else if (ctk.enable_thinking === false) {
      this.thinkingSeen.off += 1;
    } else if (ctk.enable_thinking === true) {
      this.thinkingSeen.on += 1;
    } else {
      this.thinkingSeen.absent += 1;
    }

    const now = Date.now();
    const total =
      this.thinkingSeen.absent + this.thinkingSeen.off +
      this.thinkingSeen.on + this.thinkingSeen.alreadyMirrored;
    if (total > 0 && now - this.thinkingReportedAt > 300_000) {
      this.thinkingReportedAt = now;
      const s = this.thinkingSeen;
      const level = s.absent > 0 ? "warn" : "info";
      logger[level](
        `[VllmShim] thinking flag arrivals (last window, ${total} chat calls): ` +
          `absent=${s.absent} off=${s.off} on=${s.on} already-mirrored=${s.alreadyMirrored}` +
          (s.absent > 0
            ? " — 'absent' means the caller's thinking-off intent was dropped upstream; the mirror cannot fire and the model reasons by default"
            : ""),
      );
      this.thinkingSeen = { absent: 0, off: 0, on: 0, alreadyMirrored: 0 };
    }
  }

  /**
   * Character budget for a single embedding input. The embedder behind
   * jetson-2 (embeddinggemma) has a 2,048-TOKEN window; prism's memory layer
   * (`memory:embed`, `workflow-query:embed`) sends whole agent prompts at it
   * and vLLM rejects the call outright — measured 931 failures in the 14 days
   * to 2026-08-09 (the single largest failure class), which means prism
   * memory was silently OFF for the trading project the whole time.
   *
   * 4,900 chars ≈ 1,200-1,600 tokens depending on content — inside the window
   * with margin. The value matches trading-service's _EMBED_CHAR_BUDGET
   * (4,944), derived for this same embedder. A truncated embedding degrades
   * recall for ONE memory; the rejected call it replaces stored nothing.
   *
   * Caveat, deliberate: the clamp applies to /v1/embeddings on EVERY
   * upstream, so pointing a >2k-window embedder through the shim would get
   * silently truncated inputs — override the budget via env when that day
   * comes. Clamping only when over budget keeps the common case untouched.
   */
  private static readonly EMBED_CHAR_BUDGET: number =
    Number(process.env.VLLM_SHIM_EMBED_CHAR_BUDGET) > 0
      ? Number(process.env.VLLM_SHIM_EMBED_CHAR_BUDGET)
      : 4_900;

  /** Rolling tally for the periodic clamp report. */
  private static embedClamped = { calls: 0, clamped: 0, worstChars: 0, rescued: 0 };
  private static embedReportedAt = 0;

  /**
   * Rolling tally for the periodic concurrency report. Without this, "the cap
   * is binding" is an inference from latency rather than an observation — and
   * a cap that silently sheds is indistinguishable from a healthy one.
   */
  private static queueStats = { admitted: 0, shed: 0, waitedMs: 0, worstWaitMs: 0, worstDepth: 0 };
  private static queueReportedAt = 0;

  /** Emit the concurrency picture on the same 5-minute cadence as the clamp report. */
  private static reportQueue(): void {
    const now = Date.now();
    const s = this.queueStats;
    if (s.admitted === 0 && s.shed === 0) return;
    if (now - this.queueReportedAt <= 300_000) return;
    this.queueReportedAt = now;
    const live = [...this.semaphores.entries()]
      .map(([name, sem]) => `${name} ${sem.inFlight}/${sem.limit}+${sem.queued}q`)
      .join(", ");
    logger.info(
      `[VllmShim] concurrency: ${s.admitted} admitted (mean wait ` +
        `${Math.round(s.waitedMs / Math.max(1, s.admitted))}ms, worst ${s.worstWaitMs}ms, ` +
        `deepest queue ${s.worstDepth}), ${s.shed} shed with 503. Live: ${live || "none"}.`,
    );
    this.queueStats = { admitted: 0, shed: 0, waitedMs: 0, worstWaitMs: 0, worstDepth: 0 };
  }

  /**
   * vLLM's context-window rejection, with the two numbers needed to rescale:
   * the model's window and the token count it measured. Live sample
   * (2026-08-09): "This model's maximum context length is 2048 tokens.
   * However, you requested 0 output tokens and your prompt contains at least
   * 2049 input tokens, ..."
   */
  private static readonly CTX_LEN_RE = /maximum context length is (\d+) tokens.*?(\d+) input tokens/s;

  /** Retry ceiling for the token-feedback rescale below. */
  private static readonly EMBED_RESCALE_ATTEMPTS = 3;

  /**
   * Pick the shrink factor for a context-window rejection. vLLM stops
   * counting at window+1 and reports "at least N" — so a measured count of
   * exactly window+1 tells us nothing about how far over the input really is
   * (live probe 2026-08-09: a 22k-char input and a 4.4k-char input both
   * reported "at least 2049"). An uninformative report gets an aggressive
   * 0.6 cut; a real measurement gets a proportional cut with 10% margin.
   * Exported for unit tests.
   */
  public static rescaleFactor(windowTokens: number, measuredTokens: number): number {
    if (measuredTokens <= windowTokens + 1) return 0.6;
    return (windowTokens / measuredTokens) * 0.9;
  }

  /**
   * Shrink every string input by `factor`, returning true if anything got
   * shorter. The char clamp above is a heuristic — chars-per-token varies
   * with content, and the desk's dense JSON/ticker text runs ~2.4 chars per
   * token, so a 4,900-char input can still overflow a 2,048-token window.
   * This is the exact-feedback correction applied when the embedder rejects
   * the clamped input anyway. Exported for unit tests.
   */
  public static shrinkEmbeddingInput(body: Record<string, unknown>, factor: number, floorChars = 0): boolean {
    let changed = false;
    const shrinkOne = (s: string): string => {
      if (s.length <= floorChars) return s;
      const target = Math.floor(s.length * factor);
      if (target <= 0 || target >= s.length) return s;
      changed = true;
      return s.slice(0, target);
    };
    if (typeof body.input === "string") {
      body.input = shrinkOne(body.input);
    } else if (Array.isArray(body.input)) {
      body.input = (body.input as unknown[]).map((item) => (typeof item === "string" ? shrinkOne(item) : item));
    }
    return changed;
  }

  /**
   * Truncate oversized embedding inputs to EMBED_CHAR_BUDGET. Mutates and
   * returns the body. Exported for unit tests.
   *
   * Handles both OpenAI input shapes: a single string, or an array of
   * strings. Token-id arrays (arrays of numbers) pass through untouched —
   * truncating those would corrupt them.
   */
  public static clampEmbeddingInput(body: Record<string, unknown>): Record<string, unknown> {
    const budget = this.EMBED_CHAR_BUDGET;
    const clampOne = (s: string): string => {
      this.embedClamped.calls += 1;
      if (s.length <= budget) return s;
      this.embedClamped.clamped += 1;
      this.embedClamped.worstChars = Math.max(this.embedClamped.worstChars, s.length);
      return s.slice(0, budget);
    };

    if (typeof body.input === "string") {
      body.input = clampOne(body.input);
    } else if (Array.isArray(body.input)) {
      body.input = (body.input as unknown[]).map((item) =>
        typeof item === "string" ? clampOne(item) : item,
      );
    }

    const now = Date.now();
    if ((this.embedClamped.clamped > 0 || this.embedClamped.rescued > 0) && now - this.embedReportedAt > 300_000) {
      this.embedReportedAt = now;
      const s = this.embedClamped;
      logger.warn(
        `[VllmShim] embed inputs clamped to ${budget} chars: ${s.clamped}/${s.calls} ` +
          `inputs over budget (worst ${s.worstChars} chars), ${s.rescued} rescued via ` +
          `token-feedback rescale — the sender is shipping oversized embedding payloads; ` +
          `before this clamp those calls failed outright ` +
          `("maximum context length is 2048 tokens").`,
      );
      this.embedClamped = { calls: 0, clamped: 0, worstChars: 0, rescued: 0 };
    }
    return body;
  }

  /**
   * Resolve /vllm-shim/<name>/<rest> to its upstream. Exported for unit
   * tests; returns null for unknown upstream names.
   */
  public static resolveUpstream(
    originalUrl: string,
  ): { upstreamUrl: string; originalPath: string; upstreamName: string } | null {
    const match = originalUrl.match(/^\/vllm-shim\/([a-z0-9-]+)(\/.*)?$/);
    const upstreamUrl = match ? UPSTREAMS[match[1]] : undefined;
    if (!upstreamUrl) return null;
    return { upstreamUrl, originalPath: match![2] || "/", upstreamName: match![1] };
  }

  /** Per-upstream semaphores, created on first use. Exported for tests. */
  private static readonly semaphores = new Map<string, UpstreamSemaphore>();

  /** The GPU an upstream contends for. Exported for tests. */
  public static capacityGroup(upstream: string): string {
    return CAPACITY_GROUPS[upstream] ?? upstream;
  }

  /**
   * Resolved concurrency limit for a capacity GROUP. 0 means ungated.
   * Read per call rather than cached so an env change plus restart takes
   * effect without a rebuild.
   */
  public static limitFor(upstream: string): number {
    const group = this.capacityGroup(upstream);
    const envKey = `VLLM_SHIM_MAX_CONCURRENT_${group.toUpperCase().replace(/-/g, "_")}`;
    const raw = Number(process.env[envKey]);
    if (Number.isFinite(raw) && raw > 0) return raw;
    if (process.env[envKey] !== undefined && raw === 0) return 0; // explicit opt-out
    return DEFAULT_MAX_CONCURRENT[group] ?? 0;
  }

  public static semaphoreFor(upstream: string): UpstreamSemaphore | null {
    const limit = this.limitFor(upstream);
    if (limit <= 0) return null;
    // Keyed on the GROUP, so every door onto one GPU draws from one budget.
    const group = this.capacityGroup(upstream);
    const existing = this.semaphores.get(group);
    if (existing && existing.limit === limit) return existing;
    const fresh = new UpstreamSemaphore(limit);
    this.semaphores.set(group, fresh);
    return fresh;
  }

  /** Test seam: drop all semaphores so a suite can change the env cleanly. */
  public static resetSemaphores(): void {
    this.semaphores.clear();
  }

  public static async handle(req: Request, res: Response) {
    const resolved = this.resolveUpstream(req.originalUrl);
    if (!resolved) {
      return res.status(404).json({
        error: `vllm-shim: unknown upstream in "${req.originalUrl}" (known: ${Object.keys(UPSTREAMS).join(", ")})`,
      });
    }
    const { upstreamUrl, originalPath, upstreamName } = resolved;
    const basePath = originalPath.split("?")[0];
    const targetUrl = `${upstreamUrl}${originalPath}`;

    let body = req.body;
    if (basePath === "/v1/chat/completions" && req.method === "POST" && body && typeof body === "object") {
      // The mirror can only translate a flag that ARRIVES. When a caller asks
      // for thinking-off and the request reaches us with no
      // chat_template_kwargs at all, there is nothing to mirror and DeepSeek's
      // template defaults to thinking ON — which is indistinguishable, from
      // here, from a caller that genuinely wanted thinking. Downstream that
      // shows up as reasoning eating the whole output allowance and no JSON
      // artifact (trading-service, 2026-08-05, 22-36% analyst artifact loss).
      //
      // So record what actually arrives. Sampled, because this path carries
      // every V3 agent call and a per-request line would bury the log.
      this.recordThinkingFlag(body as Record<string, unknown>);
      body = this.translateChatTemplateKwargs({ ...req.body });
    }

    const isEmbedPost = basePath === "/v1/embeddings" && req.method === "POST" && !!body && typeof body === "object";
    if (isEmbedPost) {
      body = this.clampEmbeddingInput({ ...req.body });
    }

    const upstreamAbortController = new AbortController();
    const fetchOnce = async (): Promise<globalThis.Response> => {
      const headersTimeout = setTimeout(() => {
        logger.error(`[VllmShim] Upstream headers timeout after ${UPSTREAM_HEADERS_TIMEOUT_MS}ms for ${originalPath}`);
        upstreamAbortController.abort();
      }, UPSTREAM_HEADERS_TIMEOUT_MS);
      try {
        return await fetch(targetUrl, {
          method: req.method,
          headers: { "Content-Type": req.headers["content-type"] || "application/json" },
          body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(body) : undefined,
          signal: upstreamAbortController.signal,
        });
      } finally {
        clearTimeout(headersTimeout);
      }
    };

    // ── Concurrency gate ────────────────────────────────────────────
    //
    // Only GENERATION is gated. /v1/models, /health and /metrics stay ungated
    // deliberately: trading-service polls /metrics every 5s to drive its own
    // limiter, and queueing that poll behind four generations would feed it
    // stale queue depths — which is precisely how the blind-limiter bug behaved
    // (it read waiting=0 while the box sat at 17).
    const isGated =
      req.method === "POST" &&
      (basePath === "/v1/chat/completions" || basePath === "/v1/embeddings");
    let release: (() => void) | null = null;
    if (isGated) {
      const sem = this.semaphoreFor(upstreamName);
      if (sem) {
        const waitStart = Date.now();
        try {
          release = await sem.acquire(QUEUE_TIMEOUT_MS);
        } catch (e: any) {
          this.queueStats.shed += 1;
          logger.warn(
            `[VllmShim] SHED ${originalPath} on ${upstreamName}: ${e.message}. ` +
              `The cap is holding but the queue is longer than it can drain — ` +
              `either the box is degraded or the caller's own limiter is too loose.`,
          );
          return res
            .status(503)
            .setHeader("Retry-After", "5")
            .json({
              error:
                `vllm-shim: no capacity on ${upstreamName} after ${QUEUE_TIMEOUT_MS}ms ` +
                `(limit ${sem.limit}). Retry.`,
            });
        }
        const waited = Date.now() - waitStart;
        this.queueStats.admitted += 1;
        this.queueStats.waitedMs += waited;
        this.queueStats.worstWaitMs = Math.max(this.queueStats.worstWaitMs, waited);
        this.queueStats.worstDepth = Math.max(this.queueStats.worstDepth, sem.queued);
        this.reportQueue();
      }
    }

    try {
      let response = await fetchOnce();

      // Token-feedback rescale: the char clamp undershoots on token-dense
      // text (the desk's JSON/ticker prose runs ~2.4 chars per token). When
      // the embedder measures the overflow for us, resize to fit and retry
      // instead of forwarding the rejection. Only strings that could
      // plausibly overflow (longer than the window in chars) are touched.
      if (isEmbedPost && response.status === 400) {
        for (let attempt = 1; attempt <= this.EMBED_RESCALE_ATTEMPTS && response.status === 400; attempt++) {
          const errText = await response.clone().text();
          const m = errText.match(this.CTX_LEN_RE);
          if (!m) break;
          const windowTokens = Number(m[1]);
          const measuredTokens = Number(m[2]);
          if (!(windowTokens > 0) || !(measuredTokens > windowTokens)) break;
          const factor = this.rescaleFactor(windowTokens, measuredTokens);
          if (!this.shrinkEmbeddingInput(body as Record<string, unknown>, factor, windowTokens)) break;
          this.embedClamped.rescued += 1;
          logger.warn(
            `[VllmShim] embed input still ${measuredTokens} tokens against a ${windowTokens}-token window ` +
              `after the char clamp — rescaled by ${factor.toFixed(2)} and retried (attempt ${attempt}).`,
          );
          response = await fetchOnce();
        }
      }

      res.status(response.status);
      const upstreamContentType = response.headers.get("content-type") || "";
      res.setHeader("Content-Type", upstreamContentType || "application/json");

      // SSE (stream:true chat completions) — pump raw bytes through, with
      // client-disconnect teardown so an abandoned stream doesn't pin the GPU.
      if (upstreamContentType.includes("text/event-stream")) {
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        if (response.body) {
          const reader = (response.body as any).getReader();
          let clientDisconnected = false;
          const handleClientDisconnect = () => {
            clientDisconnected = true;
            reader.cancel?.().catch(() => {});
          };
          res.on("close", handleClientDisconnect);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done || clientDisconnected) break;
              res.write(value);
            }
          } finally {
            res.off("close", handleClientDisconnect);
            reader.cancel?.().catch(() => {});
          }
        }
        return res.end();
      }

      // Non-stream: forward the raw body untouched (no JSON re-encode — keeps
      // /metrics text and any non-JSON upstream responses byte-identical).
      const buf = Buffer.from(await response.arrayBuffer());
      return res.end(buf);
    } catch (error: any) {
      logger.error(`[VllmShim] Failed to proxy ${originalPath}: ${error.message}`);
      if (!res.headersSent) {
        return res.status(502).json({ error: `vllm-shim upstream failure: ${error.message}` });
      }
      return res.end();
    } finally {
      // AFTER THE BODY DRAINS, never at `await fetchOnce()`.
      //
      // Measured 2026-08-09 through this shim: vLLM answers headers in ~20ms
      // and then holds the GPU for 5-10 SECONDS — 99.7% of a streaming request
      // happens after the fetch promise resolves. Releasing there would cap
      // header-fetch concurrency and leave GPU concurrency completely
      // ungoverned: a limiter that passes every test written against a
      // non-streaming call and does nothing under the load that caused the
      // incident. This `finally` covers both exits — the SSE pump's own
      // `finally` above, and the non-stream `res.end(buf)`.
      release?.();
    }
  }
}
