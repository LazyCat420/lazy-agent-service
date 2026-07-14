import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { TOOLS_SERVICE_URL } from "../../config.ts";

import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { ORCHESTRATOR_ONLY_TOOLS } from "./OrchestratorPrompt.ts";
import { createAbortController } from "../utils/AbortController.ts";
import {
  DOMAINS,
  TOOL_NAMES,
  TOOL_INPUT_MODALITIES,
  TOPOLOGIES,
  DEFAULT_TOPOLOGY,
  isCoreDomain,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  TOOL_SCHEMA_FETCH_TIMEOUT_MS,
  TOOL_CONFIG_FETCH_TIMEOUT_MS,
  TOOL_WORKSPACE_UPDATE_TIMEOUT_MS,
  TOOL_WORKSPACE_VALIDATE_TIMEOUT_MS,
  TOOL_API_HEALTH_TIMEOUT_MS,
  FILE_CATEGORIES,
} from "../constants.ts";

import SettingsService from "./SettingsService.ts";
import PromptLocaleService from "./PromptLocaleService.ts";
import {
  injectVoiceCatalog,
  TTS_VOICE_CATALOG_PLACEHOLDER,
} from "../utils/VoiceCatalog.ts";
import type { OrchestratorContext, TeamMember } from "../types/orchestrator.ts";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** Endpoint metadata attached to full tool schemas from tools-api */
interface ToolEndpoint {
  path: string;
  method?: string;
  pathParams?: string[];
  queryParams?: string[];
  conditionalPath?: { param: string; template: string };
}

/** Full tool schema as returned by tools-api /admin/tool-schemas */
interface ToolSchemaFull {
  name: string;
  description?: string;
  parameters?: unknown;
  endpoint?: ToolEndpoint;
  domain?: string;
  dataSource?: string;
  [key: string]: unknown;
}

/** tools-api /admin/config response */
interface ToolsApiConfig {
  workspaceRoots?: string[];
  staticRoots?: string[];
  [key: string]: unknown;
}

/** Context passed through from the agentic loop to tool execution */
interface ToolExecutionContext {
  project?: string | null;
  username?: string | null;
  agent?: string | null;
  requestId?: string;
  traceId?: string | null;
  agentConversationId?: string | null;
  conversationId?: string | null;
  iteration?: number;
  workspaceRoot?: string | null;
  signal?: AbortSignal;
  messages?: Array<{ role: string; images?: string[]; [key: string]: unknown }>;
  _providerName?: string;
  _resolvedModel?: string;
  _emit?: ((event: { type: string; [key: string]: unknown }) => void) | null;
  _maxSubAgentIterations?: number;
  _minContextLength?: number;
  enabledTools?: string[];
  _topology?: string;
  _recursionDepth?: number;
  _maxRecursionDepth?: number;
  _thinkingEnabled?: boolean;
  _reasoningEffort?: string;
  _thinkingBudget?: number;
  clientIp?: string | null;
  _toolState?: unknown;
}

/** Worktree session state */
interface WorktreeState {
  originalRoot: string;
  worktreePath: string;
  branch?: string;
  [key: string]: unknown;
}

interface GenerateImageToolResult {
  image?: { data?: string; mimeType?: string; minioRef?: string };
  error?: string;
  [key: string]: unknown;
}

interface BrowserActionToolResult {
  screenshot?: string;
  screenshotRef?: string;
  mimeType?: string;
  error?: string;
  [key: string]: unknown;
}

// ────────────────────────────────────────────────────────────
// Schema Cache — fetched from tools-api at startup
// ────────────────────────────────────────────────────────────

/** @type {Array} Full tool schemas (with endpoint metadata) */
let cachedSchemas: ToolSchemaFull[] = [];

/** @type {Array} Clean schemas for LLM (without endpoint metadata) */
let cachedAISchemas: ToolSchemaFull[] = [];

/** @type {Array} Client-facing schemas (with domain/dataSource, without endpoint) */
let cachedClientSchemas: ToolSchemaFull[] = [];

/**
  * Per-locale caches for remote tool schemas.
 * The default locale populates cachedClientSchemas/cachedAISchemas directly.
 * Non-default locales (e.g. "caveman") are stored here so that
 * getClientToolSchemas(topology, "caveman") returns localized descriptions
 * from the tools-service instead of the default English schemas.
 */
const localizedClientSchemasCache = new Map<string, ToolSchemaFull[]>();
const localizedAISchemasCache = new Map<string, ToolSchemaFull[]>();
const attemptedLocales = new Set<string>();

/** @type {Map<string, ToolSchemaFull>} Tool name → full schema (for routing) */
const toolMap = new Map<string, ToolSchemaFull>();

/** @type {string[]} Allowed workspace root paths (fetched from tools-api) */
let cachedWorkspaceRoots: string[] = [];

/** @type {string[]} Static roots from config.js (immutable, for "pinned" UI) */
let cachedStaticRoots: string[] = [];

/** Namespace prefix for this service's own local tool catalog on /agent */
const LOCAL_MCP_PREFIX = "mcp__lazy-tool-service__";

/** Cached MCP-namespaced subset of tool_schemas.json (loaded once) */
let cachedLocalMcpSchemas: Array<{
  name: string;
  description?: string;
  parameters?: unknown;
  domain?: string;
  _mcpServer?: string;
  _mcpOriginalName?: string;
}> | null = null;

/** @type {boolean} Whether initial fetch has completed */
let initialized = false;
let lastFetchAttemptTime = 0;

/** Recursion guard for client-facing schema resolution */
let isResolvingClientSchemas = false;

/**
 * Active worktree sessions — keyed by agentConversationId.
 * When the main agent calls enter_worktree, its session's workspace root
 * is redirected to the worktree path. All file/git/shell tool calls
 * then operate in the worktree until exit_worktree is called.
 */
const activeWorktrees = new Map<string, WorktreeState>();

/**
 * Fetch tool schemas from tools-api and populate caches.
 * Called eagerly at module load — non-blocking, graceful fallback.
 * Always fetches default English schemas to populate default caches.
 */
async function fetchSchemas() {
  lastFetchAttemptTime = Date.now();
  try {
    const controller = createAbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TOOL_SCHEMA_FETCH_TIMEOUT_MS,
    );

    const response = await fetch(`${TOOLS_SERVICE_URL}/admin/tool-schemas`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(
        `[ToolOrchestrator] Failed to fetch tool schemas: ${response.status} ${response.statusText}`,
      );
      return;
    }

    const schemas = (await response.json()) as ToolSchemaFull[];

    if (!Array.isArray(schemas) || schemas.length === 0) {
      logger.warn(
        "[ToolOrchestrator] Tool schemas response was empty or invalid",
      );
      return;
    }

    cachedSchemas = schemas;

    // Client-facing schemas: keep domain/dataSource for UI grouping, strip only endpoint
    cachedClientSchemas = schemas.map(
      ({ endpoint: _endpoint, ...rest }) => rest,
    );

    // Strip endpoint, dataSource, and domain metadata for LLM consumption
    cachedAISchemas = schemas.map(
      ({
        endpoint: _endpoint,
        dataSource: _dataSource,
        domain: _domain,
        ...rest
      }) => rest,
    );

    // Build lookup map for executor
    toolMap.clear();
    for (const schema of schemas) {
      toolMap.set(schema.name, schema);
    }

    initialized = true;

    logger.info(
      `[ToolOrchestrator] Loaded ${schemas.length} tool schemas from tools-api`,
    );

    // Fetch workspace config from tools-api (single source of truth)
    try {
      const configResponse = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MS),
      });
      if (configResponse.ok) {
        const config = (await configResponse.json()) as ToolsApiConfig;
        if (Array.isArray(config.workspaceRoots)) {
          cachedWorkspaceRoots = config.workspaceRoots;
          logger.info(
            `[ToolOrchestrator] Workspace roots: ${cachedWorkspaceRoots.join(", ")}`,
          );
        }
        if (Array.isArray(config.staticRoots)) {
          cachedStaticRoots = config.staticRoots;
        }
      }
    } catch (configError: unknown) {
      logger.warn(
        `[ToolOrchestrator] Could not fetch workspace config: ${getErrorMessage(configError)}`,
      );
    }
  } catch (error: unknown) {
    logger.warn(
      `[ToolOrchestrator] Could not reach tools-api for schemas: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Fetch localized remote tool schemas for a specific non-default locale.
 * Populates the per-locale caches so that getClientToolSchemas(topology, locale)
 * returns tool descriptions in the correct language.
 */
async function fetchSchemasForLocale(locale: string) {
  if (locale === "en" || localizedClientSchemasCache.has(locale) || attemptedLocales.has(locale)) return;
  attemptedLocales.add(locale);
  try {
    const localeParam = `?locale=${encodeURIComponent(locale)}`;
    const response = await fetch(
      `${TOOLS_SERVICE_URL}/admin/tool-schemas${localeParam}`,
      { signal: AbortSignal.timeout(TOOL_SCHEMA_FETCH_TIMEOUT_MS) },
    );
    if (!response.ok) {
      logger.warn(
        `[ToolOrchestrator] Failed to fetch locale "${locale}" schemas: ${response.status}`,
      );
      return;
    }
    const schemas = (await response.json()) as ToolSchemaFull[];
    if (!Array.isArray(schemas) || schemas.length === 0) return;

    localizedClientSchemasCache.set(
      locale,
      schemas.map(({ endpoint: _endpoint, ...rest }) => rest),
    );
    localizedAISchemasCache.set(
      locale,
      schemas.map(
        ({ endpoint: _endpoint, dataSource: _dataSource, domain: _domain, ...rest }) => rest,
      ),
    );
    logger.info(
      `[ToolOrchestrator] Loaded ${schemas.length} localized tool schemas for locale "${locale}"`,
    );
  } catch (error: unknown) {
    logger.warn(
      `[ToolOrchestrator] Could not fetch locale "${locale}" schemas: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Prefetch tool schemas for all known non-default locales.
 * Called after the initial fetchSchemas() completes so that
 * per-conversation locale requests are served from cache.
 */
async function prefetchAllLocaleSchemas() {
  const defaultLocale = PromptLocaleService.getDefaultLocale();
  const allLocales = PromptLocaleService.getAvailableLocales();
  const nonDefaultLocales = allLocales.filter(
    (localeName) => localeName !== defaultLocale,
  );
  if (nonDefaultLocales.length === 0) return;
  logger.info(
    `[ToolOrchestrator] Prefetching remote tool schemas for locale(s): ${nonDefaultLocales.join(", ")}`,
  );
  await Promise.allSettled(
    nonDefaultLocales.map((localeName) => fetchSchemasForLocale(localeName)),
  );
}

// Kick off schema fetch eagerly at module load (non-blocking).
// If tools-api is unreachable, schemas stay empty until the first
// consumer calls ensureSchemas(), which fetches on-demand.
fetchSchemas().then(() => prefetchAllLocaleSchemas());

// ────────────────────────────────────────────────────────────
// Generic URL Builder — uses endpoint metadata
// ────────────────────────────────────────────────────────────

function buildUrlFromEndpoint(
  endpoint: ToolEndpoint,
  args: Record<string, unknown> = {},
) {
  let path = endpoint.path;
  if (endpoint.conditionalPath) {
    const { param, template } = endpoint.conditionalPath;
    if (args[param]) {
      path = template;
    }
  }

  const dynamicParams = new Set<string>();
  const matchResult = path.match(/:[a-zA-Z_][a-zA-Z0-9_]*/g);
  if (matchResult) {
    for (const match of matchResult) {
      dynamicParams.add(match.slice(1));
    }
  }

  const pathParams = new Set([
    ...(endpoint.pathParams || []),
    ...dynamicParams,
  ]);
  for (const parameter of pathParams) {
    const parameterValue = args[parameter];
    if (parameterValue !== undefined && parameterValue !== null) {
      path = path.replace(
        `:${parameter}`,
        encodeURIComponent(String(parameterValue)),
      );
    }
  }

  const params = new URLSearchParams();

  const queryParams = endpoint.queryParams || [];
  for (const key of queryParams) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }

  if (args.fields) {
    const fieldsString = Array.isArray(args.fields)
      ? args.fields.join(",")
      : String(args.fields);
    params.set("fields", fieldsString);
  }

  const queryString = params.toString();
  return `${TOOLS_SERVICE_URL}${path}${queryString ? `?${queryString}` : ""}`;
}

export const ARG_REMAPS: Record<string, Record<string, string>> = {
  search_events: { query: "q" },
  search_products: { query: "q" },
};

async function executeToolGeneric(
  name: string,
  args: Record<string, unknown> = {},
  context: ToolExecutionContext = {},
) {
  const schema = toolMap.get(name);
  if (!schema || !schema.endpoint) {
    return { error: `Unknown tool: ${name}` };
  }

  const remaps = ARG_REMAPS[name as keyof typeof ARG_REMAPS];
  let resolvedArgs: Record<string, unknown> = args;
  if (remaps) {
    resolvedArgs = { ...args };
    for (const [from, to] of Object.entries(remaps)) {
      if (resolvedArgs[from] !== undefined) {
        resolvedArgs[to] = resolvedArgs[from];
        delete resolvedArgs[from];
      }
    }
  }

  // Build caller-context headers for tools-api telemetry
  const contextHeaders = buildContextHeaders(context);

  // Body-carrying methods send args as JSON body
  const bodyMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (schema.endpoint.method && bodyMethods.has(schema.endpoint.method)) {
    const url = buildUrlFromEndpoint(schema.endpoint, resolvedArgs).split(
      "?",
    )[0];
    // Inject trusted session context into body — the model's args never
    // include these fields (they're stripped from schemas), so they can
    // only come from the orchestrator's session context.
    const body: Record<string, unknown> = { ...resolvedArgs };
    if (context.project) body.project = context.project;
    if (context.agent) body.agent = context.agent;
    if (context.username) body.username = context.username;

    // Worktree path rewriting — redirect file paths to the worktree directory
    // when the session has an active worktree.
    if (context.agentConversationId && activeWorktrees.has(context.agentConversationId)) {
      const worktreeState = activeWorktrees.get(context.agentConversationId)!;
      const rewritePath = (provider: unknown): unknown => {
        if (typeof provider !== "string") return provider;
        if (provider.startsWith(worktreeState.originalRoot)) {
          return (
            worktreeState.worktreePath +
            provider.slice(worktreeState.originalRoot.length)
          );
        }
        return provider;
      };

      // Rewrite common path fields used by file/git/shell tools
      if (body.path) body.path = rewritePath(body.path);
      if (body.filePath) body.filePath = rewritePath(body.filePath);
      if (body.oldPath) body.oldPath = rewritePath(body.oldPath);
      if (body.newPath) body.newPath = rewritePath(body.newPath);
      if (body.cwd) body.cwd = rewritePath(body.cwd);
      if (body.directory) body.directory = rewritePath(body.directory);

      // Inject workspace override header so tools-api sandbox validation passes
      contextHeaders["X-Workspace-Override"] = worktreeState.worktreePath;
    }

    return fetchJsonWithBody(
      url,
      schema.endpoint.method,
      body,
      contextHeaders,
      context.signal,
    );
  }

  const url = buildUrlFromEndpoint(schema.endpoint, resolvedArgs);
  return fetchJson(url, contextHeaders, context.signal);
}

/**
 * Build X-context headers from the caller context object.
 * These are consumed by tools-api's ToolCallLoggerMiddleware.

 */
function buildContextHeaders(
  context: ToolExecutionContext = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (context.project) headers["X-Project"] = context.project;
  if (context.username) headers["X-Username"] = context.username;
  if (context.agent) headers["X-Agent"] = context.agent;
  if (context.requestId) headers["X-Request-Id"] = context.requestId;
  if (context.traceId) headers["X-Trace-Id"] = context.traceId;
  if (context.agentConversationId)
    headers["X-Agent-Conversation-Id"] = context.agentConversationId;
  if (context.conversationId)
    headers["X-Conversation-Id"] = context.conversationId;
  if (context.iteration !== undefined && context.iteration !== null)
    headers["X-Iteration"] = String(context.iteration);
  // Multi-workspace: when the user has selected a non-default workspace root,
  // send it to tools-api so file/git/shell tools resolve within it.
  if (context.workspaceRoot)
    headers["X-Workspace-Root"] = context.workspaceRoot;
  if (context.enabledTools && Array.isArray(context.enabledTools)) {
    headers["X-Enabled-Tools"] = context.enabledTools.join(",");
  }
  if (context._providerName) headers["X-Provider"] = context._providerName;
  if (context._resolvedModel) headers["X-Model"] = context._resolvedModel;
  return headers;
}

async function fetchJson(
  url: string,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(url, {
      headers: { ...extraHeaders },
      ...(signal && { signal }),
    });
    if (!response.ok) {
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        return {
          error:
            errorBody.error ||
            `API returned ${response.status}: ${response.statusText}`,
        };
      } catch {
        return {
          error: `API returned ${response.status}: ${response.statusText}`,
        };
      }
    }
    return await response.json();
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return { error: "Tool execution aborted" };
    }
    return { error: `Failed to reach API: ${getErrorMessage(error)}` };
  }
}

async function fetchJsonWithBody(
  url: string,
  method: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      ...(signal && { signal }),
    });
    if (!response.ok) {
      // Forward the actual error body from tools-api for debugging
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        return {
          error:
            errorBody.error ||
            `API returned ${response.status}: ${response.statusText}`,
        };
      } catch {
        return {
          error: `API returned ${response.status}: ${response.statusText}`,
        };
      }
    }
    return await response.json();
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return { error: "Tool execution aborted" };
    }
    return { error: `Failed to reach API: ${getErrorMessage(error)}` };
  }
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// Orchestrator Tool Schemas — Prism-local, not routed to tools-api
// ────────────────────────────────────────────────────────────

/**
 * Dynamically builds the `agent` parameter description for the
 * create_team schema by reading all registered persona IDs from
 * the AgentPersonaRegistry. This avoids hard-coding persona names
 * like "Lupos" or "Coding" which caused the LLM to misuse the field.
 */
function buildAgentParameterDescription(locale?: string): string {
  const activeLocale = locale || PromptLocaleService.getDefaultLocale();
  const registeredAgents = AgentPersonaRegistry.list();
  const agentNames = registeredAgents
    .map((entry) => `'${entry.name}'`)
    .join(", ");

  if (agentNames) {
    return PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.memberAgent", {
      agentNames,
    });
  }

  return PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.memberAgentDefault");
}

function getOrchestratorToolSchemas(
  defaultTopology: string = DEFAULT_TOPOLOGY,
  locale?: string,
) {
  const activeLocale = locale || PromptLocaleService.getDefaultLocale();

  const normalizedTopology =
    defaultTopology === TOPOLOGIES.PEER_TO_PEER
      ? TOPOLOGIES.PEER_TO_PEER
      : defaultTopology === TOPOLOGIES.SEQUENTIAL
        ? TOPOLOGIES.SEQUENTIAL
        : defaultTopology === TOPOLOGIES.HIERARCHICAL_AGGREGATION
          ? TOPOLOGIES.HIERARCHICAL_AGGREGATION
          : TOPOLOGIES.HIERARCHICAL;

  const isHierarchical = normalizedTopology === TOPOLOGIES.HIERARCHICAL;
  const isHierarchicalAggregation = normalizedTopology === TOPOLOGIES.HIERARCHICAL_AGGREGATION;
  const isSequential = normalizedTopology === TOPOLOGIES.SEQUENTIAL;
  const isPeerToPeer = normalizedTopology === TOPOLOGIES.PEER_TO_PEER;

  const hierarchicalLabel = isHierarchical
    ? `${TOPOLOGIES.HIERARCHICAL} (default)`
    : TOPOLOGIES.HIERARCHICAL;
  const hierarchicalAggregationLabel = isHierarchicalAggregation
    ? `${TOPOLOGIES.HIERARCHICAL_AGGREGATION} (default)`
    : TOPOLOGIES.HIERARCHICAL_AGGREGATION;
  const sequentialLabel = isSequential
    ? `${TOPOLOGIES.SEQUENTIAL} (default)`
    : TOPOLOGIES.SEQUENTIAL;
  const peerToPeerLabel = isPeerToPeer
    ? `${TOPOLOGIES.PEER_TO_PEER} (default)`
    : TOPOLOGIES.PEER_TO_PEER;
  const tournamentLabel = defaultTopology === TOPOLOGIES.TOURNAMENT
    ? `${TOPOLOGIES.TOURNAMENT} (default)`
    : TOPOLOGIES.TOURNAMENT;
  const criticLoopLabel = defaultTopology === TOPOLOGIES.CRITIC_LOOP
    ? `${TOPOLOGIES.CRITIC_LOOP} (default)`
    : TOPOLOGIES.CRITIC_LOOP;
  const divideAndConquerLabel = defaultTopology === TOPOLOGIES.DIVIDE_AND_CONQUER
    ? `${TOPOLOGIES.DIVIDE_AND_CONQUER} (default)`
    : TOPOLOGIES.DIVIDE_AND_CONQUER;
  const mctsLabel = defaultTopology === TOPOLOGIES.MCTS
    ? `${TOPOLOGIES.MCTS} (default)`
    : TOPOLOGIES.MCTS;

  const hierarchicalDesc = isHierarchical
    ? "'hierarchical' (default)"
    : "'hierarchical'";
  const hierarchicalAggregationDesc = isHierarchicalAggregation
    ? "'hierarchical_aggregation' (default)"
    : "'hierarchical_aggregation'";
  const sequentialDesc = isSequential
    ? "'sequential' (default)"
    : "'sequential'";
  const peerToPeerDesc = isPeerToPeer
    ? "'peer_to_peer' (default)"
    : "'peer_to_peer'";
  const tournamentDesc = defaultTopology === TOPOLOGIES.TOURNAMENT
    ? "'tournament' (default)"
    : "'tournament'";
  const criticLoopDesc = defaultTopology === TOPOLOGIES.CRITIC_LOOP
    ? "'critic_loop' (default)"
    : "'critic_loop'";
  const divideAndConquerDesc = defaultTopology === TOPOLOGIES.DIVIDE_AND_CONQUER
    ? "'divide_and_conquer' (default)"
    : "'divide_and_conquer'";
  const mctsDesc = defaultTopology === TOPOLOGIES.MCTS
    ? "'mcts' (default)"
    : "'mcts'";

  return [
    {
      name: TOOL_NAMES.CREATE_TEAM,
      emoji: ["👥", "🤖"],
      description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.description", {
        hierarchicalDesc,
        hierarchicalAggregationDesc,
        sequentialDesc,
        peerToPeerDesc,
        tournamentDesc,
        criticLoopDesc,
        divideAndConquerDesc,
        mctsDesc,
      }),
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.name"),
          },
          topology: {
            type: "string",
            enum: [
              TOPOLOGIES.HIERARCHICAL,
              TOPOLOGIES.HIERARCHICAL_AGGREGATION,
              TOPOLOGIES.SEQUENTIAL,
              TOPOLOGIES.PEER_TO_PEER,
              TOPOLOGIES.TOURNAMENT,
              TOPOLOGIES.CRITIC_LOOP,
              TOPOLOGIES.DIVIDE_AND_CONQUER,
              TOPOLOGIES.MCTS,
            ],
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.topology", {
              hierarchicalLabel,
              hierarchicalAggregationLabel,
              sequentialLabel,
              peerToPeerLabel,
              tournamentLabel,
              criticLoopLabel,
              divideAndConquerLabel,
              mctsLabel,
            }),
          },
          topologyConfig: {
            type: "object",
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.topologyConfig"),
            properties: {
              actorCount: {
                type: "integer",
                description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.actorCount"),
              },
              maxRounds: {
                type: "integer",
                description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.maxRounds"),
              },
              branchFactor: {
                type: "integer",
                description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.branchFactor"),
              },
              maxDepth: {
                type: "integer",
                description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.maxDepth"),
              },
              maxSubtasks: {
                type: "integer",
                description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.maxSubtasks"),
              },
            },
          },
          members: {
            type: "array",
            maxItems: 10,
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.members"),
            items: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.memberDescription"),
                },
                prompt: {
                  type: "string",
                  description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.memberPrompt"),
                },
                files: {
                  type: "array",
                  items: { type: "string" },
                  description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.memberFiles"),
                },
                model: {
                  type: "string",
                  description: PromptLocaleService.get(activeLocale, "orchestrator.tools.create_team.parameters.memberModel"),
                },
                agent: {
                  type: "string",
                  description: buildAgentParameterDescription(activeLocale),
                },
              },
              required: ["description", "prompt"],
            },
          },
        },
        required: ["name", "members"],
      },
    },
    {
      name: TOOL_NAMES.SEND_MESSAGE,
      emoji: ["💬", "📤"],
      description: PromptLocaleService.get(activeLocale, "orchestrator.tools.send_message.description"),
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.send_message.parameters.to"),
          },
          message: {
            type: "string",
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.send_message.parameters.message"),
          },
        },
        required: ["to", "message"],
      },
    },
    {
      name: TOOL_NAMES.STOP_AGENT,
      emoji: ["⏹️", "🤖"],
      description: PromptLocaleService.get(activeLocale, "orchestrator.tools.stop_agent.description"),
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.stop_agent.parameters.agent_id"),
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: TOOL_NAMES.GET_TASK_OUTPUT,
      emoji: ["📥", "🤖"],
      description: PromptLocaleService.get(activeLocale, "orchestrator.tools.get_task_output.description"),
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.get_task_output.parameters.agent_id"),
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: TOOL_NAMES.DELETE_TEAM,
      emoji: ["🗑️", "👥"],
      description: PromptLocaleService.get(activeLocale, "orchestrator.tools.delete_team.description"),
      parameters: {
        type: "object",
        properties: {
          teamName: {
            type: "string",
            description: PromptLocaleService.get(activeLocale, "orchestrator.tools.delete_team.parameters.teamName"),
          },
        },
        required: ["teamName"],
      },
    },
  ];
}

export default class ToolOrchestratorService {
  /**
   * Ensure tool schemas are loaded from tools-api.
   * No-op if already initialized; fetches on-demand otherwise.
   * Eliminates boot-order dependency between prism and tools-api.
   */
  static async ensureSchemas(locale?: string) {
    if (!initialized && Date.now() - lastFetchAttemptTime > 30000) {
      logger.info("[ToolOrchestrator] Schemas not loaded — fetching on-demand");
      await fetchSchemas();
    }
    if (locale && locale !== "en" && !localizedClientSchemasCache.has(locale)) {
      await fetchSchemasForLocale(locale);
    }
  }

  /** AI-clean schemas (no endpoint/domain/dataSource) — for LLM tool arrays */
  static getToolSchemas(defaultTopology?: string, locale?: string) {
    const creativeSettings = SettingsService.getCached().creative;
    const textToSpeechProvider =
      creativeSettings?.textToSpeechProvider || "elevenlabs";
    const textToSpeechModel = creativeSettings?.textToSpeechModel || "";

    const localeAISchemas = (locale && locale !== "en" && localizedAISchemasCache.has(locale))
      ? localizedAISchemasCache.get(locale)!
      : cachedAISchemas;

    const resolvedSchemas = localeAISchemas.map((schema) => {
      if (schema.name !== "synthesize_speech") return schema;

      const parameters = schema.parameters as
        | Record<string, unknown>
        | undefined;
      const properties = parameters?.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const voiceDescription = properties?.voice?.description as
        | string
        | undefined;

      if (
        !voiceDescription ||
        !voiceDescription.includes(TTS_VOICE_CATALOG_PLACEHOLDER)
      ) {
        return schema;
      }

      return {
        ...schema,
        parameters: {
          ...parameters,
          properties: {
            ...properties,
            voice: {
              ...properties!.voice,
              description: injectVoiceCatalog(
                voiceDescription,
                textToSpeechProvider,
                textToSpeechModel,
              ),
            },
          },
        },
      };
    });

    const activeLocale = locale
      || (typeof SettingsService.getCached === "function"
        ? SettingsService.getCached().agents?.locale || "en"
        : "en");

    return [
      ...resolvedSchemas,

      ...getOrchestratorToolSchemas(defaultTopology, activeLocale),
    ];
  }

  /** Client-facing schemas (with domain/domainKey/dataSource, no endpoint) — for Prism Client UI */
  static getClientToolSchemas(defaultTopology?: string, locale?: string): ToolSchemaFull[] {
    if (isResolvingClientSchemas) {
      // Break recursion cycle when internal tool getters
      return cachedClientSchemas;
    }
    isResolvingClientSchemas = true;
    try {
      // Reverse map: display name → domainKey (e.g. "Core Harness Tools" → "core_harness")
      const domainDisplayNameToKey = new Map<string, string>();
      for (const entry of Object.values(DOMAINS)) {
        if (!domainDisplayNameToKey.has(entry.displayName)) {
          domainDisplayNameToKey.set(entry.displayName, entry.key);
        }
      }
      const resolveDomainKey = (domain: string) =>
        domainDisplayNameToKey.get(domain) ||
        domain
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");

      const activeLocale = locale
        || (typeof SettingsService.getCached === "function"
          ? SettingsService.getCached().agents?.locale || "en"
          : "en");

      // Orchestrator tools are Prism-local — add domain metadata for UI grouping
      const orchestratorClient = getOrchestratorToolSchemas(
        defaultTopology,
        activeLocale,
      ).map((tool) => ({
        ...tool,
        domain: DOMAINS.CORE_ORCHESTRATOR.displayName,
        domainKey: "core_orchestrator",
        system: true,
      }));
      cachedClientSchemas.push(...orchestratorClient);



      const localeClientSchemas = (activeLocale && activeLocale !== "en" && localizedClientSchemasCache.has(activeLocale))
        ? localizedClientSchemasCache.get(activeLocale)!
        : cachedClientSchemas;

      const clientSchemasEnriched = localeClientSchemas.map((tool) => ({
        ...tool,
        domainKey:
          (tool.domainKey as string) ||
          resolveDomainKey(tool.domain || "Other"),
        system: isCoreDomain(tool.domain || ""),
        ...(TOOL_INPUT_MODALITIES[tool.name] && {
          inputModalities: [...TOOL_INPUT_MODALITIES[tool.name]],
        }),
      }));

      const mcpClient = ToolOrchestratorService.getMCPToolSchemas().map(
        (tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          domain: tool.domain || `Model Context Protocol: ${tool._mcpServer}`,
          domainKey: "mcp",
          system: false,
        }),
      );

      return [
        ...clientSchemasEnriched,
        ...orchestratorClient,

      ];
    } finally {
      isResolvingClientSchemas = false;
    }
  }

  /** Workspace root paths from tools-api (single source of truth) */
  static getWorkspaceRoots() {
    return cachedWorkspaceRoots;
  }

  /** Primary workspace root (first entry) */
  static getWorkspaceRoot() {
    return cachedWorkspaceRoots[0] || null;
  }

  /** Static roots from config.js (immutable, for "pinned" UI distinction) */
  static getStaticRoots() {
    return [...cachedStaticRoots];
  }

  /**
   * Check if any workspace agent is currently connected to tools-api.
   * Mirrors the same `/admin/config` → `agents[].roots` check used by
   * `GET /workspaces` to set `isAgentServed` on the client.
   */
  static async isWorkspaceAgentConnected(): Promise<boolean> {
    try {
      const configResponse = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!configResponse.ok) return false;
      const config = (await configResponse.json()) as ToolsApiConfig & {
        agents?: { roots?: string[] }[];
      };
      const agents = config.agents || [];
      for (const agent of agents) {
        if (agent.roots && agent.roots.length > 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Re-fetch workspace roots from tools-api config */
  static async refreshWorkspaceRoots() {
    try {
      const configResponse = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MS),
      });
      if (configResponse.ok) {
        const config = (await configResponse.json()) as ToolsApiConfig;
        if (Array.isArray(config.workspaceRoots)) {
          cachedWorkspaceRoots = config.workspaceRoots;
        }
        if (Array.isArray(config.staticRoots)) {
          cachedStaticRoots = config.staticRoots;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        `[ToolOrchestrator] refreshWorkspaceRoots failed: ${getErrorMessage(error)}`,
      );
    }
  }
  static async updateWorkspaceRoots(roots: string[]) {
    const response = await fetch(
      `${TOOLS_SERVICE_URL}/admin/config/workspaces`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roots }),
        signal: AbortSignal.timeout(TOOL_WORKSPACE_UPDATE_TIMEOUT_MS),
      },
    );
    const result = (await response.json()) as ToolsApiConfig & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(result.error || "Failed to update workspace roots");

    // Refresh local cache
    if (Array.isArray(result.workspaceRoots)) {
      cachedWorkspaceRoots = result.workspaceRoots;
    }
    if (Array.isArray(result.staticRoots)) {
      cachedStaticRoots = result.staticRoots;
    }
    return result;
  }
  static async validateWorkspacePath(path: string) {
    const response = await fetch(
      `${TOOLS_SERVICE_URL}/admin/config/workspaces/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(TOOL_WORKSPACE_VALIDATE_TIMEOUT_MS),
      },
    );
    return response.json();
  }

  /**
   * Get the effective workspace root for a session.
   * Returns the worktree path if the session is in an isolated worktree,
   * or the normal workspace root otherwise.


   */
  static getEffectiveWorkspaceRoot(agentConversationId: string | null | undefined) {
    if (agentConversationId && activeWorktrees.has(agentConversationId)) {
      return activeWorktrees.get(agentConversationId)!.worktreePath;
    }
    return cachedWorkspaceRoots[0] || null;
  }
  static getWorktreeState(agentConversationId: string | null | undefined) {
    if (!agentConversationId) return null;
    return activeWorktrees.get(agentConversationId) || null;
  }

  static getToolEmoji(toolName: string): string | null {
    const schema = toolMap.get(toolName);
    if (schema?.emoji) return schema.emoji as string;

    // Check internal / orchestrator tools
    const localEmojis: Record<string, string | [string, string]> = {
      enter_plan_mode: ["📝", "🧠"],
      exit_plan_mode: ["🚀", "🧠"],
      create_skill: ["🪄", "🛠️"],
      execute_skill: ["⚡", "🪄"],
      list_skills: ["📋", "🪄"],
      delete_skill: ["🗑️", "🪄"],
      enter_worktree: ["🌳", "💻"],
      exit_worktree: ["🚪", "🌳"],
      write_todo: ["📝", "📌"],
      summarize_conversation: ["💬", "📝"],
      ask_user: ["💬", "❓"],
      list_mcp_resources: ["🔌", "📋"],
      read_mcp_resource: ["🔌", "📄"],
      authenticate_mcp_server: ["🔌", "🔐"],
      set_timer: ["⏰", "⏳"],
      list_timers: ["⏱️", "📋"],
      cancel_timer: ["⏰", "❌"],
      create_cron_job: ["📅", "🔔"],
      list_cron_jobs: ["📅", "📋"],
      delete_cron_job: ["📅", "❌"],
      create_team: ["👥", "🤖"],
      send_message: ["💬", "📤"],
      stop_agent: ["⏹️", "🤖"],
      get_task_output: ["📥", "🤖"],
      delete_team: ["🗑️", "👥"],
    };
    const emojiValue = localEmojis[toolName];
    if (emojiValue) {
      if (Array.isArray(emojiValue)) {
        return emojiValue[0];
      }
      return emojiValue;
    }
    return null;
  }

  static getToolFields(toolName: string) {
    const tool = cachedAISchemas.find((tool) => tool.name === toolName);
    if (!tool) return null;
    const params = tool.parameters as Record<string, unknown> | undefined;
    const props = params?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    return (props?.fields?.items as Record<string, unknown>)?.enum || null;
  }

  static async checkApiHealth() {
    const toolNames = cachedSchemas.map((tool) => tool.name);

    let online = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        TOOL_API_HEALTH_TIMEOUT_MS,
      );
      const response = await fetch(`${TOOLS_SERVICE_URL}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      online = response.ok;
    } catch {
      online = false;
    }

    const apiStatus = { [TOOLS_SERVICE_URL as string]: online };

    const offline = new Set();
    if (!online) {
      for (const name of toolNames) {
        offline.add(name);
      }
    }

    return { offline, apiStatus };
  }

  static async refreshSchemas() {
    await fetchSchemas();
    return cachedSchemas.length;
  }

  static isInitialized() {
    return initialized;
  }

  static async executeTool(
    name: string,
    args: Record<string, unknown> = {},
    context: ToolExecutionContext = {},
  ) {
    // Validate if the tool is allowed for this conversation session
    const { PrismProxyService } = await import("./prism/PrismProxyService.js");
    if (context.conversationId && !PrismProxyService.isToolAllowed(context.conversationId, name)) {
      logger.warn(
        `[ToolOrchestrator] Blocked execution of disallowed tool "${name}" for conversation ${context.conversationId}`
      );
      return { error: `Execution of tool "${name}" is not allowed in this agent session.` };
    }

    // Route orchestrator tools to OrchestratorService (Prism-local)
    if (ORCHESTRATOR_ONLY_TOOLS.includes(name)) {
      return ToolOrchestratorService.executeOrchestratorTool(
        name,
        args,
        context,
      );
    }

    // Route this service's own MCP-namespaced local catalog (widget /
    // html_notes / canvas tools) through the LocalToolRouter.
    if (name.startsWith("mcp__")) {
      return ToolOrchestratorService.executeMCPTool(name, args, context);
    }





    // Inject reference images from conversation context into generate_image args.
    // The tools-api endpoint needs these as explicit args since it doesn't have
    // access to Prism's conversation messages.
    // IMPORTANT: Only extract from the LAST user message to avoid collecting
    // stale images from conversation history.
    if (name === TOOL_NAMES.GENERATE_IMAGE && context.messages) {
      const referenceImages: string[] = [];
      // Find the last user message with images
      for (let i = context.messages.length - 1; i >= 0; i--) {
        const message = context.messages[i];
        if (
          message.role === "user" &&
          message.images &&
          Array.isArray(message.images) &&
          message.images.length > 0
        ) {
          logger.info(
            `[ToolOrchestrator] generate_image: found ${message.images.length} image(s) on last user message`,
          );
          for (const image of message.images) {
            if (
              typeof image === "string" &&
              (image.startsWith("http://") || image.startsWith("https://"))
            ) {
              referenceImages.push(image);
              logger.info(
                `[ToolOrchestrator] generate_image: accepted HTTP image ref (${image.substring(0, 80)}...)`,
              );
            } else if (typeof image === "string" && image.startsWith("data:")) {
              // Accept base64 data URLs — the /creative route supports up to 50MB bodies.
              // Discord avatars and user-attached images are typically well under 5MB.
              referenceImages.push(image);
              logger.info(
                `[ToolOrchestrator] generate_image: accepted base64 data URL (${(image.length / 1024).toFixed(0)} KB)`,
              );
            } else {
              logger.warn(
                `[ToolOrchestrator] generate_image: REJECTED image ref (type=${typeof image}, prefix=${String(image).substring(0, 30)})`,
              );
            }
          }
          break; // Only check the last user message
        }
      }
      if (referenceImages.length > 0) {
        args = { ...args, referenceImages };
        logger.info(
          `[ToolOrchestrator] generate_image: injecting ${referenceImages.length} reference image(s) into tool args`,
        );
      } else {
        logger.info(
          `[ToolOrchestrator] generate_image: no reference images found in conversation`,
        );
      }
    }

    // Inject the actual image from conversation context into image-consuming tools.
    // Models cannot reliably reproduce base64 data in tool arguments — they truncate it,
    // producing corrupt image buffers. Extract the real image from the last user message
    // and set it as the `input` arg so the tools-service receives valid data.
    const IMAGE_INPUT_TOOLS: string[] = [
      TOOL_NAMES.CONVERT_IMAGE_TO_ASCII,
      TOOL_NAMES.MANIPULATE_IMAGE,
    ];
    if (IMAGE_INPUT_TOOLS.includes(name) && context.messages) {
      for (let i = context.messages.length - 1; i >= 0; i--) {
        const message = context.messages[i];
        if (
          message.role === "user" &&
          message.images &&
          Array.isArray(message.images) &&
          message.images.length > 0
        ) {
          const firstImage = message.images[0];
          if (
            typeof firstImage === "string" &&
            (firstImage.startsWith("http") || firstImage.startsWith("data:"))
          ) {
            logger.info(
              `[ToolOrchestrator] ${name}: injecting conversation image as 'input' (${firstImage.startsWith("data:") ? `${(firstImage.length / 1024).toFixed(0)} KB base64` : firstImage.substring(0, 80)})`,
            );
            args = { ...args, input: firstImage };
          }
          break;
        }
      }
    }

    // Inject the user's attached image as a texture URL or default image URL.
    // Models cannot reproduce base64 data in tool arguments — they see the image in
    // conversation context but have no mechanism to pass it into the deeply-nested
    // properties. Resolve the image to a browser-loadable data URL
    // and inject it as a top-level reference argument.
    const THREE_DIMENSIONAL_TEXTURE_TOOLS = [
      "create_3d_model",
      "create_3d_scene",
    ];
    const VECTOR_ANIMATION_TOOLS = ["create_vector_animation"];
    const isThreeDimensionalTextureTool =
      THREE_DIMENSIONAL_TEXTURE_TOOLS.includes(name);
    const isVectorAnimationTool = VECTOR_ANIMATION_TOOLS.includes(name);

    if (
      (isThreeDimensionalTextureTool || isVectorAnimationTool) &&
      context.messages
    ) {
      for (
        let messageIndex = context.messages.length - 1;
        messageIndex >= 0;
        messageIndex--
      ) {
        const message = context.messages[messageIndex];
        if (
          message.role === "user" &&
          message.images &&
          Array.isArray(message.images) &&
          message.images.length > 0
        ) {
          const imageReference = message.images[0];
          if (typeof imageReference === "string") {
            let resolvedImageUrl: string | null = null;

            if (imageReference.startsWith("data:")) {
              resolvedImageUrl = imageReference;
              logger.info(
                `[ToolOrchestrator] ${name}: using data URL as image (${(imageReference.length / 1024).toFixed(0)} KB)`,
              );
            } else if (imageReference.startsWith("minio://")) {
              try {
                const FileService = (await import("./FileService.js")).default;
                const key = FileService.extractKey(imageReference);
                const file = await FileService.getFile(key);
                if (file) {
                  const chunks: Buffer[] = [];
                  for await (const chunk of file.stream) {
                    chunks.push(chunk);
                  }
                  const buffer = Buffer.concat(chunks);
                  const base64 = buffer.toString("base64");
                  resolvedImageUrl = `data:${file.contentType};base64,${base64}`;
                  logger.info(
                    `[ToolOrchestrator] ${name}: resolved minio ref to data URL image (${(resolvedImageUrl.length / 1024).toFixed(0)} KB)`,
                  );
                }
              } catch (error: unknown) {
                logger.warn(
                  `[ToolOrchestrator] ${name}: failed to resolve minio image: ${getErrorMessage(error)}`,
                );
              }
            } else if (
              imageReference.startsWith("http://") ||
              imageReference.startsWith("https://")
            ) {
              resolvedImageUrl = imageReference;
              logger.info(
                `[ToolOrchestrator] ${name}: using HTTP URL as image (${imageReference.substring(0, 80)})`,
              );
            }

            if (resolvedImageUrl) {
              if (isThreeDimensionalTextureTool) {
                args = { ...args, referenceTextureUrl: resolvedImageUrl };
                logger.info(
                  `[ToolOrchestrator] ${name}: injected referenceTextureUrl into tool args`,
                );
              } else if (isVectorAnimationTool) {
                args = { ...args, referenceImageUrl: resolvedImageUrl };
                logger.info(
                  `[ToolOrchestrator] ${name}: injected referenceImageUrl into tool args`,
                );
              }
            }
          }
          break;
        }
      }
    }

    const result = await executeToolGeneric(name, args, context);

    // Post-process: upload generated images to MinIO
    const imageResult = result as GenerateImageToolResult;
    if (
      name === TOOL_NAMES.GENERATE_IMAGE &&
      imageResult.image &&
      !imageResult.error
    ) {
      try {
        const FileService = (await import("./FileService.js")).default;
        const image = imageResult.image;
        const dataUrl = `data:${image.mimeType || "image/png"};base64,${image.data}`;
        const { ref } = await FileService.uploadFile(
          dataUrl,
          FILE_CATEGORIES.GENERATIONS,
          context.project || null,
          context.username || null,
        );
        image.minioRef = ref;
      } catch (error: unknown) {
        logger.warn(
          `[ToolOrchestrator] Image MinIO upload failed: ${getErrorMessage(error)}`,
        );
      }
    }

    // Post-process: upload browser screenshots to MinIO
    const browserResult = result as BrowserActionToolResult;
    if (
      name === TOOL_NAMES.BROWSER_ACTION &&
      browserResult.screenshot &&
      !browserResult.error
    ) {
      try {
        const FileService = (await import("./FileService.js")).default;
        const dataUrl = `data:${browserResult.mimeType || "image/png"};base64,${browserResult.screenshot}`;
        const { ref } = await FileService.uploadFile(
          dataUrl,
          FILE_CATEGORIES.SCREENSHOTS,
          context.project || null,
          context.username || null,
        );
        browserResult.screenshotRef = ref;
        delete browserResult.screenshot;
      } catch (error: unknown) {
        logger.warn(
          `[ToolOrchestrator] Screenshot MinIO upload failed: ${getErrorMessage(error)}`,
        );
      }
    }

    return result;
  }

  /**
   * Execute a orchestrator tool (create_team, send_message, stop_agent).
   * These are Prism-local — they dispatch to OrchestratorService in-process.
   */
  static async executeOrchestratorTool(
    name: string,
    args: Record<string, unknown> = {},
    context: ToolExecutionContext = {},
  ) {
    const { default: OrchestratorService } =
      await import("./OrchestratorService.js");

    // Build orchestratorContext from the loop's context
    const orchestratorContext = {
      project: context.project,
      username: context.username,
      agent: context.agent,
      providerName: context._providerName,
      resolvedModel: context._resolvedModel,
      agentConversationId: context.agentConversationId,
      conversationId: context.conversationId,
      traceId: context.traceId,
      workspaceRoot: context.workspaceRoot || null,

      // Pass the parent's emit so sub-agents can forward live events
      emit: context._emit || null,

      // User-configured max iterations for sub-agents
      maxSubAgentIterations: context._maxSubAgentIterations,

      // Inherit context window size so sub-agents load with the same context
      minContextLength: context._minContextLength,

      // Inherit the exact list of tools enabled in the parent context
      enabledTools: context.enabledTools || null,

      // Topology to use for sub-agent coordination
      topology: context._topology || null,

      // Recursive spawning depth tracking — propagated from parent context
      recursionDepth: context._recursionDepth ?? 0,
      maxRecursionDepth: context._maxRecursionDepth,

      // Inherit parent's thinking/reasoning settings so sub-agents use the same mode
      thinkingEnabled: context._thinkingEnabled,
      reasoningEffort: context._reasoningEffort,
      thinkingBudget: context._thinkingBudget,
    };

    switch (name) {
      case TOOL_NAMES.CREATE_TEAM:
        return OrchestratorService.createTeam(
          args as { name: string; members: TeamMember[]; topology?: string },
          orchestratorContext as OrchestratorContext,
        );

      case TOOL_NAMES.SEND_MESSAGE:
        return OrchestratorService.sendMessage(
          args.to as string,
          args.message as string,
          orchestratorContext as OrchestratorContext,
        );

      case TOOL_NAMES.STOP_AGENT:
        return OrchestratorService.stopAgent(args.agent_id as string);

      case TOOL_NAMES.GET_TASK_OUTPUT:
        return OrchestratorService.getTaskOutput(args.agent_id as string);

      case TOOL_NAMES.DELETE_TEAM:
        return OrchestratorService.deleteTeam(
          args.teamName as string,
          orchestratorContext as OrchestratorContext,
        );

      default:
        return { error: `Unknown orchestrator tool: ${name}` };
    }
  }

  /**
   * Execute a tool from this service's own local catalog, addressed by its
   * MCP-namespaced name (mcp__lazy-tool-service__<tool>). No MCP transport
   * is involved — the LocalToolRouter routes widget / html_notes / canvas
   * tools to HTML-Notes and everything else to the Python bridge.
   */
  static async executeMCPTool(
    fullName: string,
    args: Record<string, unknown> = {},
    context: ToolExecutionContext = {},
  ) {
    if (!fullName.startsWith(LOCAL_MCP_PREFIX)) {
      return { error: `MCP server for tool "${fullName}" is not connected. Only ${LOCAL_MCP_PREFIX}* tools are available.` };
    }
    const { routeLocalTool } = await import("./LocalToolRouter.js");
    try {
      return await routeLocalTool(fullName, args, {
        agentName: context.agent || context.username || undefined,
        cycleId:
          context.agentConversationId || context.conversationId || undefined,
      });
    } catch (error: unknown) {
      return { error: getErrorMessage(error) };
    }
  }

  /**
   * Expose the HTML-Notes-facing subset of the local tool_schemas.json
   * catalog under the mcp__lazy-tool-service__ namespace, so clients like
   * HTML-Notes can enable them by their namespaced names on /agent.
   * Scoped to widget/canvas/notes tools — trading tools stay off the
   * agent pool (they are served via /execute and the MCP SSE server).
   */
  static getMCPToolSchemas(): Array<{
    name: string;
    description?: string;
    parameters?: unknown;
    domain?: string;
    _mcpServer?: string;
    _mcpOriginalName?: string;
  }> {
    if (cachedLocalMcpSchemas) return cachedLocalMcpSchemas;
    try {
      const raw = readFileSync(
        pathResolve(process.cwd(), "tool_schemas.json"),
        "utf-8",
      );
      const catalog = JSON.parse(raw) as Array<{
        name: string;
        description?: string;
        parameters?: unknown;
        domain?: string;
      }>;
      const WIDGET_TOOLS = new Set([
        "create_widget",
        "update_widget",
        "validate_widget_html",
        "list_widget_types",
        "plan_widget",
      ]);
      cachedLocalMcpSchemas = catalog
        .filter(
          (tool) =>
            WIDGET_TOOLS.has(tool.name) ||
            tool.name.startsWith("html_notes_") ||
            tool.name.startsWith("canvas_") ||
            tool.name === "render_component",
        )
        .map((tool) => ({
          name: `${LOCAL_MCP_PREFIX}${tool.name}`,
          description: tool.description,
          parameters: tool.parameters,
          domain: tool.domain || "HTML Notes",
          _mcpServer: "lazy-tool-service",
          _mcpOriginalName: tool.name,
        }));
      logger.info(
        `[ToolOrchestrator] Loaded ${cachedLocalMcpSchemas.length} local MCP tool schemas (${LOCAL_MCP_PREFIX}*)`,
      );
    } catch (error: unknown) {
      logger.error(
        `[ToolOrchestrator] Failed to load local MCP tool schemas: ${getErrorMessage(error)}`,
      );
      cachedLocalMcpSchemas = [];
    }
    return cachedLocalMcpSchemas;
  }


  /**
   * Map of tool names to their streaming SSE endpoint paths.
   * Only process-based tools that spawn subprocesses benefit from streaming.
   */
  static STREAMABLE_TOOLS: Record<string, string> = {
    [TOOL_NAMES.EXECUTE_SHELL]: "/compute/shell/stream",
    [TOOL_NAMES.EXECUTE_PYTHON]: "/utility/python/stream",
    [TOOL_NAMES.EXECUTE_JAVASCRIPT]: "/compute/js/stream",
    [TOOL_NAMES.RUN_COMMAND]: "/agentic/command/stream",
  };

  static isStreamable(toolName: string) {
    return toolName in ToolOrchestratorService.STREAMABLE_TOOLS;
  }

  /**
   * Execute a tool using the streaming SSE endpoint.
   * Calls `onChunk(event, data)` for each stdout/stderr chunk.
   * Returns the full result as a JSON object (same shape as executeTool).
   */
  static async executeToolStreaming(
    name: string,
    args: Record<string, unknown> = {},
    onChunk:
      | ((
          event: string,
          data: string | null,
          meta?: Record<string, unknown>,
        ) => void)
      | null,
    context: ToolExecutionContext = {},
  ) {
    const streamPath = ToolOrchestratorService.STREAMABLE_TOOLS[name];
    if (!streamPath) {
      return ToolOrchestratorService.executeTool(name, args, context);
    }

    const remaps = ARG_REMAPS[name as keyof typeof ARG_REMAPS];
    let resolvedArgs: Record<string, unknown> = args;
    if (remaps) {
      resolvedArgs = { ...args };
      for (const [from, to] of Object.entries(remaps)) {
        if (resolvedArgs[from] !== undefined) {
          resolvedArgs[to] = resolvedArgs[from];
          delete resolvedArgs[from];
        }
      }
    }

    const url = `${TOOLS_SERVICE_URL}${streamPath}`;
    const contextHeaders = buildContextHeaders(context);

    try {
      // Combine session abort signal with a 65s timeout.
      // If the user cancels the session, the fetch aborts immediately.
      // If 65s elapses, the fetch aborts via timeout.
      const controller = createAbortController();
      const timeout = setTimeout(() => controller.abort(), 65_000); // generous timeout

      // If session signal exists, abort the local controller when session aborts
      if (context.signal && !context.signal.aborted) {
        const onSessionAbort = () => controller.abort();
        context.signal.addEventListener("abort", onSessionAbort, {
          once: true,
        });
        // Clean up listener when controller aborts from timeout (not session)
        controller.signal.addEventListener(
          "abort",
          () => {
            context.signal!.removeEventListener("abort", onSessionAbort);
          },
          { once: true },
        );
      } else if (context.signal?.aborted) {
        controller.abort();
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...contextHeaders },
        body: JSON.stringify(resolvedArgs),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return {
          error: `API returned ${response.status}: ${response.statusText}`,
        };
      }

      // Parse the SSE stream — accumulate stdout/stderr so the final result
      // includes the full output for persistence (TerminalRenderer reads
      // result.stdout after page refresh when streamingOutput is gone).
      if (!response.body) {
        return { error: "Response body is not readable" };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = null;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.event === "stdout") {
              stdoutChunks.push(event.data || "");
              onChunk?.(event.event, event.data);
            } else if (event.event === "stderr") {
              stderrChunks.push(event.data || "");
              onChunk?.(event.event, event.data);
            } else if (event.event === "exit") {
              finalResult = {
                success: event.success,
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                exitCode: event.exitCode,
                executionTimeMs: event.executionTimeMs,
                timedOut: event.timedOut || false,
                ...(event.error && { error: event.error }),
              };
              onChunk?.("exit", null, finalResult);
            } else if (event.event === "start") {
              onChunk?.("start", null, event);
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      // If we never got an exit event, return accumulated output anyway
      if (
        !finalResult &&
        (stdoutChunks.length > 0 || stderrChunks.length > 0)
      ) {
        finalResult = {
          success: false,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          exitCode: null,
          error: "Stream ended without exit event",
        };
      }
      return finalResult || { error: "Stream ended without exit event" };
    } catch (error: unknown) {
      return { error: `Streaming failed: ${getErrorMessage(error)}` };
    }
  }

  static async executeToolCalls(
    toolCalls: Array<{
      name: string;
      id: string;
      args?: Record<string, unknown>;
    }>,
  ) {
    return Promise.all(
      toolCalls.map(async (toolCall) => ({
        name: toolCall.name,
        id: toolCall.id,
        result: await ToolOrchestratorService.executeTool(
          toolCall.name,
          toolCall.args || {},
        ),
      })),
    );
  }

  // ── Worktree State Helpers — used by WorktreeTools.js ──────
  /** @internal */ static _setWorktree(
    agentConversationId: string,
    state: WorktreeState,
  ) {
    activeWorktrees.set(agentConversationId, state);
  }
  /** @internal */ static _clearWorktree(agentConversationId: string) {
    activeWorktrees.delete(agentConversationId);
  }
  /** @internal */ static _resetCaches() {
    cachedSchemas = [];
    cachedAISchemas = [];
    cachedClientSchemas = [];
    localizedClientSchemasCache.clear();
    localizedAISchemasCache.clear();
    attemptedLocales.clear();
    toolMap.clear();
    initialized = false;
    lastFetchAttemptTime = 0;
  }
  /** @internal */ static async _proxyPost(
    path: string,
    body: Record<string, unknown>,
    context: ToolExecutionContext,
  ) {
    return fetchJsonWithBody(
      `${TOOLS_SERVICE_URL}${path}`,
      "POST",
      body,
      buildContextHeaders(context),
      context.signal,
    );
  }
}

import { registerGlobalToolOrchestratorService } from "../types/GlobalToolOrchestratorRegistry.ts";
registerGlobalToolOrchestratorService(ToolOrchestratorService);
