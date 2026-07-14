import { Router, Request, Response, RequestHandler } from "express";
import fs from "node:fs";
import path from "node:path";
import CONFIG from "../../config.ts";
import logger from "../utils/logger.ts";
import { PrismProxyService } from "../services/prism/PrismProxyService.ts";
import { executePythonTool, routeLocalTool } from "../services/LocalToolRouter.ts";

const router = Router();

// Ensure data directory exists for Dead Letter Queue
const dataDir = path.resolve("data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

/** Python-bridge executor (moved to LocalToolRouter; re-exported for compat). */
export const executeTool = executePythonTool;

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

const handleExecuteRoute: RequestHandler = async (request, response) => {
  const { toolName } = request.params;
  let toolArguments = (request.body || {}) as Record<string, unknown>;
  if (toolArguments.arguments && typeof toolArguments.arguments === "object") {
    toolArguments = toolArguments.arguments as Record<string, unknown>;
  }
  const startTime = Date.now();

  const agentName = String(request.headers["x-agent"] || request.headers["x-username"] || "");
  const cycleId = String(request.headers["x-conversation-id"] || request.headers["x-request-id"] || "");
  const ticker = String(request.headers["x-ticker"] || toolArguments.ticker || toolArguments.Ticker || "");

  // Check if tool is authorized for this conversation session (Prism Proxy)
  if (cycleId && !PrismProxyService.isToolAllowed(cycleId as string, (toolName || "") as string)) {
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
    logger.info(JSON.stringify({ event: "tool_start", toolName, args: toolArguments }));

    const result = await routeLocalTool(
      toolName as string,
      toolArguments,
      { agentName, cycleId, ticker }
    );

    // Preserve pre-refactor telemetry semantics: gated widget failures were
    // returned before the success report fired.
    const gated =
      typeof result === "object" &&
      result !== null &&
      (result as { success?: boolean }).success === false &&
      ["PLANNING_REQUIRED", "VALIDATION_FAILED"].includes(
        String((result as { error?: string }).error)
      );
    if (gated) {
      response.json(result);
      return;
    }

    const durationMs = Date.now() - startTime;
    logger.info(JSON.stringify({ event: "tool_success", toolName, durationMs }));

    reportUsage({
      tool_name: toolName as string,
      agent_name: agentName,
      ticker,
      cycle_id: cycleId,
      success: true,
      execution_ms: durationMs,
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
