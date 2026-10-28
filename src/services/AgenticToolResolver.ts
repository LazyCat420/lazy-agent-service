import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import SettingsService from "./SettingsService.ts";
import logger from "../utils/logger.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import ToolContext from "./ToolContext.ts";


import {
  CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST,
  CORE_ORCHESTRATOR_TOOLS as CORE_ORCHESTRATOR_TOOLS_LIST,
  TOOL_NAMES,
  DEFAULT_TOPOLOGY,
  DOMAINS,
  isCoreDomain,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { TYPES } from "../config.ts";
import { resolveToolEntriesToSet } from "../utils/resolveToolEntriesToSet.ts";
import {
  THINKING_PATTERNS,
  LOCAL_PROVIDER_TYPES,
} from "./local-provider/constants.ts";

// ── Types ────────────────────────────────────────────────────

interface ToolSchema {
  name: string;
  description?: string;
  parameters?: unknown;
  domain?: string;
  _mcpServer?: string;
  _mcpOriginalName?: string;
}

interface ModelDefinition {
  outputTypes?: string[];
  inputTypes?: string[];
  [key: string]: unknown;
}

interface ResolveOptions {
  enabledTools?: string[];
  disabledTools?: string[];
  webSearch?: boolean;
  isSubAgent?: boolean;
  workspaceEnabled?: boolean;
  /** Reasoning effort passthrough ("low" | "medium" | "high", ...); normalized before reaching the provider. */
  reasoningEffort?: unknown;
  [key: string]: unknown;
}

interface ResolveParams {
  options: ResolveOptions;
  agent?: string;
  project?: string;
  username?: string;
  modelDefinition?: ModelDefinition;
  agentConversationId?: string;
  providerName?: string;
  resolvedModel?: string;
}

/** Orchestrator tools bypass the enabledTools filter for coordinator agents (excluded for sub-agents to prevent recursive spawning) */
const CORE_ORCHESTRATOR_TOOLS = new Set<string>(CORE_ORCHESTRATOR_TOOLS_LIST);

/** Core agentic tools bypass the enabledTools filter (always available to all agents as part of the core cognitive architecture) */
const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);

// Decision (ch.06 item 3): these three stay available even for a persona
// that unlocks core tools (coreToolsLocked: false). prism force-adds the
// core agentic tools; the SDK's `coreToolsLocked: false` here stripped
// execute_python, emit_structured_output and think from trading agents —
// and without emit_structured_output a trading run cannot produce its
// artifact. An explicit blockedTools entry still wins (checked after).
const ALWAYS_AVAILABLE_COGNITIVE_TOOLS: Record<string, true> = {
  [TOOL_NAMES.EXECUTE_PYTHON]: true,
  [TOOL_NAMES.EMIT_STRUCTURED_OUTPUT]: true,
  [TOOL_NAMES.THINK]: true,
};

const PRISM_LOCAL_TOOL_NAMES = {
  has(_name: string): boolean {
    return false;
  },
};

/** Reasoning effort levels accepted across OpenAI/Anthropic/vLLM providers. */
const REASONING_EFFORT_LEVELS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export default class AgenticToolResolver {
  private static resolveDynamicEnabledTools(
    options: ResolveParams["options"],
    agentConversationId?: string,
  ): { resolvedEnabledTools: string[] | null; shouldApplyDisabledFilter: boolean } {
    let resolvedEnabledTools: string[] | null = options.enabledTools || null;
    let shouldApplyDisabledFilter = false;
    if (!agentConversationId) {
      return { resolvedEnabledTools, shouldApplyDisabledFilter };
    }
    const dynamicTools = ToolContext.get<string[]>(
      agentConversationId,
      "dynamicEnabledTools",
    );
    if (Array.isArray(dynamicTools) && dynamicTools.length > 0) {
      resolvedEnabledTools = dynamicTools;
      if (Array.isArray(options.disabledTools) && options.disabledTools.length > 0) {
        const clientDisabledSet = new Set(options.disabledTools);
        resolvedEnabledTools = resolvedEnabledTools.filter(
          (toolName) => !clientDisabledSet.has(toolName),
        );
        shouldApplyDisabledFilter = true;
      }
    }
    return { resolvedEnabledTools, shouldApplyDisabledFilter };
  }

  private static resolveDisabledToolsMode(
    options: ResolveParams["options"],
    agent: string | undefined,
    defaultTopology: string,
    dynamicTools: ToolSchema[],
  ): string[] {
    const disabledSet = new Set(options.disabledTools);
    const persona = agent ? AgentPersonaRegistry.get(agent) : null;
    const rawBaseTools = persona?.availableTools || null;
    const baseTools = rawBaseTools?.includes("*") ? null : rawBaseTools;

    if (!baseTools) {
      const resolved = dynamicTools
        .map((tool) => tool.name)
        .filter((name) => !disabledSet.has(name));
      logger.info(
        `[AgenticLoop] disabledTools mode (no persona): ${disabledSet.size} disabled → ${resolved.length} enabled tools`,
      );
      return resolved;
    }

    const clientSchemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology);
    const expandedSet = new Set<string>();
    for (const entry of baseTools) {
      if (entry.startsWith("domain:")) {
        const domain = entry.slice(7);
        for (const tool of clientSchemas) {
          if (tool.domain === domain) expandedSet.add(tool.name);
        }
      } else {
        expandedSet.add(entry);
      }
    }
    for (const name of disabledSet) expandedSet.delete(name);
    const resolved = [...expandedSet];
    logger.info(
      `[AgenticLoop] disabledTools mode: ${disabledSet.size} disabled → ${resolved.length} enabled tools`,
    );
    return resolved;
  }

  private static resolvePersonaTools(agent: string): string[] | null {
    const persona = AgentPersonaRegistry.get(agent);
    if (!persona?.availableTools) return null;

    if (persona.availableTools.includes("*")) {
      if (
        persona.enabledByDefaultTools !== undefined &&
        !persona.enabledByDefaultTools.includes("*")
      ) {
        logger.info(
          `[AgenticLoop] Persona "${agent}" uses wildcard availableTools with ${persona.enabledByDefaultTools.length} enabledByDefaultTools`,
        );
        return persona.enabledByDefaultTools;
      }
      logger.info(
        `[AgenticLoop] Persona "${agent}" uses wildcard availableTools — all tools enabled`,
      );
      return null;
    }

    const useFullAvailable =
      persona.enabledByDefaultTools === undefined ||
      persona.enabledByDefaultTools.includes("*");
    const resolved = useFullAvailable
      ? persona.availableTools
      : persona.enabledByDefaultTools!;
    logger.info(
      `[AgenticLoop] Using persona "${agent}" ${useFullAvailable ? "availableTools (all enabled)" : "enabledByDefaultTools"}: [${resolved.join(", ")}]`,
    );
    return resolved;
  }

  private static isToolIncludedInFinalSet(
    tool: ToolSchema,
    clientDisabledSet: Set<string> | null,
    enabledSet: Set<string>,
    actionGrants: Set<string>,
    isCoreToolsLocked: boolean,
    systemTools: Set<string>,
    shouldBypassOrchestratorTools: boolean,
  ): boolean {
    const cleanToolName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
    if (clientDisabledSet?.has(tool.name) || clientDisabledSet?.has(cleanToolName)) return false;
    if (enabledSet.has(tool.name) || enabledSet.has(cleanToolName)) return true;
    if (actionGrants.has(cleanToolName) && isOwnServiceTool(tool.name)) return true;
    if (
      isCoreToolsLocked &&
      (CORE_AGENTIC_TOOLS.has(tool.name) ||
        systemTools.has(tool.name) ||
        isCoreDomain(tool.domain || ""))
    ) {
      return true;
    }
    if (shouldBypassOrchestratorTools && CORE_ORCHESTRATOR_TOOLS.has(tool.name)) {
      return true;
    }
    return PRISM_LOCAL_TOOL_NAMES.has(tool.name) || Boolean(ALWAYS_AVAILABLE_COGNITIVE_TOOLS[cleanToolName]);
  }

  private static filterToolsByEnabledList(
    dynamicTools: ToolSchema[],
    resolvedEnabledTools: string[],
    shouldApplyDisabledFilter: boolean,
    options: ResolveParams["options"],
    agent: string | undefined,
    defaultTopology: string,
  ): ToolSchema[] {
    const hasPrefixed = resolvedEnabledTools.some(
      (entry) => entry.startsWith("domain:") || entry.startsWith("domainKey:"),
    );
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology) || [];
    let enabledSet: Set<string>;
    if (hasPrefixed) {
      enabledSet = resolveToolEntriesToSet(resolvedEnabledTools, clientSchemas);
      logger.info(
        `[AgenticLoop] Expanded ${resolvedEnabledTools.length} enabledTools entries → ${enabledSet.size} unique tools`,
      );
    } else {
      enabledSet = new Set(resolvedEnabledTools);
    }

    const resolvedPersona = agent ? AgentPersonaRegistry.get(agent) : null;
    const isCoreToolsLocked = resolvedPersona?.coreToolsLocked ?? true;
    const systemTools = new Set<string>(
      clientSchemas
        .filter((toolSchema) => toolSchema.system === true && !CORE_ORCHESTRATOR_TOOLS.has(toolSchema.name as string))
        .map((toolSchema) => toolSchema.name as string),
    );
    const clientDisabledSet =
      shouldApplyDisabledFilter && Array.isArray(options.disabledTools) && options.disabledTools.length > 0
        ? new Set<string>(options.disabledTools)
        : null;
    const shouldBypassOrchestratorTools = !options.isSubAgent && isCoreToolsLocked;
    const actionGrants = new Set<string>(
      resolvedEnabledTools
        .filter((entry) => entry.includes(".") && !entry.startsWith("global.") && !entry.startsWith("domain:"))
        .map((entry) => entry.split("@")[0].split(".").pop()!),
    );

    let finalTools = dynamicTools.filter((tool) =>
      AgenticToolResolver.isToolIncludedInFinalSet(
        tool,
        clientDisabledSet,
        enabledSet,
        actionGrants,
        isCoreToolsLocked,
        systemTools,
        shouldBypassOrchestratorTools,
      ),
    );

    if (resolvedPersona?.blockedTools?.length) {
      const disabledSet = resolveToolEntriesToSet(resolvedPersona.blockedTools, clientSchemas);
      finalTools = finalTools.filter(
        (tool) => !disabledSet.has(tool.name) || enabledSet.has(tool.name),
      );
      logger.info(
        `[AgenticLoop] Applied blockedTools denylist (${disabledSet.size} tools blocked, enabledSet protects ${enabledSet.size})`,
      );
    }
    return finalTools;
  }

  private static filterNativeAndWorkspaceCollisions(
    tools: ToolSchema[],
    options: ResolveParams["options"],
    modelDefinition: ResolveParams["modelDefinition"],
    providerName?: string,
    resolvedModel?: string,
  ): ToolSchema[] {
    let finalTools = tools;
    if (options.workspaceEnabled === false) {
      const workspaceDomainName = DOMAINS.CORE_WORKSPACE.displayName;
      const previousCount = finalTools.length;
      finalTools = finalTools.filter((tool) => (tool as ToolSchema).domain !== workspaceDomainName);
      if (finalTools.length < previousCount) {
        logger.info(
          `[AgenticToolResolver] Workspace disabled: removed ${previousCount - finalTools.length} workspace-domain tools`,
        );
      }
    }
    if (options.webSearch) {
      finalTools = finalTools.filter((tool) => tool.name !== TOOL_NAMES.SEARCH_WEB);
    }
    if (modelDefinition?.outputTypes?.includes(TYPES.IMAGE)) {
      finalTools = finalTools.filter((tool) => tool.name !== TOOL_NAMES.GENERATE_IMAGE);
    }
    if (modelDefinition?.inputTypes?.includes(TYPES.IMAGE)) {
      finalTools = finalTools.filter((tool) => tool.name !== TOOL_NAMES.DESCRIBE_IMAGE);
    }
    const hasNativeThinking = AgenticToolResolver.detectNativeThinking(
      modelDefinition,
      providerName,
      resolvedModel,
      options.thinkingEnabled as boolean | undefined,
    );
    if (hasNativeThinking) {
      finalTools = finalTools.filter((tool) => tool.name !== TOOL_NAMES.THINK);
    }
    return finalTools;
  }

  /**
   * Resolves the final set of tools for an agentic loop.
   * Handles MCP tools, disabledBuiltIns mode, prefix expansion,
   * and native provider tool collision prevention.
   */
  static async resolve({
    options,
    agent,
    project: _project,
    username: _username,
    modelDefinition,
    agentConversationId,
    providerName,
    resolvedModel,
  }: ResolveParams) {
    await ToolOrchestratorService.ensureSchemas();
    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;
    const toolsApiSchemas = ToolOrchestratorService.getToolSchemas(defaultTopology);
    const dynamicTools: ToolSchema[] = [...toolsApiSchemas];

    const mcpTools = ToolOrchestratorService.getMCPToolSchemas();
    if (mcpTools.length > 0) {
      for (const tool of mcpTools) {
        const { _mcpServer, _mcpOriginalName, ...schema } = tool;
        dynamicTools.push(schema);
      }
      logger.info(`[AgenticLoop] Merged ${mcpTools.length} MCP tools from connected servers`);
    }

    if (ToolOrchestratorService.isTradingRequest(_project)) {
      const merged = ToolOrchestratorService.withTradingCatalog(dynamicTools);
      dynamicTools.splice(0, dynamicTools.length, ...merged);
    }

    let { resolvedEnabledTools, shouldApplyDisabledFilter } =
      AgenticToolResolver.resolveDynamicEnabledTools(options, agentConversationId);

    if (!resolvedEnabledTools && Array.isArray(options.disabledTools)) {
      shouldApplyDisabledFilter = true;
      resolvedEnabledTools = AgenticToolResolver.resolveDisabledToolsMode(
        options,
        agent,
        defaultTopology,
        dynamicTools,
      );
    }

    if (!resolvedEnabledTools && agent) {
      resolvedEnabledTools = AgenticToolResolver.resolvePersonaTools(agent);
    }

    let finalTools = dynamicTools;
    if (Array.isArray(resolvedEnabledTools)) {
      finalTools = AgenticToolResolver.filterToolsByEnabledList(
        dynamicTools,
        resolvedEnabledTools,
        shouldApplyDisabledFilter,
        options,
        agent,
        defaultTopology,
      );
    }

    finalTools = AgenticToolResolver.filterNativeAndWorkspaceCollisions(
      finalTools,
      options,
      modelDefinition,
      providerName,
      resolvedModel,
    );

    if (options.reasoningEffort !== undefined) {
      const normalizedEffort = AgenticToolResolver.normalizeReasoningEffort(options.reasoningEffort);
      if (options.reasoningEffort !== normalizedEffort) {
        logger.warn(
          `[AgenticToolResolver] Dropping invalid reasoningEffort '${String(options.reasoningEffort)}'`,
        );
        options.reasoningEffort = normalizedEffort;
      }
    }

    logger.info(`[AgenticToolResolver] Final: ${finalTools.length} tools`);
    return { finalTools, resolvedEnabledTools };
  }

  /**
   * Normalizes the reasoning_effort passthrough (PLAN_deepseek.md §4):
   * valid level strings pass through, everything else becomes undefined.
   */
  static normalizeReasoningEffort(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    return REASONING_EFFORT_LEVELS.has(value) ? value : undefined;
  }

  /**
   * Detects whether the current model has native thinking/reasoning capability,
   * making the think tool redundant. Mirrors the client's comprehensive detection
   * in ChatSessionComponent's `lockedOffTools` useMemo.
   *
   * Checks (any truthy = native thinking):
   *   1. modelDefinition.thinking — static registry flag
   *   2. modelDefinition.supportsThinking — alternate registry flag
   *   3. modelDefinition.thinkingLevels — non-empty array = thinking model
   *   4. modelDefinition.tools includes "Thinking" — tools capability array
   *   5. Name-based pattern matching for local provider models (THINKING_PATTERNS)
   *   6. options.thinkingEnabled — client has already determined thinking is active
   */
  static detectNativeThinking(
    modelDefinition?: ModelDefinition,
    providerName?: string,
    resolvedModel?: string,
    thinkingEnabled?: boolean,
  ): boolean {
    if (modelDefinition?.thinking) return true;
    if (modelDefinition?.supportsThinking) return true;

    if (
      Array.isArray(modelDefinition?.thinkingLevels) &&
      (modelDefinition!.thinkingLevels as string[]).length > 0
    ) {
      return true;
    }

    if (
      Array.isArray(modelDefinition?.tools) &&
      (modelDefinition!.tools as string[]).includes("Thinking")
    ) {
      return true;
    }

    // Name-based detection for local provider models not in the static registry
    if (
      providerName &&
      resolvedModel &&
      LOCAL_PROVIDER_TYPES.has(providerName as any)
    ) {
      const modelNameLowercase = resolvedModel.toLowerCase();
      if (
        THINKING_PATTERNS.some((pattern) =>
          modelNameLowercase.includes(pattern),
        )
      ) {
        return true;
      }
    }

    // When the client explicitly enables thinking, the model's native
    // reasoning is active and the think tool is redundant
    if (thinkingEnabled === true) return true;

    return false;
  }
}

/** Bare names and this service's own MCP namespaces (both spellings) — not other MCP servers' tools. */
export function isOwnServiceTool(name: string): boolean {
  const prefix = /^(mcp__[a-zA-Z0-9_-]+__)/.exec(name)?.[1];
  return !prefix || prefix === "mcp__lazy-agent-service__" || prefix === "mcp__lazy-tool-service__";
}
