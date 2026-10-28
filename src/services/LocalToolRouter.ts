import { classifyToolResult } from "./ToolResult.ts";
import CONFIG from "../../config.ts";
import logger from "../utils/logger.ts";
import { callKey, guardedRun } from "./ToolCallGuard.ts";
import { newsSearch, newsProviderStatus } from "./NewsSearchService.ts";
import { filterResultsByDomain, webSearch, webSearchStatus, withSiteSearch } from "./WebSearchService.ts";
import { CATEGORIES } from "./EditorialHeadlinesService.ts";
import { stripMcpPrefix } from "./McpPrefix.ts";
import MCPClientService from "./MCPClientService.ts";
import {
  chargeScrape,
  filterSearchResultLinks,
  registerRunUrls,
  registerSearchResultUrls,
  scrapeTargetGuard,
  unscrapableDomainOf,
} from "./UnscrapableDomains.ts";

/**
 * LocalToolRouter — single source of truth for executing this service's
 * local tool catalog (tool_schemas.json).
 *
 * Shared by:
 *   - POST /execute/:toolName (ExecuteRoutes)
 *   - the MCP SSE server (McpAdapter CallTool)
 *   - the agentic loop (ToolOrchestratorService.executeMCPTool for
 *     mcp__lazy-agent-service__* tool calls)
 *
 * Routing:
 *   news_search                          → implemented HERE (NewsSearchService)
 *   web_search                           → implemented HERE (WebSearchService); not in
 *                                          tool_schemas.json, so services call it, agents don't
 *   scrape_url                           → implemented HERE (WebExtractService), with the
 *                                          UnscrapableDomains refusal and per-run budget
 *   lazy_web_search                      → trading-service bridge, links to unscrapable
 *                                          publishers blanked on the way back
 *   music_player_*                       → music-player HTTP API
 *   *_widget tools                       → validated locally, forwarded to HTML-Notes /internal/execute
 *   html_notes_* / canvas_* → HTML-Notes /internal/execute
 *   everything else                      → trading-service HTTP bridge (/api/v1/agent-tools/execute)
 */

export interface LocalToolContext {
  agentName?: string;
  cycleId?: string;
  ticker?: string;
  /** One agent run; carried by the signed trading context (TradingToolContext). */
  conversationId?: string;
  signal?: AbortSignal;
}

// Cache structure for python-bridge tool executions
interface CacheEntry {
  result: unknown;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
// Explicit reusable data reads only. Unknown tools, writes, composite tools,
// account state and mutable collaboration state always execute afresh.
export const REUSABLE_READ_TOOLS = new Set([
  "get_market_data", "get_polygon_price_history", "get_finviz_fundamentals",
  "get_earnings_data", "get_finnhub_news",
  "get_institutional_holdings",
  "get_technical_indicators", "get_upcoming_events", "lazy_web_search", "scrape_url",
]);

export const REPEAT_GUARDED_TOOLS = new Set([
  ...REUSABLE_READ_TOOLS,
  "whiteboard_read",
  "screener_query",
  "run_equation",
  "run_backtest",
  "search_equations",
  "get_sec_filings",
  "query_sec_filing",
  "get_insider_trades",
  "get_congress_trades",
  "get_reddit_sentiment",
  "get_macro_indicators",
]);


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
  const reusable = REUSABLE_READ_TOOLS.has(toolName);
  // The Python bridge repairs an absent ticker from caller context. Requests
  // with identical raw arguments but different fallback tickers are not equal.
  const fallbackTicker = typeof toolArguments.ticker === "string" && toolArguments.ticker.trim()
    ? "" : context?.ticker || "";
  const cacheKey = callKey(toolName, { arguments: toolArguments, fallbackTicker });

  const readCache = (): unknown | undefined => {
    const hit = cache.get(cacheKey);
    return hit && hit.expiresAt > Date.now() ? hit.result : undefined;
  };

  const fresh = reusable ? readCache() : undefined;
  if (fresh !== undefined) {
    logger.info(JSON.stringify({ event: "cache_hit", toolName, args: toolArguments }));
    return fresh;
  }

  // Coalesce identical in-flight calls, apply repeat-call friction, and cap
  // per-tool concurrency. See ToolCallGuard for why each layer exists.
  return guardedRun({
    toolName,
    key: cacheKey,
    scope: { agentName: context?.agentName, cycleId: context?.cycleId },
    cached: reusable ? readCache : undefined,
    coalesce: reusable,
    repeatGuard: REPEAT_GUARDED_TOOLS.has(toolName),
    run: () => callTradingService(toolName, toolArguments, context, reusable ? cacheKey : undefined),
  });

};

const callTradingService = async (
  toolName: string,
  toolArguments: Record<string, unknown>,
  context: LocalToolContext | undefined,
  cacheKey: string | undefined
): Promise<unknown> => {
  const url = `${CONFIG.TRADING_SERVICE_URL}/api/v1/agent-tools/execute`;
  const timeoutMs = CONFIG.SLOW_TOOLS.has(toolName)
    ? CONFIG.SLOW_TOOL_TIMEOUT_MS
    : CONFIG.EXECUTION_TIMEOUT_MS;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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
    // Never cache a failure: a cached error would be replayed to every repeat
    // caller for the whole TTL, turning one transient blip into a minute of
    // guaranteed failures.
    if (cacheKey && classifyToolResult(result).success) {
      cache.set(cacheKey, { result, expiresAt: Date.now() + CONFIG.CACHE_TTL_MS });
    }
    return result;
  } catch (fetchError: unknown) {
    const isAbort = (fetchError as Error)?.name === "AbortError";
    const message = isAbort
      ? `bridge timeout after ${timeoutMs}ms`
      : (fetchError as Error).message || String(fetchError);
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
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Shared secret for HTML-Notes' /internal/execute auth; both services carry
    // INTERNAL_EXECUTE_TOKEN in their .env. Omitted when unset (compat mode).
    if (process.env.INTERNAL_EXECUTE_TOKEN) {
      headers["x-internal-token"] = process.env.INTERNAL_EXECUTE_TOKEN;
    }
    const apiResponse = await fetch(`${htmlNotesUrl}/internal/execute`, {
      method: "POST",
      headers,
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

async function handlePlanWidget(
  toolArguments: Record<string, unknown>,
  cycleId: string,
): Promise<unknown> {
  const { default: ToolContext } = await import("./ToolContext.ts");
  const { evaluateWidgetPlan, CREATE_CONSTRAINTS } = await import("./WidgetPlanGate.ts");
  const verdict = evaluateWidgetPlan(toolArguments);
  if (verdict.ok === false) {
    return {
      success: false,
      error: "PLAN_INCOMPLETE",
      missing: verdict.missing,
      message: verdict.message,
    };
  }
  if (cycleId) {
    ToolContext.set(cycleId, "widgetPlan", verdict.plan);
    ToolContext.set(cycleId, "widgetPlanApproved", true);
  }
  return {
    success: true,
    plan: verdict.plan,
    message:
      `Plan registered for a '${verdict.plan.widgetType}' widget "${verdict.plan.title}". ` +
      `Now call create_widget with widgetType='${verdict.plan.widgetType}' and the same title. ` +
      CREATE_CONSTRAINTS,
  };
}

async function routeWidgetTool(
  tName: string,
  toolArguments: Record<string, unknown>,
  cycleId: string,
): Promise<unknown> {
  if (tName === "plan_widget") {
    return handlePlanWidget(toolArguments, cycleId);
  }
  const { WidgetTemplateRegistry } = await import("./WidgetTemplateRegistry.ts");
  const { default: ToolContext } = await import("./ToolContext.ts");
  const { checkCreateAgainstPlan } = await import("./WidgetPlanGate.ts");

  if (tName === "validate_widget_html") {
    const htmlContent = (toolArguments.htmlContent || "") as string;
    const validation = WidgetTemplateRegistry.validateHTML(htmlContent);
    return {
      valid: validation.valid,
      errors: validation.errors,
    };
  }

  if (tName === "list_widget_types") {
    return {
      success: true,
      types: WidgetTemplateRegistry.list(),
    };
  }

  if (tName === "create_widget" && cycleId) {
    const plan = ToolContext.get<import("./WidgetPlanGate.ts").WidgetPlan>(cycleId, "widgetPlan");
    const check = checkCreateAgainstPlan(plan, toolArguments);
    if (check.ok === false) {
      return { success: false, error: check.error, message: check.message };
    }
  }

  const htmlContent = (toolArguments.htmlContent || "") as string;
  if (tName === "create_widget" || (tName === "update_widget" && htmlContent)) {
    const validation = WidgetTemplateRegistry.validateHTML(htmlContent);
    if (!validation.valid) {
      return {
        success: false,
        error: "VALIDATION_FAILED",
        message: `Widget HTML validation failed: ${validation.errors.join("; ")}`,
      };
    }
  }
  return forwardToHtmlNotes(tName, toolArguments);
}

async function routeScrapeUrlTool(
  toolArguments: Record<string, unknown>,
  context: LocalToolContext,
): Promise<unknown> {
  const url = typeof toolArguments.url === "string" ? toolArguments.url : "";
  if (url.trim()) {
    const targetRefusal = scrapeTargetGuard(url, context);
    if (targetRefusal) return targetRefusal;
    if (!unscrapableDomainOf(url)) {
      const refusal = chargeScrape(url, context);
      if (refusal) return refusal;
    }
  }
  const { default: ToolOrchestratorService } = await import("./ToolOrchestratorService.ts");
  return ToolOrchestratorService.executeWebExtract(toolArguments);
}

async function routeWebSearchTool(
  toolArguments: Record<string, unknown>,
  context: LocalToolContext,
): Promise<unknown> {
  const query = String(toolArguments.query ?? toolArguments.q ?? "").trim();
  const found = await webSearch(withSiteSearch(query, toolArguments), Number(toolArguments.limit ?? 6) || 6, undefined, context.signal);
  const result = { ...found, results: filterResultsByDomain(found.results, toolArguments) };
  registerRunUrls(result.results.map((r) => r.url), context);
  return {
    query,
    ...result,
    count: result.results.length,
    ...(result.status === "ok" ? {} : { is_error: true }),
    search: webSearchStatus(),
  };
}

async function routeNewsSearchTool(
  toolArguments: Record<string, unknown>,
  context: LocalToolContext,
): Promise<unknown> {
  const topic = String(toolArguments.topic ?? toolArguments.query ?? "").trim();
  const limit = Number(toolArguments.limit ?? 6) || 6;
  const country = String(
    toolArguments.country ?? toolArguments.region ?? "",
  ).trim().toLowerCase();
  const rawCategory = String(toolArguments.category ?? toolArguments.section ?? "")
    .trim()
    .toLowerCase();
  const category = (CATEGORIES as readonly string[]).includes(rawCategory)
    ? rawCategory
    : "";
  const debug = {
    source: String(toolArguments._source ?? "").trim().toLowerCase(),
    provider: String(toolArguments._provider ?? "").trim().toLowerCase(),
  };
  const result = country
    ? await newsSearch(topic, limit, country, category, debug)
    : await newsSearch(topic, limit, undefined, category, debug);
  registerRunUrls(result.items.map((r) => r.url), context);
  return {
    topic,
    country: country || "(default)",
    category: category || "(top)",
    source: result.source,
    count: result.items.length,
    items: result.items,
    providers: newsProviderStatus(),
  };
}

const WIDGET_TOOL_NAMES = new Set([
  "create_widget",
  "update_widget",
  "validate_widget_html",
  "list_widget_types",
  "plan_widget",
]);

export async function routeLocalTool(
  toolName: string,
  toolArguments: Record<string, unknown>,
  context: LocalToolContext = {}
): Promise<unknown> {
  const tName = stripMcpPrefix(toolName);
  const cycleId = context.cycleId || "";

  const remote = MCPClientService.parseMCPToolName(toolName);
  if (remote && MCPClientService.isConnected(remote.serverName)) {
    return MCPClientService.callTool(remote.serverName, remote.toolName, toolArguments);
  }

  if (tName.startsWith("music_player_")) {
    return { error: `Retired tool: ${tName}` };
  }

  if (tName.startsWith("strain_")) {
    return await routeStrainTool(tName, toolArguments);
  }

  if (WIDGET_TOOL_NAMES.has(tName)) {
    return routeWidgetTool(tName, toolArguments, cycleId);
  }

  if (tName === "scrape_url") {
    return routeScrapeUrlTool(toolArguments, context);
  }

  if (tName === "lazy_web_search") {
    const filtered = filterSearchResultLinks(await executeToolViaTradingService(tName, toolArguments, context));
    registerSearchResultUrls(filtered, context);
    return filtered;
  }

  if (tName === "web_search") {
    return routeWebSearchTool(toolArguments, context);
  }

  if (tName === "news_search") {
    return routeNewsSearchTool(toolArguments, context);
  }

  if (tName.startsWith("html_notes_") || tName.startsWith("canvas_")) {
    if (tName === "canvas_modify_dom" && !toolArguments.canvas_html) {
      return { success: true, message: "Handled natively by HTML-Notes client" };
    }
    return forwardToHtmlNotes(tName, toolArguments);
  }

  return executeToolViaTradingService(tName, toolArguments, context);
}
