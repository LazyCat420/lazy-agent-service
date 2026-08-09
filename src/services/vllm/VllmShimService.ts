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
  "jetson": process.env.VLLM_SHIM_JETSON_URL || "http://10.0.0.30:8000",
  "jetson-2": process.env.VLLM_SHIM_JETSON_2_URL || "http://10.0.0.30:8001",
};

/**
 * Headers timeout only — cleared once the upstream responds, so long
 * generations and SSE streams are never cut off mid-flight. Non-stream vLLM
 * calls hold headers until generation completes, so this needs the same large
 * budget PrismProxyService learned to give /agent (multi-minute generations).
 */
const UPSTREAM_HEADERS_TIMEOUT_MS = 900_000;

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
  public static resolveUpstream(originalUrl: string): { upstreamUrl: string; originalPath: string } | null {
    const match = originalUrl.match(/^\/vllm-shim\/([a-z0-9-]+)(\/.*)?$/);
    const upstreamUrl = match ? UPSTREAMS[match[1]] : undefined;
    if (!upstreamUrl) return null;
    return { upstreamUrl, originalPath: match![2] || "/" };
  }

  public static async handle(req: Request, res: Response) {
    const resolved = this.resolveUpstream(req.originalUrl);
    if (!resolved) {
      return res.status(404).json({
        error: `vllm-shim: unknown upstream in "${req.originalUrl}" (known: ${Object.keys(UPSTREAMS).join(", ")})`,
      });
    }
    const { upstreamUrl, originalPath } = resolved;
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
          const factor = (windowTokens / measuredTokens) * 0.9;
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
    }
  }
}
