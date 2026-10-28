import { TOOL_CONTEXT_ARG, verifyToolContext } from "../services/TradingToolContext.ts";
import { classifyToolResult } from "../services/ToolResult.ts";
import { Router, RequestHandler } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import CONFIG from "../../config.ts";
import logger from "../utils/logger.ts";
import { PrismProxyService } from "../services/prism/PrismProxyService.ts";
import { dispatchTool } from "../services/ToolDispatch.ts";

const router = Router();

// Ensure data directory exists for Dead Letter Queue
const dataDir = path.resolve("data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * Fire-and-forget telemetry reporting back to trading-service.
 */
async function reportUsage(payload: Record<string, unknown>) {
  const tradingServiceUrl = CONFIG.TRADING_SERVICE_URL || "http://localhost:3031";
  const apiKey = CONFIG.TRADING_SERVICE_API_KEY || "change-me-local-dev";
  // trading-service's usage endpoint lives under /api/v1/agent-tools and
  // authenticates with a Bearer token (the old /api/telemetry/tool-usage
  // path never existed — reports were 404ing silently).
  const url = `${tradingServiceUrl}/api/v1/agent-tools/usage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      logger.warn(`[UsageReporting] Failed to report tool usage, status=${response.status}`);
    }
  } catch (error: unknown) {
    logger.error(`[UsageReporting] Network error reporting tool usage: ${(error as Error).message}`);
  }
}

/**
 * Classify a tool result for telemetry truthfulness. routeLocalTool resolves
 * (rather than throws) for many tool-level failures — results whose content
 * carries a top-level `error` / `is_error` key or `{"status":"error"}` are
 * failures and must not be reported as success:true.
 *
 * Only affects the telemetry classification — never the response payload.
 */
export { classifyToolResult } from "../services/ToolResult.ts";

interface ResolvedExecuteContext {
  toolName: string;
  toolArguments: Record<string, unknown>;
  agentName: string;
  cycleId: string;
  ticker: string;
  hasCapability: boolean;
}

function resolveExecuteRequestContext(
  request: Parameters<RequestHandler>[0],
): ResolvedExecuteContext {
  const toolName = String(request.params.toolName || "");
  let toolArguments = (request.body || {}) as Record<string, unknown>;
  if (toolArguments.arguments && typeof toolArguments.arguments === "object") {
    toolArguments = toolArguments.arguments as Record<string, unknown>;
  }
  let agentName = String(
    request.headers["x-agent"] || request.headers["x-username"] || "",
  );
  let cycleId = String(
    request.headers["x-conversation-id"] || request.headers["x-request-id"] || "",
  );
  let ticker = String(
    request.headers["x-ticker"] ||
      toolArguments.ticker ||
      toolArguments.Ticker ||
      "",
  );

  const hasCapability = Object.hasOwn(toolArguments, TOOL_CONTEXT_ARG);
  if (hasCapability) {
    try {
      const verified = verifyToolContext(toolArguments[TOOL_CONTEXT_ARG]);
      agentName = verified.agentName;
      cycleId = verified.cycleId;
      ticker = verified.ticker;
    } catch {
      /* common dispatch returns the refusal */
    }
  }

  return {
    toolName,
    toolArguments,
    agentName,
    cycleId,
    ticker,
    hasCapability,
  };
}

function isGatedWidgetRefusal(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as { success?: boolean; error?: string };
  if (record.success !== false) return null;
  const gatedError = String(record.error ?? "");
  return ["PLANNING_REQUIRED", "VALIDATION_FAILED"].includes(gatedError)
    ? gatedError
    : null;
}

function reportExecuteUsageFireAndForget(
  ctx: ResolvedExecuteContext,
  durationMs: number,
  success: boolean,
  errorMessage?: string,
): void {
  reportUsage({
    tool_name: ctx.toolName,
    agent_name: ctx.agentName,
    ticker: ctx.ticker,
    cycle_id: ctx.cycleId,
    success,
    execution_ms: durationMs,
    ...(errorMessage !== undefined ? { error_message: errorMessage } : {}),
    service_source: "lazy-agent-service",
  }).catch(() => {});
}

const handleExecuteRoute: RequestHandler = async (request, response) => {
  const startTime = Date.now();
  const ctx = resolveExecuteRequestContext(request);
  const { toolName, toolArguments, agentName, cycleId, ticker, hasCapability } =
    ctx;

  if (
    !hasCapability &&
    cycleId &&
    !PrismProxyService.isToolAllowed(cycleId, toolName)
  ) {
    const errorMsg = `The tool "${toolName}" is not whitelisted for your agent role. You must reason using the data in the 'Pre-Collected Data Report' instead of calling unauthorized tools.`;
    logger.warn(
      `[PrismProxy] Intercepted unauthorized tool call for conversation ${cycleId}: ${toolName}`,
    );

    reportExecuteUsageFireAndForget(
      ctx,
      Date.now() - startTime,
      false,
      errorMsg,
    );

    response.json({
      success: false,
      error: "PERMISSION_DENIED",
      message: errorMsg,
    });
    return;
  }

  try {
    logger.info(
      JSON.stringify({
        event: "tool_start",
        toolName,
        args: Object.fromEntries(
          Object.entries(toolArguments).filter(
            ([key]) => key !== TOOL_CONTEXT_ARG,
          ),
        ),
      }),
    );

    const result = await dispatchTool(toolName, toolArguments, {
      agentName,
      cycleId,
      ticker,
      project: String(request.headers["x-project"] || ""),
      transport: "rest",
    });

    const gatedError = isGatedWidgetRefusal(result);
    if (gatedError) {
      const durationMs = Date.now() - startTime;
      logger.info(
        JSON.stringify({
          event: "tool_gated",
          toolName,
          gate: gatedError,
          durationMs,
        }),
      );
      reportExecuteUsageFireAndForget(
        ctx,
        durationMs,
        false,
        gatedError.toLowerCase(),
      );
      response.json(result);
      return;
    }

    const durationMs = Date.now() - startTime;
    const classification = classifyToolResult(result);

    if (classification.success) {
      logger.info(
        JSON.stringify({ event: "tool_success", toolName, durationMs }),
      );
    } else {
      logger.warn(
        JSON.stringify({
          event: "tool_soft_failure",
          toolName,
          error: classification.errorMessage,
          durationMs,
        }),
      );
    }

    reportExecuteUsageFireAndForget(
      ctx,
      durationMs,
      classification.success,
      classification.success ? undefined : classification.errorMessage,
    );

    response.json(result);
  } catch (error: unknown) {
    const errorMsg = (error as Error).message;
    const durationMs = Date.now() - startTime;
    logger.error(
      JSON.stringify({
        event: "tool_failure",
        toolName,
        error: errorMsg,
        durationMs,
      }),
    );

    reportExecuteUsageFireAndForget(ctx, durationMs, false, errorMsg);

    try {
      const deadLetterQueueEntry =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          toolName,
          args: toolArguments,
          error: errorMsg,
          durationMs,
        }) + "\n";
      fs.promises
        .appendFile(path.join(dataDir, "dlq.jsonl"), deadLetterQueueEntry)
        .catch(() => {});
    } catch {
      // Ignore DLQ append errors silently
    }

    response.status(500).json({ error: errorMsg, code: 500 });
  }
};

/**
 * Optional shared key for POST /execute/*. Unset (default) keeps the route
 * LAN-open as before; set EXECUTE_API_KEY and every caller must send it as
 * `x-api-key` or `Authorization: Bearer`. A signed trading tool context is
 * accepted in place of the key (it is already authenticated).
 */
export const requireExecuteKey: RequestHandler = (request, response, next) => {
  const expected = (process.env.EXECUTE_API_KEY || "").trim();
  if (!expected) return next();
  const body = (request.body || {}) as Record<string, unknown>;
  const args = (body.arguments && typeof body.arguments === "object" ? body.arguments : body) as Record<string, unknown>;
  if (Object.hasOwn(args, TOOL_CONTEXT_ARG)) return next();
  const header = String(request.headers["x-api-key"] || "").trim() ||
    String(request.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  response.status(401).json({ success: false, error: "UNAUTHORIZED", message: "POST /execute requires EXECUTE_API_KEY" });
};

router.post("/:toolName", requireExecuteKey, handleExecuteRoute);

export default router;
