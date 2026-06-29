import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../AgentPersonaRegistry.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import {
  getOrchestratorPromptAddendum,
  ORCHESTRATOR_ONLY_TOOLS,
} from "../OrchestratorPrompt.ts";
import { resolveToolEntriesToSet } from "../../utils/resolveToolEntriesToSet.ts";
import { resolveLockedOffToolNames } from "../../utils/resolveLockedOffToolNames.ts";
import SettingsService from "../SettingsService.ts";
import {
  AGENT_IDS,
  DEFAULT_TOPOLOGY,
  CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST,
  isCoreDomain,
} from "@rodrigo-barraza/utilities-library/taxonomy";

const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);

import { DirectoryTreeFormatter } from "./DirectoryTreeFormatter.ts";
import { ToolDocFormatter } from "./ToolDocFormatter.ts";
import { SkillMemoryScorer } from "./SkillMemoryScorer.ts";
import { AssemblerContext } from "./types.ts";
import SomaticStateService from "../somatic/SomaticStateService.ts";
import WorkflowMemoryService from "../WorkflowMemoryService.ts";
import { PROMPT_DELIMITERS } from "../../constants.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

export default class SystemPromptAssembler {
  workspaceRoot: string;
  private directoryFormatter: DirectoryTreeFormatter;
  private docFormatter: ToolDocFormatter;
  private scorer: SkillMemoryScorer;

  constructor(options: { workspaceRoot?: string } = {}) {
    this.workspaceRoot =
      options.workspaceRoot ||
      ToolOrchestratorService.getWorkspaceRoot() ||
      process.env.HOME ||
      "/home";
    this.directoryFormatter = new DirectoryTreeFormatter(this.workspaceRoot);
    this.docFormatter = new ToolDocFormatter();
    this.scorer = new SkillMemoryScorer();
  }

  async fetchDirectoryTree(): Promise<string> {
    return this.directoryFormatter.fetchDirectoryTree();
  }

  buildToolDescriptions(
    enabledTools?: string[],
    agentId?: string | null,
    defaultTopology?: string,
    resolvedToolNames?: string[],
    lockedOffToolNames?: Set<string>,
    compact?: boolean,
    locale = "en",
    loadedTools?: Set<string>,
  ): string {
    return this.docFormatter.buildToolDescriptions(
      enabledTools,
      agentId,
      defaultTopology,
      resolvedToolNames,
      lockedOffToolNames,
      compact,
      locale,
      loadedTools,
    );
  }

  async assemble(context: AssemblerContext) {
    const sections: string[] = [];
    const isDirectMode = !context.agent;
    const agentId = context.agent || AGENT_IDS.CODING;
    const persona = isDirectMode ? null : AgentPersonaRegistry.get(agentId);
    const isSubAgent = !!context.parentAgentConversationId;
    if (!isSubAgent && context.enabledTools) {
      context.enabledTools = Array.from(
        new Set([...context.enabledTools, ...ORCHESTRATOR_ONLY_TOOLS]),
      );
    }

    const codingFallback =
      !isDirectMode && (!persona || persona.id === AGENT_IDS.CODING);

    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;
    const locale = context.locale || settings?.locale || PromptLocaleService.getDefaultLocale();

    // ── 1. Agent Identity ────────────────────────────────────────
    if (isDirectMode) {
      sections.push(
        PromptLocaleService.get(locale, "system-prompt.directModeIdentity"),
      );
    } else if (persona) {
      const identityText =
        typeof persona.identity === "function"
          ? persona.identity({ ...context, locale })
          : persona.identity;
      sections.push(identityText);
    } else {
      sections.push(
        PromptLocaleService.get(locale, "system-prompt.codingFallbackIdentity"),
      );
    }

    // ── 1b. Platform-Specific Rules ──────────────────────────────
    if (persona?.platformRules && context.agentContext?.platform) {
      const platformKey = context.agentContext.platform;
      const platformSection = persona.platformRules[platformKey];
      if (platformSection) {
        const platformText =
          typeof platformSection === "function"
            ? platformSection({ ...context, locale })
            : platformSection;
        if (platformText) sections.push(platformText);
      }
    }

    // ── 2. Runtime Context (from caller) ──────────────────────────
    // Platform context and self context are collected into separate
    // arrays — they become distinct role:"system" messages instead of
    // being concatenated into the main system prompt.
    const platformContextSections: string[] = [];
    const selfContextSections: string[] = [];

    if (context.agentContext) {
      const agentContext = context.agentContext;

      // ── 2a. Platform Context (separate SYSTEM message) ──────────
      // Runtime platform data (server/channel/participant info, matched
      // knowledge, image captions, IDs). Injected as its own system
      // message so the LLM sees it as a distinct instruction block.
      const platformContext = agentContext.platformContext;
      if (platformContext) {
        if (platformContext.description) {
          platformContextSections.push(platformContext.description);
        }
        if (platformContext.serverContext) {
          platformContextSections.push(platformContext.serverContext);
        }
        if (platformContext.imageContext) {
          platformContextSections.push(platformContext.imageContext);
        }
        if (platformContext.ids) {
          platformContextSections.push(platformContext.ids);
        }
      } else {
        // Legacy flat fields — backward compatible
        if (agentContext.discordContext) {
          platformContextSections.push(agentContext.discordContext);
        }
        if (agentContext.serverContext) {
          platformContextSections.push(agentContext.serverContext);
        }
        if (agentContext.imageContext) {
          platformContextSections.push(agentContext.imageContext);
        }
        if (agentContext.guildId) {
          let idsBlock = `# Discord IDs\n- Guild ID: ${agentContext.guildId}`;
          if (agentContext.channelId)
            idsBlock += `\n- Channel ID: ${agentContext.channelId}`;
          platformContextSections.push(idsBlock);
        }
      }

      // Agent-specific runtime context (non-platform, non-self)
      // These remain in the main system prompt for now
      if (agentContext.clockCrewContext) {
        sections.push(agentContext.clockCrewContext);
      }
      if (agentContext.stickersContext) {
        sections.push(agentContext.stickersContext);
      }
      if (agentContext.emotionContext) {
        sections.push(agentContext.emotionContext);
      }
      if (agentContext.visualContext) {
        sections.push(agentContext.visualContext);
      }
      if (agentContext.lightsContext) {
        sections.push(agentContext.lightsContext);
      }
    }

    // ── 2b. Self Context (separate SYSTEM message) ──────────────
    // Somatic state is agent-level (not platform-level). Runs for any
    // agent with hasSomaticState, regardless of whether agentContext
    // is present. This ensures prism-client Lupos gets somatic state
    // even though only Discord sends agentContext.
    // Sub-agents are ephemeral workers — they don't maintain emotional
    // continuity, so somatic adaptation is skipped entirely.
    if (persona?.hasSomaticState && agentId && !isSubAgent) {
      const userMessages =
        context.messages?.filter((message) => message.role === "user") || [];
      const latestUserMessage = userMessages[userMessages.length - 1];
      if (latestUserMessage && typeof latestUserMessage.content === "string") {
        await SomaticStateService.adaptFromMessage(
          agentId,
          latestUserMessage.content,
          {
            traceId: context.traceId,
            agentConversationId: context.agentConversationId,
            endpoint: context.agentContext?.endpoint || "/agent",
            project: context.project,
            username: context.username,
          },
        );
      }

      const somaticMessage =
        await SomaticStateService.renderSystemMessage(agentId, locale);
      if (somaticMessage) {
        selfContextSections.push(somaticMessage);
      }
    }

    // ── 3. Tool Policy (persona-specific) ────────────────────────
    if (persona?.toolPolicy) {
      const policyText =
        typeof persona.toolPolicy === "function"
          ? persona.toolPolicy({ ...context, locale })
          : persona.toolPolicy;
      if (policyText) sections.push(policyText);
    }

    // ── 4. Enabled Tools (domain-grouped) ──────────────────────
    {
      // Guarantee locale-specific remote tool schemas are cached
      // before the synchronous buildToolDescriptions() reads them.
      await ToolOrchestratorService.ensureSchemas(locale);
      const lockedOffToolNames = await resolveLockedOffToolNames();
      const isCompactToolDocs = persona?.compactToolDocs === true;
      const toolDescriptions = this.buildToolDescriptions(
        context.enabledTools,
        agentId,
        defaultTopology,
        context.resolvedToolNames,
        lockedOffToolNames,
        isCompactToolDocs,
        locale,
        context.loadedTools,
      );
      if (toolDescriptions) {
        let count: number;
        if (context.resolvedToolNames?.length) {
          count =
            lockedOffToolNames.size > 0
              ? context.resolvedToolNames.filter(
                  (toolName) => !lockedOffToolNames.has(toolName),
                ).length
              : context.resolvedToolNames.length;
        } else {
          const schemas =
            ToolOrchestratorService.getClientToolSchemas(defaultTopology, locale);
          count =
            lockedOffToolNames.size > 0
              ? schemas.filter(
                  (toolSchema) =>
                    !lockedOffToolNames.has(toolSchema.name as string),
                ).length
              : schemas.length;
          if (context.enabledTools) {
            const hasPrefixed = context.enabledTools.some(
              (enabledTool) =>
                enabledTool.startsWith("domain:") ||
                enabledTool.startsWith("domainKey:"),
            );
            const enabledSet = hasPrefixed
              ? resolveToolEntriesToSet(context.enabledTools, schemas)
              : new Set(context.enabledTools);

            const countPersona = agentId
              ? AgentPersonaRegistry.get(agentId)
              : null;
            const isCoreToolsLockedForCount =
              countPersona?.coreToolsLocked ?? true;

            let filteredSchemas = schemas.filter(
              (toolSchema) =>
                enabledSet.has(toolSchema.name as string) ||
                (isCoreToolsLockedForCount &&
                  (isCoreDomain(
                    ((toolSchema as Record<string, unknown>)
                      .domain as string) || "",
                  ) ||
                    CORE_AGENTIC_TOOLS.has(toolSchema.name as string))),
            );

            if (agentId) {
              const assemblerPersona = AgentPersonaRegistry.get(agentId);
              if (assemblerPersona?.blockedTools?.length) {
                const disabledSet = resolveToolEntriesToSet(
                  assemblerPersona.blockedTools,
                  schemas,
                );
                filteredSchemas = filteredSchemas.filter(
                  (toolSchema) =>
                    !disabledSet.has(toolSchema.name as string) ||
                    enabledSet.has(toolSchema.name as string),
                );
              }
            }

            if (lockedOffToolNames.size > 0) {
              filteredSchemas = filteredSchemas.filter(
                (toolSchema) =>
                  !lockedOffToolNames.has(toolSchema.name as string),
              );
            }

            count = filteredSchemas.length;
          }
        }
        const header = PromptLocaleService.get(locale, "system-prompt.enabledToolsHeader", { count: String(count) });
        sections.push(header + "\n" + toolDescriptions);
      }
    }

    // ── 5. Guidelines ─────────────────────────────────────────────
    if (!isDirectMode) {
      if (persona?.guidelines) {
        sections.push(persona.guidelines);
      } else if (codingFallback || persona?.usesCodingGuidelines) {
        sections.push(
          PromptLocaleService.get(locale, "system-prompt.codingGuidelines") +
          PromptLocaleService.get(locale, "system-prompt.commandExecutionGuidelines"),
        );
      }
    }

    // ── 5b. Orchestrator Mode Addendum (when orchestrator tools available) ──
    if (!isDirectMode) {
      const resolvedEnabledSet = (() => {
        if (!context.enabledTools) return null;
        const hasPrefixed = context.enabledTools.some(
          (entry) =>
            entry.startsWith("domain:") || entry.startsWith("domainKey:"),
        );
        if (hasPrefixed) {
          const schemas =
            ToolOrchestratorService.getClientToolSchemas(defaultTopology, locale);
          return resolveToolEntriesToSet(context.enabledTools, schemas);
        }
        return new Set(context.enabledTools);
      })();
      const orchestratorAvailable = resolvedEnabledSet
        ? ORCHESTRATOR_ONLY_TOOLS.some((toolName: string) =>
            resolvedEnabledSet.has(toolName),
          )
        : true;

      if (orchestratorAvailable) {
        const allSchemas =
          ToolOrchestratorService.getToolSchemas(defaultTopology, locale);
        const orchestratorSet = new Set(ORCHESTRATOR_ONLY_TOOLS);
        const lockedOffSet = await resolveLockedOffToolNames();

        // Build the sub-agent tool list from only the enabled tools
        // (not the full catalog). Sub-agents inherit the parent's
        // enabled set minus orchestrator-only tools.
        let enabledToolNames: string[];
        if (context.resolvedToolNames?.length) {
          enabledToolNames = context.resolvedToolNames;
        } else if (context.enabledTools?.length) {
          const hasPrefixed = context.enabledTools.some(
            (entry) =>
              entry.startsWith("domain:") || entry.startsWith("domainKey:"),
          );
          const clientSchemas =
            ToolOrchestratorService.getClientToolSchemas(defaultTopology, locale);
          const enabledSet = hasPrefixed
            ? resolveToolEntriesToSet(context.enabledTools, clientSchemas)
            : new Set(context.enabledTools);
          enabledToolNames = allSchemas
            .map((tool) => tool.name as string)
            .filter(
              (toolName) =>
                enabledSet.has(toolName) || CORE_AGENTIC_TOOLS.has(toolName),
            );
        } else {
          enabledToolNames = allSchemas.map((tool) => tool.name as string);
        }

        const subAgentTools = enabledToolNames.filter(
          (toolName) =>
            !orchestratorSet.has(toolName) && !lockedOffSet.has(toolName),
        );
        sections.push(
          getOrchestratorPromptAddendum({ subAgentTools, defaultTopology, locale }),
        );
      }
    }

    // ── 6. Environment ───────────────────────────────────────────
    const isWorkspaceEnabled = context.workspaceEnabled !== false;
    const environmentLines = [PromptLocaleService.get(locale, "system-prompt.environmentOsLine")];
    if (isWorkspaceEnabled) {
      environmentLines.push(
        PromptLocaleService.get(locale, "system-prompt.environmentWorkspaceLine", {
          workspaceRoot: this.workspaceRoot,
        }),
      );
    }
    sections.push(
      PromptLocaleService.get(locale, "system-prompt.environmentHeader") + `\n` + environmentLines.join(`\n`),
    );

    // ── 7. Project Structure (cached) ────────────────────────────
    if (isWorkspaceEnabled && (codingFallback || persona?.usesDirectoryTree)) {
      const dirTree = await this.fetchDirectoryTree();
      if (dirTree) {
        const header = PromptLocaleService.get(locale, "system-prompt.projectStructureHeader");
        sections.push(header + "\n" + dirTree);
      }
    }

    // ── 8. Project Skills (relevance-filtered) ────────────────────
    const lastUserMessage = [...(context.messages || [])]
      .reverse()
      .find((message) => message.role === "user");
    const queryText = (lastUserMessage?.content as string) || "";

    const skills = await this.scorer.fetchSkills(
      context.project || null,
      context.username || "",
      queryText,
      {
        traceId: context.traceId,
        agentConversationId: context.agentConversationId,
        endpoint: "/agent",
        agent: agentId,
      },
    );
    const skillNames: string[] = [];
    let skillsText = "";
    if (skills.length > 0) {
      const skillBlocks = skills.map((s) => {
        skillNames.push(s.name);
        return `### ${s.name}\n${s.content}`;
      });
      skillsText =
        `${PROMPT_DELIMITERS.PROJECT_SKILLS}\n` + skillBlocks.join("\n\n");
    }

    // ── 9. Conversation Memory (embedding search) ────────────────────
    // Sub-agents are ephemeral workers with isolated context windows.
    // They receive only the task prompt from the orchestrator — injecting
    // the parent user's long-term memory would add irrelevant noise and
    // waste tokens. This aligns with the industry-standard pattern used
    // by LangGraph, CrewAI, AutoGen, Google ADK, and OpenAI Agents SDK.
    const memoryQuery = queryText || context.project || "";
    let memoriesText = "";

    if (memoryQuery && !isSubAgent) {
      const agentContextForMemory = context.agentContext || {};
      const memoryGuildId = agentContextForMemory.guildId;
      const memoryUserIds = agentContextForMemory.participantUserIds;

      const memories = await this.scorer.fetchMemories(
        agentId,
        context.project || null,
        memoryQuery,
        {
          traceId: context.traceId,
          agentConversationId: context.agentConversationId,
          conversationId: context.conversationId as string | null,
          endpoint: "/agent",
          _username: context.username,
          guildId: memoryGuildId,
          userIds: memoryUserIds,
        },
      );
      if (memories) {
        memoriesText = `${PROMPT_DELIMITERS.AGENT_MEMORY}\n` + memories;
      }
    }

    // ── 10. Workflow Memory (cross-conversation procedural learning) ──
    // Same rationale as Step 9 — sub-agents don't need cross-conversation
    // procedural workflows. They execute a single task and are destroyed.
    let workflowsText = "";
    if (memoryQuery && !isDirectMode && !isSubAgent) {
      try {
        const workflows = await WorkflowMemoryService.retrieveRelevantWorkflows(
          agentId,
          context.project || null,
          memoryQuery,
          {
            traceId: context.traceId,
            agentConversationId: context.agentConversationId,
            conversationId: context.conversationId as string | null,
            endpoint: "/agent",
            username: context.username,
          },
        );
        if (workflows) {
          workflowsText = workflows;
        }
      } catch (error: unknown) {
        logger.error(
          `[SystemPromptAssembler] Workflow memory retrieval failed: ${getErrorMessage(error)}`,
        );
      }
    }

    return {
      prompt: sections.join("\n\n"),
      platformContextMessage:
        platformContextSections.length > 0
          ? platformContextSections.join("\n\n")
          : null,
      selfContextMessage:
        selfContextSections.length > 0
          ? selfContextSections.join("\n\n")
          : null,
      skillNames,
      skillsText,
      memoriesText,
      workflowsText,
    };
  }

  createHook() {
    return async (context: AssemblerContext) => {
      try {
        const {
          prompt: systemPrompt,
          platformContextMessage,
          selfContextMessage,
          skillNames,
          skillsText,
          memoriesText,
          workflowsText,
        } = await this.assemble(context);
        if (!systemPrompt) return;

        context._injectedSkills = skillNames;
        context._assembledSystemPrompt = systemPrompt;

        const assembledLocale = context.locale || (await SettingsService.getSection("agents"))?.locale || PromptLocaleService.getDefaultLocale();
        injectSystemPromptContext(context.messages!, {
          platformContextMessage,
          selfContextMessage,
          skillsText,
          memoriesText,
          workflowsText,
          locale: assembledLocale,
        });

        logger.info(
          `[SystemPromptAssembler] Assembled ${systemPrompt.length} char static system prompt for agent="${context.agent || "DIRECT"}" (${skillNames.length} skills injected into user context)`,
        );
      } catch (error: unknown) {
        logger.error(
          `[SystemPromptAssembler] Assembly failed: ${getErrorMessage(error)}`,
        );
      }
    };
  }
}

/**
 * Standard utility to inject system prompts and contexts (platform context, somatic state, skills, memories)
 * into a conversation message history. Exposed so that both production assembler hooks and test harnesses
 * use the identical alignment algorithm without code duplication.
 */
export function injectSystemPromptContext(
  messages: Array<{
    role: string;
    content?: string | unknown[] | null;
    _isIdentityPrompt?: boolean;
    [key: string]: unknown;
  }>,
  options: {
    systemPrompt?: string;
    platformContextMessage?: string | null;
    selfContextMessage?: string | null;
    skillsText?: string;
    memoriesText?: string;
    workflowsText?: string;
    localTimeText?: string;
    locale?: string;
  },
): void {
  const {
    systemPrompt,
    platformContextMessage,
    selfContextMessage,
    skillsText,
    memoriesText,
    workflowsText,
    localTimeText,
    locale,
  } = options;

  // ── 1. Interleave platform context before the last user message ──
  // Inserted first so that when somatic state is also spliced in (step 2),
  // the final order is: ...history → platform → somatic → last user msg.
  if (platformContextMessage) {
    const lastUserMessageIndex = messages.reduce(
      (lastIndex: number, message: { role: string }, index: number) =>
        message.role === "user" ? index : lastIndex,
      -1,
    );
    if (lastUserMessageIndex >= 0) {
      messages.splice(lastUserMessageIndex, 0, {
        role: "system",
        content: platformContextMessage,
      });
    }
  }

  // ── 2. Interleave self context before the last user message ───
  // Re-scans for the last user message (which may have shifted after
  // step 1), so somatic state always sits directly before the user input.
  if (selfContextMessage) {
    const lastUserMessageIndex = messages.reduce(
      (lastIndex: number, message: { role: string }, index: number) =>
        message.role === "user" ? index : lastIndex,
      -1,
    );
    if (lastUserMessageIndex >= 0) {
      messages.splice(lastUserMessageIndex, 0, {
        role: "system",
        content: selfContextMessage,
      });
    }
  }

  // ── 3. Inject system-originated context as a dedicated system message ──
  // Local time, skills, memories, and workflows are system-injected metadata,
  // not user input. They belong in a system message so the LLM treats them as
  // authoritative grounding context rather than conversational user intent.
  // The _isInjectedContext marker prevents double-injection on the same turn
  // and is cleaned from the payload before persistence to MongoDB.
  const userMessages = messages.filter((message) => message.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];
  if (lastUserMessage) {
    const timeText =
      localTimeText ||
      new Date().toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "long",
      });

    const activeLocale = locale || PromptLocaleService.getDefaultLocale();
    const localTimeLabel = PromptLocaleService.get(activeLocale, "system-prompt.localTimeLabel", { time: timeText });
    const contextLines = [localTimeLabel];

    let systemContextBlock = `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\n${contextLines.join("\n")}`;

    if (skillsText) {
      systemContextBlock += `\n\n${skillsText}`;
    }

    if (memoriesText) {
      systemContextBlock += `\n\n${memoriesText}`;
    }

    if (workflowsText) {
      systemContextBlock += `\n\n${workflowsText}`;
    }

    const messageIndex = messages.indexOf(lastUserMessage);
    if (messageIndex !== -1) {
      // Check if an injected context message already exists immediately before
      // the user message (guard against double-injection on the same turn)
      const preceding = messages[messageIndex - 1];
      if (preceding?._isInjectedContext !== true) {
        messages.splice(messageIndex, 0, {
          role: "system",
          content: systemContextBlock,
          _isInjectedContext: true,
        });
      }
    }
  }
}

export { SystemPromptAssembler };
