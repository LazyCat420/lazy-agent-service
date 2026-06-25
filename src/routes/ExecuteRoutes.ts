import { Router, Request, Response, RequestHandler } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import CONFIG from "../config.js";
import logger from "../logger.js";

const router = Router();

// Cache structure
interface CacheEntry {
  result: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

// Ensure data directory exists for DLQ
const dataDir = path.resolve("data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const executeTool = async (toolName: string, toolArguments: Record<string, unknown>): Promise<unknown> => {
  const argumentsJson = JSON.stringify(toolArguments);
  const cacheKey = crypto.createHash("sha256").update(toolName + argumentsJson).digest("hex");

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info(JSON.stringify({ event: "cache_hit", toolName, args: toolArguments }));
    return cached.result;
  }

  return new Promise((resolve, reject) => {
    // Set up environment
    const env = {
      ...process.env,
      PYTHONPATH: CONFIG.PYTHONPATH,
      SKIP_TOOL_USAGE_LOG: "true",
      USE_LAZY_TOOL_SERVICE: "false"
    };

    const child = spawn(
      CONFIG.PYTHON_INTERPRETER,
      [CONFIG.PYTHON_EXEC_SCRIPT, toolName, argumentsJson],
      {
        cwd: CONFIG.PYTHON_CWD,
        env
      }
    );

    let stdout = "";
    let stderr = "";
    let isTimeout = false;

    const timeoutId = setTimeout(() => {
      isTimeout = true;
      child.kill("SIGKILL");
      reject(new Error(`Execution timed out after ${CONFIG.EXECUTION_TIMEOUT_MS}ms`));
    }, CONFIG.EXECUTION_TIMEOUT_MS);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (isTimeout) return; // already rejected

      if (code !== 0) {
        reject(new Error(`Tool execution failed (exit code ${code}): ${stderr || stdout}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        // Save to cache
        cache.set(cacheKey, { result: parsed, expiresAt: Date.now() + CONFIG.CACHE_TTL_MS });
        resolve(parsed);
      } catch (error: unknown) {
        reject(new Error(`Invalid JSON output from tool: ${stdout}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      if (!isTimeout) reject(err);
    });
  });
};

async function reportUsage(payload: {
  tool_name: string;
  agent_name?: string;
  ticker?: string;
  cycle_id?: string;
  success: boolean;
  execution_ms: number;
  error_message?: string;
  service_source: string;
}) {
  if (!CONFIG.TRADING_SERVICE_URL) return;
  const url = `${CONFIG.TRADING_SERVICE_URL}/api/v1/agent-tools/usage`;
  
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (CONFIG.TRADING_SERVICE_API_KEY) {
      headers["Authorization"] = `Bearer ${CONFIG.TRADING_SERVICE_API_KEY}`;
    }
    
    const response = await fetch(url, {
      method: "POST",
      headers,
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
  const toolArguments = (request.body || {}) as Record<string, unknown>;
  const startTime = Date.now();

  const agentName = (request.headers["x-agent"] || request.headers["x-username"] || "") as string;
  const cycleId = (request.headers["x-conversation-id"] || request.headers["x-request-id"] || "") as string;
  const ticker = (request.headers["x-ticker"] || toolArguments.ticker || toolArguments.Ticker || "") as string;

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
        musicApiResponse = await fetch(`${musicApiUrl}/api/artists/add-node`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({name: toolArguments.name, type: toolArguments.type}) });
      } else if (tName === "music_player_remove_node") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/discovered/${encodeURIComponent(toolArguments.node_id as string)}`, { method: "DELETE" });
      } else if (tName === "music_player_add_edge") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/edge`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({source: toolArguments.source, target: toolArguments.target, relationship: toolArguments.relationship || "related"}) });
      } else if (tName === "music_player_remove_edge") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/edge?source=${encodeURIComponent(toolArguments.source as string)}&target=${encodeURIComponent(toolArguments.target as string)}`, { method: "DELETE" });
      } else if (tName === "music_player_override_node_type") {
        musicApiResponse = await fetch(`${musicApiUrl}/api/graph/override-type`, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({node_id: toolArguments.node_id, group_type: toolArguments.group_type}) });
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
      tName.startsWith("html_notes_") || 
      tName === "render_component" || 
      tName.startsWith("canvas_")
    ) {
      const htmlNotesUrl = process.env.HTML_NOTES_URL || "http://10.0.0.16:8035";
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
        // Return 200 OK with is_error=true so the LLM sees the connection error instead of a generic 500
        result = { 
          error: `Failed to connect to html-notes service at ${htmlNotesUrl}. Is the service down? Details: ${(fetchError as Error).message}`, 
          is_error: true 
        };
      }
    } else {
      result = await executeTool(tName, toolArguments);
    }
    
    const durationMs = Date.now() - startTime;
    logger.info(JSON.stringify({ event: "tool_success", toolName, durationMs }));
    
    // Fire-and-forget report to trading-service
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
    
    // Fire-and-forget report to trading-service
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

    // Append to DLQ
    try {
      const deadLetterQueueEntry = JSON.stringify({ timestamp: new Date().toISOString(), toolName, args: toolArguments, error: errorMsg, durationMs }) + "\n";
      fs.promises.appendFile(path.join(dataDir, "dlq.jsonl"), deadLetterQueueEntry).catch(() => {});
    } catch (fsErr) {
      // Ignore DLQ append errors silently to not crash the request
    }
    
    response.status(500).json({ error: errorMsg, code: 500 });
  }
};

router.post("/:toolName", handleExecuteRoute);

export default router;
export { handleExecuteRoute };
