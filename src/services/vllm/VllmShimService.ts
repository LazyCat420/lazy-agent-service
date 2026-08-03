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
 * We cannot edit prism (Rod's repo), but prism learns this endpoint's URL at
 * boot from vault-service/projects.json (PROVIDER_VLLM_2_URL) — ours. Pointing
 * that at this shim lets us mirror the Qwen key onto the DeepSeek key in
 * flight. Qwen ignores the unknown extra key, so a swap back is harmless.
 *
 * Everything else — /v1/models, /metrics, streaming SSE — forwards verbatim.
 */

const UPSTREAM_URL = process.env.VLLM_SHIM_GOLD_SPARK_URL || "http://10.0.0.141:8000";

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

  public static async handle(req: Request, res: Response) {
    const originalPath = req.originalUrl.replace(/^\/vllm-shim\/gold-spark/, "");
    const basePath = originalPath.split("?")[0];
    const targetUrl = `${UPSTREAM_URL}${originalPath}`;

    let body = req.body;
    if (basePath === "/v1/chat/completions" && req.method === "POST" && body && typeof body === "object") {
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
