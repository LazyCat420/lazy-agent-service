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
  result: any;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

// Ensure data directory exists for DLQ
const dataDir = path.resolve("data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const executeTool = async (toolName: string, args: Record<string, any>): Promise<any> => {
  const argsJson = JSON.stringify(args);
  const cacheKey = crypto.createHash("sha256").update(toolName + argsJson).digest("hex");

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info(JSON.stringify({ event: "cache_hit", toolName, args }));
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
      [CONFIG.PYTHON_EXEC_SCRIPT, toolName, argsJson],
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
      } catch (err: any) {
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
  } catch (err: any) {
    logger.error(`[UsageReporting] Network error reporting tool usage: ${err.message}`);
  }
}

const handleExecuteRoute: RequestHandler = async (req, res) => {
  const { toolName } = req.params;
  const args = req.body || {};
  const startTime = Date.now();

  const agentName = (req.headers["x-agent"] || req.headers["x-username"] || "") as string;
  const cycleId = (req.headers["x-conversation-id"] || req.headers["x-request-id"] || "") as string;
  const ticker = (req.headers["x-ticker"] || args.ticker || args.Ticker || "") as string;

  try {
    logger.info(JSON.stringify({ event: "tool_start", toolName, args }));
    
    let result;
    const tName = toolName as string;
    if (tName.startsWith("music_player_")) {
      const musicApiUrl = "http://10.0.0.16:8002";
      let res: any = null;
      if (tName === "music_player_suggest_artists") {
        result = { artists: args.artists || [] };
      } else if (tName === "music_player_add_node") {
        res = await fetch(`${musicApiUrl}/api/artists/add-node`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({name: args.name, type: args.type}) });
      } else if (tName === "music_player_remove_node") {
        res = await fetch(`${musicApiUrl}/api/graph/discovered/${encodeURIComponent(args.node_id)}`, { method: "DELETE" });
      } else if (tName === "music_player_add_edge") {
        res = await fetch(`${musicApiUrl}/api/graph/edge`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({source: args.source, target: args.target, relationship: args.relationship || "related"}) });
      } else if (tName === "music_player_remove_edge") {
        res = await fetch(`${musicApiUrl}/api/graph/edge?source=${encodeURIComponent(args.source)}&target=${encodeURIComponent(args.target)}`, { method: "DELETE" });
      } else if (tName === "music_player_override_node_type") {
        res = await fetch(`${musicApiUrl}/api/graph/override-type`, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({node_id: args.node_id, group_type: args.group_type}) });
      } else if (tName === "music_player_expand_artist") {
        res = await fetch(`${musicApiUrl}/api/graph/expand/${encodeURIComponent(args.artist)}?count=${args.count || 8}`);
      } else if (tName === "music_player_expand_genre") {
        res = await fetch(`${musicApiUrl}/api/graph/expand/genre/${encodeURIComponent(args.genre)}?count=${args.count || 8}`);
      } else if (tName === "music_player_get_graph_state") {
        res = await fetch(`${musicApiUrl}/api/graph/discovered`);
      } else if (tName === "music_player_search_artists") {
        res = await fetch(`${musicApiUrl}/api/artists`);
      } else if (tName === "music_player_get_artist_info") {
        res = await fetch(`${musicApiUrl}/api/artist/info/${encodeURIComponent(args.name)}`);
      } else if (tName === "music_player_list_genres") {
        res = await fetch(`${musicApiUrl}/api/genres`);
      } else {
        result = { success: true };
      }

      if (res !== null) {
        if (res.ok) {
          result = await res.json();
        } else {
          result = { error: await res.text() };
        }
      }
    } else {
      result = await executeTool(tName, args);
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

    res.json(result);
  } catch (error: any) {
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
      const dlqEntry = JSON.stringify({ timestamp: new Date().toISOString(), toolName, args, error: errorMsg, durationMs }) + "\n";
      fs.promises.appendFile(path.join(dataDir, "dlq.jsonl"), dlqEntry).catch(() => {});
    } catch (fsErr) {
      // Ignore DLQ append errors silently to not crash the request
    }
    
    res.status(500).json({ error: errorMsg, code: 500 });
  }
};

router.post("/:toolName", handleExecuteRoute);

export default router;
export { handleExecuteRoute };
