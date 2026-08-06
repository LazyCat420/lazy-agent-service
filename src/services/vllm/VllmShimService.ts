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

    const upstreamAbortController = new AbortController();
    const headersTimeout = setTimeout(() => {
      logger.error(`[VllmShim] Upstream headers timeout after ${UPSTREAM_HEADERS_TIMEOUT_MS}ms for ${originalPath}`);
      upstreamAbortController.abort();
    }, UPSTREAM_HEADERS_TIMEOUT_MS);

    try {
      let response: globalThis.Response;
      try {
        response = await fetch(targetUrl, {
          method: req.method,
          headers: { "Content-Type": req.headers["content-type"] || "application/json" },
          body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(body) : undefined,
          signal: upstreamAbortController.signal,
        });
      } finally {
        clearTimeout(headersTimeout);
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
