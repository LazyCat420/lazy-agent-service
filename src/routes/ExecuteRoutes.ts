import { TOOL_CONTEXT_ARG, verifyToolContext } from "../services/TradingToolContext.ts";
import { classifyToolResult } from "../services/ToolResult.ts";
import { Router, Request, Response, RequestHandler } from "express";
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

const handleExecuteRoute: RequestHandler = async (request, response) => {
  const { toolName } = request.params;
  let toolArguments = (request.body || {}) as Record<string, unknown>;
  if (toolArguments.arguments && typeof toolArguments.arguments === "object") {
    toolArguments = toolArguments.arguments as Record<string, unknown>;
  }
  const startTime = Date.now();

  let agentName = String(request.headers["x-agent"] || request.headers["x-username"] || "");
  let cycleId = String(request.headers["x-conversation-id"] || request.headers["x-request-id"] || "");
  let ticker = String(request.headers["x-ticker"] || toolArguments.ticker || toolArguments.Ticker || "");

  // Signed identity is authoritative for attribution. Invalid capabilities are
  // rejected by dispatchTool; never record their unverified claims as identity.
  const hasCapability = Object.hasOwn(toolArguments, TOOL_CONTEXT_ARG);
  if (hasCapability) {
    try {
      const verified = verifyToolContext(toolArguments[TOOL_CONTEXT_ARG]);
      agentName = verified.agentName; cycleId = verified.cycleId; ticker = verified.ticker;
    } catch { /* common dispatch returns the refusal */ }
  }

  // Check if tool is authorized for this conversation session (Prism Proxy)
  if (!hasCapability && cycleId && !PrismProxyService.isToolAllowed(cycleId as string, (toolName || "") as string)) {
    const errorMsg = `The tool "${toolName}" is not whitelisted for your agent role. You must reason using the data in the 'Pre-Collected Data Report' instead of calling unauthorized tools.`;
    logger.warn(`[PrismProxy] Intercepted unauthorized tool call for conversation ${cycleId}: ${toolName}`);

    const durationMs = Date.now() - startTime;
    reportUsage({
      tool_name: toolName as string,
      agent_name: agentName,
      ticker,
      cycle_id: cycleId,
      success: false,
      execution_ms: durationMs,
      error_message: errorMsg,
      service_source: "lazy-tool-service"
    }).catch(() => {});

    response.json({
      success: false,
      error: "PERMISSION_DENIED",
      message: errorMsg
    });
    return;
  }

  try {
    logger.info(JSON.stringify({ event: "tool_start", toolName, args: Object.fromEntries(Object.entries(toolArguments).filter(([key]) => key !== TOOL_CONTEXT_ARG)) }));

    const result = await dispatchTool(
      toolName as string,
      toolArguments,
      { agentName, cycleId, ticker, project: String(request.headers["x-project"] || ""), transport: "rest" }
    );

    // Gated widget refusals (planning/validation) are still refusals — report
    // them as failed telemetry rows so they stop being invisible, then return
    // the same response the caller always received.
    const gatedError = String(
      (result as { error?: string } | null | undefined)?.error ?? ""
    );
    const gated =
      typeof result === "object" &&
      result !== null &&
      (result as { success?: boolean }).success === false &&
      ["PLANNING_REQUIRED", "VALIDATION_FAILED"].includes(gatedError);
    if (gated) {
      const durationMs = Date.now() - startTime;
      logger.info(
        JSON.stringify({ event: "tool_gated", toolName, gate: gatedError, durationMs })
      );
      reportUsage({
        tool_name: toolName as string,
        agent_name: agentName,
        ticker,
        cycle_id: cycleId,
        success: false,
        execution_ms: durationMs,
        error_message: gatedError.toLowerCase(),
        service_source: "lazy-tool-service"
      }).catch(() => {});
      response.json(result);
      return;
    }

    const durationMs = Date.now() - startTime;

    // Classify the result before reporting — many tools resolve (rather than
    // throw) with an error payload, which used to be reported as success:true.
    const classification = classifyToolResult(result);

    if (classification.success) {
      logger.info(JSON.stringify({ event: "tool_success", toolName, durationMs }));
    } else {
      logger.warn(
        JSON.stringify({
          event: "tool_soft_failure",
          toolName,
          error: classification.errorMessage,
          durationMs
        })
      );
    }

    reportUsage({
      tool_name: toolName as string,
      agent_name: agentName,
      ticker,
      cycle_id: cycleId,
      success: classification.success,
      execution_ms: durationMs,
      ...(classification.success
        ? {}
        : { error_message: classification.errorMessage }),
      service_source: "lazy-tool-service"
    }).catch(() => {});

    response.json(result);
  } catch (error: unknown) {
    const errorMsg = (error as Error).message;
    const durationMs = Date.now() - startTime;
    logger.error(JSON.stringify({ event: "tool_failure", toolName, error: errorMsg, durationMs }));

    reportUsage({
      tool_name: toolName as string,
      agent_name: agentName,
      ticker,
      cycle_id: cycleId,
      success: false,
      execution_ms: durationMs,
      error_message: errorMsg,
      service_source: "lazy-tool-service"
    }).catch(() => {});

    try {
      const deadLetterQueueEntry = JSON.stringify({ timestamp: new Date().toISOString(), toolName, args: toolArguments, error: errorMsg, durationMs }) + "\n";
      fs.promises.appendFile(path.join(dataDir, "dlq.jsonl"), deadLetterQueueEntry).catch(() => {});
    } catch (fsErr) {
      // Ignore DLQ append errors silently
    }

    response.status(500).json({ error: errorMsg, code: 500 });
  }
};

router.post("/:toolName", handleExecuteRoute);

export default router;
