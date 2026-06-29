import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import SettingsService from "./SettingsService.ts";
import logger from "../utils/logger.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import ToolContext from "./ToolContext.ts";

import InternalToolRegistry from "./local-tools/InternalToolRegistry.ts";
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

/** Prism-local tools bypass the enabledTools filter (always available to all agents) — derived from registry */
let _prismLocalCache: Set<string> | null = null;
const PRISM_LOCAL_TOOL_NAMES = {
  has(name: string): boolean {
    if (!_prismLocalCache) _prismLocalCache = InternalToolRegistry.getNames();
    return _prismLocalCache.has(name);
  },
};

export default class AgenticToolResolver {
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
    // Ensure tool schemas are loaded from tools-api (lazy init — if tools-api
    // was unreachable at boot, this fetches on-demand before proceeding)
    await ToolOrchestratorService.ensureSchemas();
    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;
    const toolsApiSchemas =
      ToolOrchestratorService.getToolSchemas(defaultTopology);

    const dynamicTools: ToolSchema[] = [...toolsApiSchemas];

    // Merge MCP tools from connected servers
    const mcpTools = ToolOrchestratorService.getMCPToolSchemas();
    if (mcpTools.length > 0) {
      // Strip internal metadata before passing to LLM
      for (const tool of mcpTools) {
        const { _mcpServer, _mcpOriginalName, ...schema } = tool;
        dynamicTools.push(schema);
      }
      logger.info(
        `[AgenticLoop] Merged ${mcpTools.length} MCP tools from connected servers`,
      );
    }

    // ── Tool filtering ────────────────────────────────────────────
    let resolvedEnabledTools: string[] | null = options.enabledTools || null;
    let shouldApplyDisabledFilter = false;
    const effectiveAgentConversationId = agentConversationId;
    if (effectiveAgentConversationId) {
      const dynamicTools = ToolContext.get<string[]>(
        effectiveAgentConversationId,
        "dynamicEnabledTools",
      );
      if (Array.isArray(dynamicTools) && dynamicTools.length > 0) {
        resolvedEnabledTools = dynamicTools;
        // Apply client-side disabledTools to the dynamic set so user UI
        // toggles are respected even after enable_tools has been called
        if (
          options.disabledTools &&
          Array.isArray(options.disabledTools) &&
          options.disabledTools.length > 0
        ) {
          const clientDisabledSet = new Set(options.disabledTools);
          resolvedEnabledTools = resolvedEnabledTools.filter(
            (toolName) => !clientDisabledSet.has(toolName),
          );
          shouldApplyDisabledFilter = true;
        }
      }
    }

    // Mode 2: disabledTools — resolve server-side
    if (
      !resolvedEnabledTools &&
      options.disabledTools &&
      Array.isArray(options.disabledTools)
    ) {
      shouldApplyDisabledFilter = true;
      const disabledSet = new Set(options.disabledTools);
      const persona = agent ? AgentPersonaRegistry.get(agent) : null;
      const rawBaseTools = persona?.availableTools || null;
      // "*" wildcard = all tools — treat same as no persona base tools
      const baseTools = rawBaseTools?.includes("*") ? null : rawBaseTools;

      if (baseTools) {
        const clientSchemas =
          ToolOrchestratorService.getClientToolSchemas(defaultTopology);
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
        resolvedEnabledTools = [...expandedSet];
        logger.info(
          `[AgenticLoop] disabledTools mode: ${disabledSet.size} disabled → ${resolvedEnabledTools.length} enabled tools`,
        );
      } else {
        resolvedEnabledTools = dynamicTools
          .map((tool) => tool.name)
          .filter((name) => !disabledSet.has(name));
        logger.info(
          `[AgenticLoop] disabledTools mode (no persona): ${disabledSet.size} disabled → ${resolvedEnabledTools.length} enabled tools`,
        );
      }
    }

    // Mode 3: fallback to persona's availableTools (or enabledByDefaultTools subset)
    if (!resolvedEnabledTools && agent) {
      const persona = AgentPersonaRegistry.get(agent);
      if (persona?.availableTools) {
        // "*" wildcard means "all tools" — skip filtering entirely
        if (persona.availableTools.includes("*")) {
          // Even with wildcard availableTools, if enabledByDefaultTools is set,
          // use it as the initial subset (agent can still enable_tools to get more)
          if (
            persona.enabledByDefaultTools !== undefined &&
            !persona.enabledByDefaultTools.includes("*")
          ) {
            resolvedEnabledTools = persona.enabledByDefaultTools;
            logger.info(
              `[AgenticLoop] Persona "${agent}" uses wildcard availableTools with ${resolvedEnabledTools.length} enabledByDefaultTools`,
            );
          } else {
            logger.info(
              `[AgenticLoop] Persona "${agent}" uses wildcard availableTools — all tools enabled`,
            );
          }
        } else {
          // enabledByDefaultTools: ["*"] means "enable everything in availableTools"
          // enabledByDefaultTools: undefined also falls back to availableTools (backward-compatible)
          const useFullAvailable =
            persona.enabledByDefaultTools === undefined ||
            persona.enabledByDefaultTools.includes("*");
          resolvedEnabledTools = useFullAvailable
            ? persona.availableTools
            : persona.enabledByDefaultTools!;
          logger.info(
            `[AgenticLoop] Using persona "${agent}" ${useFullAvailable ? "availableTools (all enabled)" : "enabledByDefaultTools"}: [${resolvedEnabledTools!.join(", ")}]`,
          );
        }
      }
    }

    let finalTools = dynamicTools;
    if (resolvedEnabledTools && Array.isArray(resolvedEnabledTools)) {
      const hasPrefixed = resolvedEnabledTools.some(
        (entry) =>
          entry.startsWith("domain:") || entry.startsWith("domainKey:"),
      );

      let enabledSet: Set<string>;
      if (hasPrefixed) {
        const clientSchemas =
          ToolOrchestratorService.getClientToolSchemas(defaultTopology);
        enabledSet = resolveToolEntriesToSet(
          resolvedEnabledTools,
          clientSchemas,
        );
        logger.info(
          `[AgenticLoop] Expanded ${resolvedEnabledTools.length} enabledTools entries → ${enabledSet.size} unique tools`,
        );
      } else {
        enabledSet = new Set(resolvedEnabledTools);
      }

      const resolvedPersona = agent ? AgentPersonaRegistry.get(agent) : null;
      const isCoreToolsLocked = resolvedPersona?.coreToolsLocked ?? true;

      const clientSchemas =
        ToolOrchestratorService.getClientToolSchemas(defaultTopology) || [];
      const systemTools = new Set<string>(
        clientSchemas
          .filter(
            (toolSchema) =>
              toolSchema.system === true &&
              !CORE_ORCHESTRATOR_TOOLS.has(toolSchema.name as string),
          )
          .map((toolSchema) => toolSchema.name as string),
      );

      const clientDisabledSet =
        shouldApplyDisabledFilter &&
        options.disabledTools &&
        Array.isArray(options.disabledTools) &&
        options.disabledTools.length > 0
          ? new Set<string>(options.disabledTools)
          : null;

      const shouldBypassOrchestratorTools = !options.isSubAgent;
      finalTools = finalTools.filter((tool) => {
        const cleanToolName = tool.name.replace(/^(mcp__[a-zA-Z0-9_-]+__)/, "");
        if (clientDisabledSet?.has(tool.name) || clientDisabledSet?.has(cleanToolName)) return false;
        if (enabledSet.has(tool.name) || enabledSet.has(cleanToolName)) return true;
        if (
          isCoreToolsLocked &&
          (CORE_AGENTIC_TOOLS.has(tool.name) ||
            systemTools.has(tool.name) ||
            isCoreDomain(tool.domain || ""))
        )
          return true;
        if (
          shouldBypassOrchestratorTools &&
          CORE_ORCHESTRATOR_TOOLS.has(tool.name)
        )
          return true;
        if (PRISM_LOCAL_TOOL_NAMES.has(tool.name)) return true;
        return false;
      });

      if (resolvedPersona?.blockedTools?.length) {
        const disabledSet = resolveToolEntriesToSet(
          resolvedPersona.blockedTools,
          clientSchemas,
        );
        finalTools = finalTools.filter(
          (tool) => !disabledSet.has(tool.name) || enabledSet.has(tool.name),
        );
        logger.info(
          `[AgenticLoop] Applied blockedTools denylist (${disabledSet.size} tools blocked, enabledSet protects ${enabledSet.size})`,
        );
      }
    }

    // ── Workspace domain exclusion ─────────────────────────────────
    if (options.workspaceEnabled === false) {
      const workspaceDomainName = DOMAINS.CORE_WORKSPACE.displayName;
      const previousCount = finalTools.length;
      finalTools = finalTools.filter(
        (tool) => (tool as ToolSchema).domain !== workspaceDomainName,
      );
      if (finalTools.length < previousCount) {
        logger.info(
          `[AgenticToolResolver] Workspace disabled: removed ${previousCount - finalTools.length} workspace-domain tools`,
        );
      }
    }

    // ── Native tool collision prevention ────────────────────────
    if (options.webSearch) {
      finalTools = finalTools.filter(
        (tool) => tool.name !== TOOL_NAMES.SEARCH_WEB,
      );
    }

    if (modelDefinition?.outputTypes?.includes(TYPES.IMAGE)) {
      finalTools = finalTools.filter(
        (tool) => tool.name !== TOOL_NAMES.GENERATE_IMAGE,
      );
    }

    if (modelDefinition?.inputTypes?.includes(TYPES.IMAGE)) {
      finalTools = finalTools.filter(
        (tool) => tool.name !== TOOL_NAMES.DESCRIBE_IMAGE,
      );
    }

    // When the model has native thinking as a built-in capability, the think
    // tool is redundant — the model reasons natively before each response/tool call.
    // This mirrors the client's comprehensive detection in ChatSessionComponent.
    const hasNativeThinking = AgenticToolResolver.detectNativeThinking(
      modelDefinition,
      providerName,
      resolvedModel,
      options.thinkingEnabled as boolean | undefined,
    );
    if (hasNativeThinking) {
      finalTools = finalTools.filter((tool) => tool.name !== TOOL_NAMES.THINK);
    }

    logger.info(`[AgenticToolResolver] Final: ${finalTools.length} tools`);
    return { finalTools, resolvedEnabledTools };
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
