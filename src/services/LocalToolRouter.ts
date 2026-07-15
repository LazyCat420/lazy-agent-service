import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import CONFIG from "../../config.ts";
import logger from "../utils/logger.ts";

/**
 * LocalToolRouter — single source of truth for executing this service's
 * local tool catalog (tool_schemas.json).
 *
 * Shared by:
 *   - POST /execute/:toolName (ExecuteRoutes)
 *   - the MCP SSE server (McpAdapter CallTool)
 *   - the agentic loop (ToolOrchestratorService.executeMCPTool for
 *     mcp__lazy-tool-service__* tool calls)
 *
 * Routing:
 *   music_player_*                       → music-player HTTP API
 *   *_widget tools                       → validated locally, forwarded to HTML-Notes /internal/execute
 *   html_notes_* / canvas_* → HTML-Notes /internal/execute
 *   everything else                      → trading-service Python bridge (execute_tool.py)
 */

export interface LocalToolContext {
  agentName?: string;
  cycleId?: string;
  ticker?: string;
}

// Cache structure for python-bridge tool executions
interface CacheEntry {
  result: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/**
 * Executes a tool by launching the execute_tool.py Python script.
 */
export const executePythonTool = async (
  toolName: string,
  toolArguments: Record<string, unknown>,
  context?: LocalToolContext
): Promise<unknown> => {
  const argumentsJson = JSON.stringify(toolArguments);
  const cacheKey = crypto.createHash("sha256").update(toolName + argumentsJson).digest("hex");

  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info(JSON.stringify({ event: "cache_hit", toolName, args: toolArguments }));
    return cached.result;
  }

  return new Promise((resolve, reject) => {
    // Set up environment, stripping empty strings to avoid Pydantic conversion errors
    const env: Record<string, string> = {};
    for (const key of Object.keys(process.env)) {
      const val = process.env[key];
      if (val !== undefined && val !== "") {
        env[key] = val;
      }
    }
    env.PYTHONPATH = CONFIG.PYTHONPATH;
    env.SKIP_TOOL_USAGE_LOG = "true";
    env.USE_LAZY_TOOL_SERVICE = "false";
    if (context?.agentName) env.AGENT_NAME = context.agentName;
    if (context?.cycleId) env.CYCLE_ID = context.cycleId;
    if (context?.ticker) env.TICKER = context.ticker;

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
      reject(new Error(`Execution timed out after ${CONFIG.EXECUTION_TIMEOUT_MS} ms`));
    }, CONFIG.EXECUTION_TIMEOUT_MS);

    // Without this handler a spawn failure (e.g. missing interpreter) emits an
    // unhandled 'error' event that crashes the entire Node process — this took
    // down the container in a restart loop on 2026-07-14 (98 restarts).
    child.on("error", (spawnError) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to spawn python bridge (${CONFIG.PYTHON_INTERPRETER}): ${spawnError.message}`));
    });

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
  });
};

// The container image is Node-only (no Python interpreter), so the spawn
// bridge can never work there — python-bridge tools go to trading-service's
// HTTP executor instead. Local dev keeps the spawn path (venv exists).
const hasLocalPython = fs.existsSync(CONFIG.PYTHON_INTERPRETER);

/**
 * Execute a python-bridge tool via trading-service's HTTP endpoint
 * (POST /api/v1/agent-tools/execute). Returns {error, is_error} instead of
 * throwing so MCP callers get a structured failure, not a dropped session.
 */
export const executeToolViaTradingService = async (
  toolName: string,
  toolArguments: Record<string, unknown>,
  context?: LocalToolContext
): Promise<unknown> => {
  const argumentsJson = JSON.stringify(toolArguments);
  const cacheKey = crypto.createHash("sha256").update(toolName + argumentsJson).digest("hex");

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    logger.info(JSON.stringify({ event: "cache_hit", toolName, args: toolArguments }));
    return cached.result;
  }

  const url = `${CONFIG.TRADING_SERVICE_URL}/api/v1/agent-tools/execute`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.EXECUTION_TIMEOUT_MS);
    const apiResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.TRADING_SERVICE_API_KEY || ""}`
      },
      body: JSON.stringify({
        tool_name: toolName,
        arguments: toolArguments,
        agent_name: context?.agentName || "",
        ticker: context?.ticker || "",
        cycle_id: context?.cycleId || ""
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      logger.error(`[LocalToolRouter] trading-service execute ${toolName} → ${apiResponse.status}: ${errText.slice(0, 300)}`);
      return { error: `trading-service tool execution failed (${apiResponse.status}): ${errText.slice(0, 500)}`, is_error: true };
    }

    const result = await apiResponse.json();
    cache.set(cacheKey, { result, expiresAt: Date.now() + CONFIG.CACHE_TTL_MS });
    return result;
  } catch (fetchError: unknown) {
    const message = (fetchError as Error).message || String(fetchError);
    logger.error(`[LocalToolRouter] trading-service execute ${toolName} unreachable: ${message}`);
    return { error: `Failed to reach trading-service at ${url}: ${message}`, is_error: true };
  }
};

/** Forward a tool call to the HTML-Notes internal dispatcher. */
async function forwardToHtmlNotes(
  toolName: string,
  toolArguments: Record<string, unknown>
): Promise<unknown> {
  const htmlNotesUrl = CONFIG.HTML_NOTES_URL || "http://10.0.0.16:8035";
  try {
    const apiResponse = await fetch(`${htmlNotesUrl}/internal/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: toolName, args: toolArguments })
    });
    if (apiResponse.ok) {
      return await apiResponse.json();
    }
    return { error: await apiResponse.text(), is_error: true };
  } catch (fetchError: unknown) {
    return {
      error: `Failed to connect to html-notes service at ${htmlNotesUrl}. Is the service down? Details: ${(fetchError as Error).message}`,
      is_error: true
    };
  }
}

/**
 * Route a local-catalog tool call to its executor and return the result.
 * Never throws for widget/html-notes routing errors (returns {error} objects);
 * the python bridge path can reject like before.
 */
/**
 * Cannabis strain research tools, backed by treesearch-service.
 *
 * Every tool is a thin, bounded GET against an endpoint that already paginates and
 * truncates, so a response cannot blow the agent's context. The one write —
 * strain_import — kicks off a multi-minute scrape and returns a job_id immediately,
 * because a tool call is aborted long before that job finishes; the agent polls
 * strain_import_status.
 *
 * Never throws: a failure is returned as { error, is_error } so the agent can recover.
 */
async function routeStrainTool(
  tName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const baseUrl = CONFIG.TREESEARCH_SERVICE_URL;
  const name = () => encodeURIComponent(String(args.strain_name ?? ""));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.EXECUTION_TIMEOUT_MS);

  try {
    let response: globalThis.Response;

    switch (tName) {
      case "strain_search": {
        const params = new URLSearchParams({
          search: String(args.query ?? ""),
          limit: String(args.limit ?? 20),
        });
        if (args.complete_only) params.set("complete_only", "true");
        response = await fetch(`${baseUrl}/api/strains?${params}`, { signal: controller.signal });
        break;
      }
      case "strain_detail": {
        const params = new URLSearchParams({
          include_observations: String(args.include_observations ?? false),
        });
        response = await fetch(`${baseUrl}/api/strains/${name()}/detail?${params}`, { signal: controller.signal });
        break;
      }
      case "strain_terpene_profile":
        response = await fetch(`${baseUrl}/api/strains/${name()}/terpene-profile`, { signal: controller.signal });
        break;
      case "strain_forum_posts": {
        const params = new URLSearchParams({ limit: String(args.limit ?? 25) });
        if (args.source) params.set("source", String(args.source));
        response = await fetch(`${baseUrl}/api/strains/${name()}/observations?${params}`, { signal: controller.signal });
        break;
      }
      case "strain_images": {
        const params = new URLSearchParams({ limit: String(args.limit ?? 20) });
        response = await fetch(`${baseUrl}/api/strains/${name()}/images?${params}`, { signal: controller.signal });
        break;
      }
      case "strain_neighbors": {
        const params = new URLSearchParams({ k: String(args.k ?? 10) });
        response = await fetch(`${baseUrl}/api/strains/${name()}/neighbors?${params}`, { signal: controller.signal });
        break;
      }
      case "strain_import":
        response = await fetch(`${baseUrl}/api/strains/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: String(args.strain_name ?? ""),
            force: Boolean(args.force ?? false),
            stream: false, // return a job_id; do not hold the tool call open for minutes
          }),
          signal: controller.signal,
        });
        break;
      case "strain_import_status":
        response = await fetch(
          `${baseUrl}/api/import-jobs/${encodeURIComponent(String(args.job_id ?? ""))}`,
          { signal: controller.signal }
        );
        break;
      default:
        return { error: `Unknown strain tool: ${tName}`, is_error: true };
    }

    const body = await response.text();
    if (!response.ok) {
      return { error: `treesearch-service ${response.status}: ${body.slice(0, 500)}`, is_error: true };
    }
    try {
      return JSON.parse(body);
    } catch {
      return { error: `treesearch-service returned non-JSON: ${body.slice(0, 200)}`, is_error: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && err.name === "AbortError";
    logger.error(`[strain tools] ${tName} failed: ${message}`);
    return {
      error: timedOut
        ? `treesearch-service timed out after ${CONFIG.EXECUTION_TIMEOUT_MS}ms`
        : `treesearch-service unreachable at ${baseUrl}: ${message}`,
      is_error: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function routeLocalTool(
  toolName: string,
  toolArguments: Record<string, unknown>,
  context: LocalToolContext = {}
): Promise<unknown> {
  let tName = toolName;
  if (tName.startsWith("mcp__lazy-tool-service__")) {
    tName = tName.replace("mcp__lazy-tool-service__", "");
  }
  const cycleId = context.cycleId || "";

  if (tName.startsWith("music_player_")) {
    const musicApiUrl = "http://10.0.0.16:8002";
    let musicApiResponse: globalThis.Response | null = null;
    let result: unknown;
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
    return result;
  }

  if (tName.startsWith("strain_")) {
    return await routeStrainTool(tName, toolArguments);
  }

  if (
    tName === "create_widget" ||
    tName === "update_widget" ||
    tName === "validate_widget_html" ||
    tName === "list_widget_types" ||
    tName === "plan_widget"
  ) {
    const { WidgetTemplateRegistry } = await import("./WidgetTemplateRegistry.ts");
    const { default: ToolContext } = await import("./ToolContext.ts");

    if (tName === "plan_widget") {
      if (cycleId) {
        ToolContext.set(cycleId, "widgetPlanApproved", true);
      }
      return {
        success: true,
        message: "Widget plan registered and approved. You are now authorized to call create_widget."
      };
    }

    if (tName === "validate_widget_html") {
      const htmlContent = (toolArguments.htmlContent || "") as string;
      const validation = WidgetTemplateRegistry.validateHTML(htmlContent);
      return {
        valid: validation.valid,
        errors: validation.errors
      };
    }

    if (tName === "list_widget_types") {
      return {
        success: true,
        types: WidgetTemplateRegistry.list()
      };
    }

    // create_widget / update_widget
    if (tName === "create_widget" && cycleId) {
      // The plan gate is only enforceable when we have a session id to track
      // approval against (MCP CallTool and some agent contexts have none).
      const isApproved = ToolContext.get<boolean>(cycleId, "widgetPlanApproved");
      if (!isApproved) {
        return {
          success: false,
          error: "PLANNING_REQUIRED",
          message: "You must first call plan_widget with a structured design plan before calling create_widget."
        };
      }
    }

    const htmlContent = (toolArguments.htmlContent || "") as string;
    if (tName === "create_widget" || (tName === "update_widget" && htmlContent)) {
      const validation = WidgetTemplateRegistry.validateHTML(htmlContent);
      if (!validation.valid) {
        return {
          success: false,
          error: "VALIDATION_FAILED",
          message: `Widget HTML validation failed: ${validation.errors.join("; ")}`
        };
      }
    }
    return forwardToHtmlNotes(tName, toolArguments);
  }

  if (
    tName.startsWith("html_notes_") ||
    tName.startsWith("canvas_")
  ) {
    if (tName === "canvas_modify_dom" && !toolArguments.canvas_html) {
      return { success: true, message: "Handled natively by HTML-Notes client" };
    }
    return forwardToHtmlNotes(tName, toolArguments);
  }

  if (!hasLocalPython) {
    return executeToolViaTradingService(tName, toolArguments, context);
  }
  return executePythonTool(tName, toolArguments, context);
}
