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
  const url = `${tradingServiceUrl}/api/telemetry/tool-usage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
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

    let result: unknown;
    let tName = toolName as string;

    if (tName.startsWith("mcp__lazy-tool-service__")) {
      tName = tName.replace("mcp__lazy-tool-service__", "");
    }

    if (tName.startsWith("music_player_")) {
      const musicApiUrl = "http://10.0.0.16:8002";
      let musicApiResponse: globalThis.Response | null = null;
      if (tName === "music_player_suggest_artists") {
        result = { artists: toolArguments.artists || [] };
      } else if (tName === "music_player_add_node") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/artists/add-node`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: toolArguments.name, type: toolArguments.type })
        });
      } else if (tName === "music_player_remove_node") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/discovered/${encodeURIComponent(toolArguments.node_id as string)}`, { method: "DELETE" });
      } else if (tName === "music_player_add_edge") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/edge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: toolArguments.source, target: toolArguments.target, relationship: toolArguments.relationship || "related" })
        });
      } else if (tName === "music_player_remove_edge") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/edge?source=${encodeURIComponent(toolArguments.source as string)}&target=${encodeURIComponent(toolArguments.target as string)}`, { method: "DELETE" });
      } else if (tName === "music_player_override_node_type") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/override-type`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ node_id: toolArguments.node_id, group_type: toolArguments.group_type })
        });
      } else if (tName === "music_player_expand_artist") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/expand/${encodeURIComponent(toolArguments.artist as string)}?count=${toolArguments.count || 8}`);
      } else if (tName === "music_player_expand_genre") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/expand/genre/${encodeURIComponent(toolArguments.genre as string)}?count=${toolArguments.count || 8}`);
      } else if (tName === "music_player_get_graph_state") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/discovered`);
      } else if (tName === "music_player_search_artists") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/artists`);
      } else if (tName === "music_player_get_artist_info") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/artist/info/${encodeURIComponent(toolArguments.name as string)}`);
      } else if (tName === "music_player_list_genres") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/genres`);
      } else {
        result = { success: true };
      }

      if (musicApiResponse !== null) {
        if (musicApiResponse.ok) {
          result = await musicApiResponse.json();
        } else {
          result = { error: await musicApiResponse.text() };
        }
      }
    } else if (
      tName === "create_widget" ||
      tName === "update_widget" ||
      tName === "validate_widget_html" ||
      tName === "list_widget_types" ||
      tName === "plan_widget"
    ) {
      const { WidgetTemplateRegistry } = await import("../services/WidgetTemplateRegistry.ts");
      const { default: ToolContext } = await import("../services/ToolContext.ts");
      
      if (tName === "plan_widget") {
        if (cycleId) {
          ToolContext.set(cycleId, "widgetPlanApproved", true);
        }
        result = {
          success: true,
          message: "Widget plan registered and approved. You are now authorized to call create_widget."
        };
      } else if (tName === "validate_widget_html") {
        const htmlContent = (toolArguments.htmlContent || "") as string;
        const validation = WidgetTemplateRegistry.validateHTML(htmlContent);
        result = {
          valid: validation.valid,
          errors: validation.errors
        };
      } else if (tName === "list_widget_types") {
        result = {
          success: true,
          types: WidgetTemplateRegistry.list()
        };
      } else {
        if (tName === "create_widget") {
          const isApproved = cycleId ? ToolContext.get<boolean>(cycleId, "widgetPlanApproved") : false;
          if (!isApproved) {
            result = {
              success: false,
              error: "PLANNING_REQUIRED",
              message: "You must first call plan_widget with a structured design plan before calling create_widget."
            };
            response.json(result);
            return;
          }
        }
        
        const htmlContent = (toolArguments.htmlContent || "") as string;
        if (tName === "create_widget" || (tName === "update_widget" && htmlContent)) {
          const validation = WidgetTemplateRegistry.validateHTML(htmlContent);
          if (!validation.valid) {
            result = {
              success: false,
              error: "VALIDATION_FAILED",
              message: `Widget HTML validation failed: ${validation.errors.join("; ")}`
            };
            response.json(result);
            return;
          }
        }
        const htmlNotesUrl = CONFIG.HTML_NOTES_URL || "http://10.0.0.16:8035";
        try {
          const apiResponse = await fetch(`${htmlNotesUrl}/internal/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: tName, args: toolArguments })
          });
          if (apiResponse.ok) {
            result = await apiResponse.json();
          } else {
            result = { error: await apiResponse.text(), is_error: true };
          }
        } catch (fetchError: unknown) {
          result = {
            error: `Failed to connect to html-notes service at ${htmlNotesUrl}. Is the service down? Details: ${(fetchError as Error).message}`,
            is_error: true
          };
        }
      }
    } else if (
      tName.startsWith("html_notes_") ||
      tName === "render_component" ||
      tName.startsWith("canvas_")
    ) {
      if (tName === "canvas_modify_dom" && !toolArguments.canvas_html) {
         result = { success: true, message: "Handled natively by HTML-Notes client" };
      } else {
        const htmlNotesUrl = CONFIG.HTML_NOTES_URL || "http://10.0.0.16:8035";
        try {
          const apiResponse = await fetch(`${htmlNotesUrl}/internal/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: tName, args: toolArguments })
          });
          if (apiResponse.ok) {
            result = await apiResponse.json();
          } else {
            result = { error: await apiResponse.text(), is_error: true };
          }
        } catch (fetchError: unknown) {
          result = {
            error: `Failed to connect to html-notes service at ${htmlNotesUrl}. Is the service down? Details: ${(fetchError as Error).message}`,
            is_error: true
          };
        }
      }
    } else {
      result = await executeTool(tName, toolArguments, { agentName, cycleId, ticker });
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
