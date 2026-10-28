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
import { excludesLearnedState } from "../learning/TradingLearningBoundary.ts";
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
    const isTradingRun = excludesLearnedState(context.project);
    const withoutLearnedState = isSubAgent || isTradingRun;
    if (!isSubAgent && context.enabledTools && persona?.coreToolsLocked !== false) {
      context.enabledTools = Array.from(new Set([...context.enabledTools, ...ORCHESTRATOR_ONLY_TOOLS]));
    }

    const codingFallback = !isDirectMode && (!persona || persona.id === AGENT_IDS.CODING);
    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;
    const locale = context.locale || settings?.locale || PromptLocaleService.getDefaultLocale();

    // ── 1 & 1b. Agent Identity & Platform Rules ─────────────────
    appendIdentityAndPlatformRuleSections(isDirectMode, persona, context, locale, sections);

    // ── 2. Runtime & Somatic Context ────────────────────────────
    const platformContextSections: string[] = [];
    const selfContextSections: string[] = [];
    if (context.agentContext) {
      collectPlatformAndRuntimeContext(context.agentContext, sections, platformContextSections);
    }
    if (persona?.hasSomaticState && agentId && !isSubAgent) {
      await collectSomaticSelfContext(agentId, context, locale, selfContextSections);
    }

    // ── 3. Tool Policy ──────────────────────────────────────────
    if (persona?.toolPolicy) {
      const policyText =
        typeof persona.toolPolicy === "function" ? persona.toolPolicy({ ...context, locale }) : persona.toolPolicy;
      if (policyText) sections.push(policyText);
    }

    // ── 4. Enabled Tools (domain-grouped) ───────────────────────
    await ToolOrchestratorService.ensureSchemas(locale);
    const lockedOffToolNames = await resolveLockedOffToolNames();
    const toolDescriptions = this.buildToolDescriptions(
      context.enabledTools,
      agentId,
      defaultTopology,
      context.resolvedToolNames,
      lockedOffToolNames,
      persona?.compactToolDocs === true,
      locale,
      context.loadedTools,
    );
    if (toolDescriptions) {
      const count = countEnabledToolsForHeader(context, agentId, defaultTopology, locale, lockedOffToolNames);
      const header = PromptLocaleService.get(locale, "system-prompt.enabledToolsHeader", { count: String(count) });
      sections.push(header + "\n" + toolDescriptions);
    }

    // ── 5 & 5b. Guidelines & Orchestrator Addendum ──────────────
    appendGuidelineSections(isDirectMode, persona, codingFallback, locale, sections);
    if (!isDirectMode) {
      const addendum = await buildOrchestratorAddendumSection(context, persona, defaultTopology, locale);
      if (addendum) sections.push(addendum);
    }

    // ── 6 & 7. Environment & Project Structure ──────────────────
    const isWorkspaceEnabled = context.workspaceEnabled !== false;
    appendEnvironmentSection(isWorkspaceEnabled, this.workspaceRoot, locale, sections);
    if (isWorkspaceEnabled && (codingFallback || persona?.usesDirectoryTree)) {
      const dirTree = await this.fetchDirectoryTree();
      if (dirTree) {
        const header = PromptLocaleService.get(locale, "system-prompt.projectStructureHeader");
        sections.push(header + "\n" + dirTree);
      }
    }

    // ── 8, 9, 10. Skills, Conversation Memory, Workflow Memory ──
    const { skillNames, skillsText, memoriesText, workflowsText } = await fetchLearnedContextBlocks(
      this.scorer,
      context,
      agentId,
      isTradingRun,
      withoutLearnedState,
    );

    // ── 11. Current Date (A6) ───────────────────────────────────
    const datedSections = formatDatedSystemSections(sections);

    return {
      prompt: datedSections.join("\n\n"),
      platformContextMessage: platformContextSections.length > 0 ? platformContextSections.join("\n\n") : null,
      selfContextMessage: selfContextSections.length > 0 ? selfContextSections.join("\n\n") : null,
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

function appendIdentityAndPlatformRuleSections(
  isDirectMode: boolean,
  persona: ReturnType<typeof AgentPersonaRegistry.get>,
  context: AssemblerContext,
  locale: string,
  sections: string[],
): void {
  if (isDirectMode) {
    sections.push(PromptLocaleService.get(locale, "system-prompt.directModeIdentity"));
  } else if (persona) {
    const identityText =
      typeof persona.identity === "function" ? persona.identity({ ...context, locale }) : persona.identity;
    sections.push(identityText);
  } else {
    sections.push(PromptLocaleService.get(locale, "system-prompt.codingFallbackIdentity"));
  }
  if (persona?.platformRules && context.agentContext?.platform) {
    const platformSection = persona.platformRules[context.agentContext.platform];
    if (platformSection) {
      const platformText =
        typeof platformSection === "function" ? platformSection({ ...context, locale }) : platformSection;
      if (platformText) sections.push(platformText);
    }
  }
}

function collectPlatformAndRuntimeContext(
  agentContext: NonNullable<AssemblerContext["agentContext"]>,
  sections: string[],
  platformContextSections: string[],
): void {
  const platformContext = agentContext.platformContext;
  if (platformContext) {
    for (const part of [
      platformContext.description,
      platformContext.serverContext,
      platformContext.imageContext,
      platformContext.ids,
    ]) {
      if (part) platformContextSections.push(part);
    }
  } else {
    for (const part of [agentContext.discordContext, agentContext.serverContext, agentContext.imageContext]) {
      if (part) platformContextSections.push(part);
    }
    if (agentContext.guildId) {
      let idsBlock = `# Discord IDs\n- Guild ID: ${agentContext.guildId}`;
      if (agentContext.channelId) idsBlock += `\n- Channel ID: ${agentContext.channelId}`;
      platformContextSections.push(idsBlock);
    }
  }
  for (const part of [
    agentContext.clockCrewContext,
    agentContext.stickersContext,
    agentContext.emotionContext,
    agentContext.visualContext,
    agentContext.lightsContext,
  ]) {
    if (part) sections.push(part);
  }
}

async function collectSomaticSelfContext(
  agentId: string,
  context: AssemblerContext,
  locale: string,
  selfContextSections: string[],
): Promise<void> {
  const userMessages = context.messages?.filter((message) => message.role === "user") || [];
  const latestUserMessage = userMessages[userMessages.length - 1];
  if (latestUserMessage && typeof latestUserMessage.content === "string") {
    await SomaticStateService.adaptFromMessage(agentId, latestUserMessage.content, {
      traceId: context.traceId,
      agentConversationId: context.agentConversationId,
      endpoint: context.agentContext?.endpoint || "/agent",
      project: context.project,
      username: context.username,
    });
  }
  const somaticMessage = await SomaticStateService.renderSystemMessage(agentId, locale);
  if (somaticMessage) {
    selfContextSections.push(somaticMessage);
  }
}

function isSchemaIncludedInHeaderCount(
  toolSchema: Record<string, unknown>,
  enabledSet: Set<string>,
  isCoreToolsLockedForCount: boolean,
): boolean {
  const name = toolSchema.name as string;
  if (enabledSet.has(name)) return true;
  if (!isCoreToolsLockedForCount) return false;
  const domain = (toolSchema.domain as string) || "";
  return isCoreDomain(domain) || CORE_AGENTIC_TOOLS.has(name);
}

function countEnabledToolsForHeader(
  context: AssemblerContext,
  agentId: string,
  defaultTopology: string,
  locale: string,
  lockedOffToolNames: Set<string>,
): number {
  if (context.resolvedToolNames?.length) {
    return context.resolvedToolNames.filter((toolName) => !lockedOffToolNames.has(toolName)).length;
  }
  const schemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology, locale);
  if (!context.enabledTools) {
    return schemas.filter((toolSchema) => !lockedOffToolNames.has(toolSchema.name as string)).length;
  }
  const hasPrefixed = context.enabledTools.some(
    (enabledTool) => enabledTool.startsWith("domain:") || enabledTool.startsWith("domainKey:"),
  );
  const enabledSet = hasPrefixed
    ? resolveToolEntriesToSet(context.enabledTools, schemas)
    : new Set(context.enabledTools);
  const countPersona = agentId ? AgentPersonaRegistry.get(agentId) : null;
  const isCoreToolsLockedForCount = countPersona?.coreToolsLocked ?? true;

  let filteredSchemas = schemas.filter((toolSchema) =>
    isSchemaIncludedInHeaderCount(
      toolSchema as Record<string, unknown>,
      enabledSet,
      isCoreToolsLockedForCount,
    ),
  );
  if (countPersona?.blockedTools?.length) {
    const disabledSet = resolveToolEntriesToSet(countPersona.blockedTools, schemas);
    filteredSchemas = filteredSchemas.filter(
      (toolSchema) =>
        !disabledSet.has(toolSchema.name as string) || enabledSet.has(toolSchema.name as string),
    );
  }
  return filteredSchemas.filter((toolSchema) => !lockedOffToolNames.has(toolSchema.name as string)).length;
}

function appendGuidelineSections(
  isDirectMode: boolean,
  persona: ReturnType<typeof AgentPersonaRegistry.get>,
  codingFallback: boolean,
  locale: string,
  sections: string[],
): void {
  if (isDirectMode) return;
  if (persona?.guidelines) {
    sections.push(persona.guidelines);
  } else if (codingFallback || persona?.usesCodingGuidelines) {
    sections.push(
      PromptLocaleService.get(locale, "system-prompt.codingGuidelines") +
        PromptLocaleService.get(locale, "system-prompt.commandExecutionGuidelines"),
    );
  }
}

async function buildOrchestratorAddendumSection(
  context: AssemblerContext,
  persona: ReturnType<typeof AgentPersonaRegistry.get>,
  defaultTopology: string,
  locale: string,
): Promise<string | null> {
  if (persona?.coreToolsLocked === false) return null;
  let resolvedEnabledSet: Set<string> | null = null;
  if (context.enabledTools) {
    const hasPrefixed = context.enabledTools.some(
      (entry) => entry.startsWith("domain:") || entry.startsWith("domainKey:"),
    );
    const schemas = hasPrefixed ? ToolOrchestratorService.getClientToolSchemas(defaultTopology, locale) : [];
    resolvedEnabledSet = hasPrefixed ? resolveToolEntriesToSet(context.enabledTools, schemas) : new Set(context.enabledTools);
  }
  const orchestratorAvailable = resolvedEnabledSet
    ? ORCHESTRATOR_ONLY_TOOLS.some((toolName: string) => resolvedEnabledSet.has(toolName))
    : true;
  if (!orchestratorAvailable) return null;

  const allSchemas = ToolOrchestratorService.getToolSchemas(defaultTopology, locale);
  const orchestratorSet = new Set(ORCHESTRATOR_ONLY_TOOLS);
  const lockedOffSet = await resolveLockedOffToolNames();
  const enabledToolNames = resolveEnabledOrchestratorToolNames(context, allSchemas, defaultTopology, locale);
  const subAgentTools = enabledToolNames.filter(
    (toolName) => !orchestratorSet.has(toolName) && !lockedOffSet.has(toolName),
  );
  return getOrchestratorPromptAddendum({ subAgentTools, defaultTopology, locale });
}

function resolveEnabledOrchestratorToolNames(
  context: AssemblerContext,
  allSchemas: Array<{ name?: unknown }>,
  defaultTopology: string,
  locale: string,
): string[] {
  if (context.resolvedToolNames?.length) {
    return context.resolvedToolNames;
  }
  if (context.enabledTools?.length) {
    const hasPrefixed = context.enabledTools.some(
      (entry) => entry.startsWith("domain:") || entry.startsWith("domainKey:"),
    );
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology, locale);
    const enabledSet = hasPrefixed
      ? resolveToolEntriesToSet(context.enabledTools, clientSchemas)
      : new Set(context.enabledTools);
    return allSchemas
      .map((tool) => tool.name as string)
      .filter((toolName) => enabledSet.has(toolName) || CORE_AGENTIC_TOOLS.has(toolName));
  }
  return allSchemas.map((tool) => tool.name as string);
}

function appendEnvironmentSection(
  isWorkspaceEnabled: boolean,
  workspaceRoot: string,
  locale: string,
  sections: string[],
): void {
  const environmentLines = [PromptLocaleService.get(locale, "system-prompt.environmentOsLine")];
  if (isWorkspaceEnabled) {
    environmentLines.push(
      PromptLocaleService.get(locale, "system-prompt.environmentWorkspaceLine", { workspaceRoot }),
    );
  }
  sections.push(PromptLocaleService.get(locale, "system-prompt.environmentHeader") + `\n` + environmentLines.join(`\n`));
}

async function fetchMemoriesAndWorkflowsForPrompt(
  scorer: SystemPromptAssembler["scorer"],
  context: AssemblerContext,
  agentId: string,
  memoryQuery: string,
): Promise<{ memoriesText: string; workflowsText: string }> {
  const agentContextForMemory = context.agentContext || {};
  const memories = await scorer.fetchMemories(agentId, context.project || null, memoryQuery, {
    traceId: context.traceId,
    agentConversationId: context.agentConversationId,
    conversationId: context.conversationId as string | null,
    endpoint: "/agent",
    _username: context.username,
    guildId: agentContextForMemory.guildId,
    userIds: agentContextForMemory.participantUserIds,
  });
  const memoriesText = memories ? `${PROMPT_DELIMITERS.AGENT_MEMORY}\n` + memories : "";
  let workflowsText = "";
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
    if (workflows) workflowsText = workflows;
  } catch (error: unknown) {
    logger.error(`[SystemPromptAssembler] Workflow memory retrieval failed: ${getErrorMessage(error)}`);
  }
  return { memoriesText, workflowsText };
}

async function fetchLearnedContextBlocks(
  scorer: SystemPromptAssembler["scorer"],
  context: AssemblerContext,
  agentId: string,
  isTradingRun: boolean,
  withoutLearnedState: boolean,
): Promise<{
  skillNames: string[];
  skillsText: string;
  memoriesText: string;
  workflowsText: string;
}> {
  const lastUserMessage = [...(context.messages || [])].reverse().find((message) => message.role === "user");
  const queryText = (lastUserMessage?.content as string) || "";

  const skills = isTradingRun
    ? []
    : await scorer.fetchSkills(context.project || null, context.username || "", queryText, {
        traceId: context.traceId,
        agentConversationId: context.agentConversationId,
        endpoint: "/agent",
        agent: agentId,
      });
  const skillNames: string[] = [];
  let skillsText = "";
  if (skills.length > 0) {
    const skillBlocks = skills.map((s) => {
      skillNames.push(s.name);
      return `### ${s.name}\n${s.content}`;
    });
    skillsText = `${PROMPT_DELIMITERS.PROJECT_SKILLS}\n` + skillBlocks.join("\n\n");
  }

  const memoryQuery = queryText || context.project || "";
  if (!memoryQuery || withoutLearnedState) {
    return { skillNames, skillsText, memoriesText: "", workflowsText: "" };
  }
  const { memoriesText, workflowsText } = await fetchMemoriesAndWorkflowsForPrompt(
    scorer,
    context,
    agentId,
    memoryQuery,
  );
  return { skillNames, skillsText, memoriesText, workflowsText };
}

function formatDatedSystemSections(sections: string[]): string[] {
  const now = new Date();
  const tz = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currentDateLine =
    `Current date: ${new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)}` +
    ` (${new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "long" }).format(now)}), timezone ${tz}`;
  const datedSections = sections
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.startsWith("Current date: "))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
  datedSections.unshift(currentDateLine);
  return datedSections;
}

export { SystemPromptAssembler };
