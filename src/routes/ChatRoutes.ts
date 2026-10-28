import {
  APPROVAL_TIERS,
  decideToolCall,
  deniedToolResult,
  toolTier,
} from "../services/ToolAuthorization.ts";
import type { PolicyRule } from "../services/PolicyEngine.ts";
import { scheduleToolCalls } from "../utils/ToolScheduling.ts";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import {
  formatCostTag,
  roundMilliseconds,
} from "@rodrigo-barraza/utilities-library";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  DEFAULT_TOPOLOGY,
  DEFAULT_CONVERSATION_TITLE,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import express, { Request, Response, NextFunction } from "express";
import {
  finalizeTextGeneration,
  getCollectionOpts,
  sanitizeMessagesForPersistence,
} from "../services/harnesses/lifecycle/Finalizer.ts";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import { ProviderError } from "../utils/errors.ts";
import {
  TYPES,
  getDefaultModels,
  getPricing,
  getModelByName,
  getAgentDefaults,
} from "../config.ts";
import {
  estimateTokens,
  calculateImageCost,
  mergeUsage,
  withTotalInputTokens,
} from "../utils/CostCalculator.ts";
import type { TokenUsage } from "../types/admin.ts";
import type {
  ToolCallPayload,
  TokenUsage as FinalizerTokenUsage,
} from "../services/RequestLogger.ts";
import logger from "../utils/logger.ts";
import RequestLogger from "../services/RequestLogger.ts";
import FileService from "../services/FileService.ts";
import {
  createStreamState,
  dispatchChunk,
} from "../utils/StreamChunkDispatcher.ts";
import { resolveMessageMediaReferences } from "../services/MediaResolutionService.ts";

import ConversationGenerationTracker from "../services/ConversationGenerationTracker.ts";
import ToolOrchestratorService from "../services/ToolOrchestratorService.ts";
import localModelQueue from "../services/LocalModelQueue.ts";
import LocalProviderGateway from "../services/local-provider/index.ts";
import { getInstancesByType, getInstanceType, getInstance } from "../providers/instance-registry.ts";
import { resolveModelForInstances } from "../utils/ModelResolution.ts";
import {
  markGenerating,
  appendAndFinalize,
} from "../utils/ConversationUtilities.ts";
import { handleSseRequest, handleJsonRequest } from "../utils/SseUtilities.ts";
import { wantsSse } from "../utils/StreamNegotiation.ts";
import { SseEvent } from "../types/SseTypes.ts";
import { ChatRequestSchema } from "../types/index.ts";
import type {
  ConversationMessage,
  EmitFunction,
  ToolSchema,
} from "../services/harnesses/types.ts";
import type { ChatMessage } from "../types/ProviderTypes.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import { PROVIDERS, FILE_CATEGORIES } from "../constants.ts";

interface ToolSchemaWithDomain extends ToolSchema {
  domain?: string;
}

const router = express.Router();
function injectToolsIntoSystemPrompt(
  messages: Array<{ role: string; content?: string; [key: string]: unknown }>,
  tools: ToolSchemaWithDomain[],
) {
  if (!tools || tools.length === 0) {
    return;
  }

  const groups = new Map<string, ToolSchemaWithDomain[]>();
  for (const tool of tools) {
    const domain = ((tool.domain as string) || "Other").replace(
      /^Agentic:\s*/i,
      "",
    );
    if (!groups.has(domain)) {
      groups.set(domain, []);
    }
    groups.get(domain)!.push(tool);
  }

  const sections: string[] = [];
  for (const [domain, domainTools] of groups) {
    const entries = domainTools.map((tool) => {
      const description = (tool.description as string) || "";
      const parameters =
        ((tool.parameters as Record<string, unknown>)?.properties as Record<
          string,
          Record<string, unknown>
        >) || {};
      const parameterNames = Object.keys(parameters);
      const required = ((tool.parameters as Record<string, unknown>)
        ?.required || []) as string[];
      const parameterString = parameterNames
        .map((parameterName) => {
          const isRequired = required.includes(parameterName);
          const parameterDescription =
            (parameters[parameterName].description as string) || "";
          return `  - ${parameterName}${isRequired ? " (required)" : ""}: ${parameterDescription}`;
        })
        .join("\n");

      return `### ${tool.name}\n${description}\n${parameterString}`;
    });

    sections.push(`**${domain}**\n${entries.join("\n\n")}`);
  }

  const toolsSection =
    `\n\n## Enabled Tools (${tools.length})\n` + sections.join("\n\n");

  const systemMessage = messages.find((message) => message.role === "system");
  if (systemMessage) {
    if (
      typeof systemMessage.content === "string" &&
      !systemMessage.content.includes("## Enabled Tools")
    ) {
      systemMessage.content += toolsSection;
    }
  } else {
    messages.unshift({
      role: "system",
      content:
        `You are a helpful AI assistant with access to a comprehensive suite of real-time data and utility tools. Present data clearly with relevant formatting. For questions that don't require API data, respond naturally without tool calls.` +
        toolsSection,
    });
  }
}
// ─── parameter parsing, validation, model resolution ────────

const NON_NULL_OPTION_KEYS = [
  "temperature",
  "maxTokens",
  "topP",
  "topK",
  "frequencyPenalty",
  "presencePenalty",
  "minP",
  "repeatPenalty",
  "thinkingEnabled",
  "thinkingBudget",
  "webSearch",
  "webFetch",
  "codeExecution",
  "urlContext",
  "functionCallingEnabled",
  "agenticLoopEnabled",
  "forceImageGeneration",
  "responseFormat",
  "serviceTier",
  "textOnly",
  "autoApprove",
  "planFirst",
  "maxIterations",
  "maxSubAgentIterations",
  "maxRecursionDepth",
  "agentContext",
  "enableCriticGate",
  "criticModel",
  "workspaceEnabled",
  "harness",
  "topology",
  "thoughtStructure",
  "parallelToolCalls",
  "candidateCount",
  "branchCount",
  "store",
  "responseLogprobs",
] as const;

const TRUTHY_OPTION_KEYS = [
  "tools",
  "stopSequences",
  "reasoningEffort",
  "thinkingLevel",
  "verbosity",
  "reasoningSummary",
  "enabledTools",
  "disabledTools",
  "minContextLength",
  "evalBatchSize",
] as const;

const NON_EMPTY_OPTION_KEYS = [
  "seed",
  "responseMimeType",
  "mediaResolution",
  "locale",
] as const;

const POSITIVE_NUM_OPTION_KEYS = ["topLogprobs", "logprobs"] as const;

function validateIncomingChatRequest(params: Record<string, unknown>) {
  const parseResult = ChatRequestSchema.safeParse(params);
  if (parseResult.success) {
    return parseResult.data;
  }
  const hasProvider = Boolean(
    params && "provider" in params && params.provider !== undefined && params.provider !== null,
  );
  if (!hasProvider) {
    throw new ProviderError("server", "Missing required field: provider", 400);
  }
  const hasMessagesArray = Boolean(
    params && "messages" in params && Array.isArray(params.messages),
  );
  if (!hasMessagesArray) {
    throw new ProviderError(
      "server",
      "Missing or invalid field: messages (must be an array)",
      400,
    );
  }
  const issueMessages = parseResult.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  throw new ProviderError(
    "server",
    `Validation failed: ${issueMessages.join("; ")}`,
    400,
  );
}

function buildOptionsFromValidatedParams(
  validatedParams: Record<string, unknown>,
  extraSystemPrompt: unknown,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const key of TRUTHY_OPTION_KEYS) {
    if (validatedParams[key]) {
      options[key] = validatedParams[key];
    }
  }
  for (const key of NON_NULL_OPTION_KEYS) {
    if (validatedParams[key] != null) {
      options[key] = validatedParams[key];
    }
  }
  for (const key of NON_EMPTY_OPTION_KEYS) {
    const val = validatedParams[key];
    if (val != null && val !== "") {
      options[key] = val;
    }
  }
  for (const key of POSITIVE_NUM_OPTION_KEYS) {
    const val = validatedParams[key];
    if (typeof val === "number" && val > 0) {
      options[key] = val;
    }
  }
  if (extraSystemPrompt) {
    options.systemPrompt = extraSystemPrompt;
  }
  return options;
}

function synchronizeThinkingOptions(
  options: Record<string, unknown>,
  thinkingEnabled: boolean | null | undefined,
): void {
  if (thinkingEnabled === false) {
    delete options.reasoningEffort;
    delete options.thinkingLevel;
    delete options.thinkingBudget;
    return;
  }
  if (options.thinkingLevel && !options.reasoningEffort) {
    options.reasoningEffort = options.thinkingLevel;
  }
  if (options.reasoningEffort && !options.thinkingLevel) {
    options.thinkingLevel = options.reasoningEffort;
  }
}

async function applyAgentPersonaDefaults(
  agent: string | undefined,
  options: Record<string, unknown>,
  thinkingEnabled: boolean | null | undefined,
): Promise<boolean | undefined> {
  if (!agent) return undefined;
  const { default: AgentPersonaRegistry } = await import("../services/AgentPersonaRegistry.ts");
  if (!AgentPersonaRegistry.has(agent)) {
    throw new ProviderError("server", `Unknown agent: "${agent}"`, 400);
  }
  const persona = AgentPersonaRegistry.get(agent);
  const personaThinkingDefault = persona?.thinkingDefault;
  const personaPolicies = persona?.policies;
  if (personaPolicies && personaPolicies.length > 0) {
    options.policies = personaPolicies;
  }
  if (personaThinkingDefault !== undefined && thinkingEnabled == null) {
    options.thinkingEnabled = personaThinkingDefault;
  }
  const agentDefaultValues = getAgentDefaults();
  for (const [parameterKey, defaultValue] of Object.entries(agentDefaultValues)) {
    if (options[parameterKey] == null) {
      options[parameterKey] = defaultValue;
    }
  }
  return personaThinkingDefault;
}

async function resolveDynamicVllmModelIfNeeded(
  providerName: string,
  resolvedModel: string | undefined,
): Promise<{ providerName: string; resolvedModel: string | undefined }> {
  if (resolvedModel || !providerName.startsWith("vllm")) {
    return { providerName, resolvedModel };
  }
  const siblings = getInstancesByType(providerName);
  for (const sibling of siblings) {
    const p = getProvider(sibling.id);
    if (!p?.listModels) continue;
    try {
      const res = (await p.listModels()) as unknown as { models?: Array<Record<string, string>>; data?: Array<Record<string, string>> } | null;
      const models = res?.models ?? res?.data ?? [];
      if (models.length > 0) {
        const first = models[0];
        return {
          providerName: sibling.id,
          resolvedModel: first.id ?? first.key ?? first.name,
        };
      }
    } catch (e) {
      logger.warn(`[ChatRoutes] Failed to dynamically fetch models for ${sibling.id}:`, e);
    }
  }
  return { providerName, resolvedModel };
}

function selectLeastLoadedSibling(
  siblings: Array<{ id: string; concurrency: number }>,
  defaultId: string,
): string {
  let bestId = defaultId;
  let lowestLoad = Infinity;
  for (const inst of siblings) {
    const queueState = localModelQueue._getQueue(inst.id);
    const load = queueState.totalInflight / inst.concurrency;
    const bestConcurrency = getInstance(bestId)?.concurrency ?? 0;
    const isTieBreakerBetter = load === lowestLoad && inst.concurrency > bestConcurrency;
    if (load < lowestLoad || isTieBreakerBetter) {
      lowestLoad = load;
      bestId = inst.id;
    }
  }
  return bestId;
}

async function resolvePinnedLocalInstance(
  providerName: string,
  pinnedInstanceType: string,
  resolvedModel: string,
): Promise<string> {
  const pinnedSiblings = getInstancesByType(pinnedInstanceType).filter(
    (instance) => instance.id === providerName,
  );
  if (pinnedSiblings.length === 0) {
    return resolvedModel;
  }
  const { modelOverrides } = await resolveModelForInstances(resolvedModel, pinnedSiblings);
  const override = modelOverrides.get(providerName);
  const nextModel = override ?? resolvedModel;
  logger.info(
    `[chat] 📌 Instance pinned: ${pinnedInstanceType} → ${providerName}` +
      (override ? ` (model="${nextModel}")` : ""),
  );
  return nextModel;
}

async function balanceLocalProviderInstances(
  providerName: string,
  resolvedModel: string,
  requestedModel: string | undefined,
): Promise<{ providerName: string; resolvedModel: string }> {
  let siblings = getInstancesByType(providerName);
  const { usable, modelOverrides } = await resolveModelForInstances(resolvedModel, siblings);
  if (usable.length > 0) {
    siblings = usable;
    const singleOverride = siblings.length === 1 ? modelOverrides.get(siblings[0].id) : undefined;
    if (singleOverride) {
      resolvedModel = singleOverride;
      logger.info(`[chat] Model resolved: "${requestedModel}" → "${resolvedModel}" (single instance)`);
    }
  } else {
    logger.warn(
      `[chat] Model "${resolvedModel}" not available on any ${providerName} instance — falling back to first`,
    );
  }
  if (siblings.length <= 1) {
    return { providerName, resolvedModel };
  }
  const bestId = selectLeastLoadedSibling(siblings, providerName);
  if (bestId !== providerName) {
    resolvedModel = modelOverrides.get(bestId) ?? resolvedModel;
    logger.info(
      `[chat] ⚖️ Load balance: ${providerName} → ${bestId} ` +
        `(model="${resolvedModel}", ${siblings.map((sibling) => `${sibling.id}:active=${localModelQueue._getQueue(sibling.id).activeCount},queued=${localModelQueue._getQueue(sibling.id).pending}`).join(", ")})`,
    );
    providerName = bestId;
  }
  return { providerName, resolvedModel };
}

async function resolveLocalInstanceAndModel(
  providerName: string,
  resolvedModel: string,
  requestedModel: string | undefined,
): Promise<{ providerName: string; resolvedModel: string }> {
  if (!localModelQueue.isLocal(providerName)) {
    return { providerName, resolvedModel };
  }
  const pinnedInstanceType = getInstanceType(providerName);
  if (pinnedInstanceType !== null && pinnedInstanceType !== providerName) {
    const nextModel = await resolvePinnedLocalInstance(providerName, pinnedInstanceType, resolvedModel);
    return { providerName, resolvedModel: nextModel };
  }
  return balanceLocalProviderInstances(providerName, resolvedModel, requestedModel);
}

async function acquireLocalGpuSlotIfNeeded(
  providerName: string,
  resolvedModel: string,
): Promise<(() => void) | null> {
  if (!localModelQueue.isLocal(providerName)) {
    return null;
  }
  const localRelease = await localModelQueue.acquire(providerName);
  const queueState = localModelQueue._getQueue(providerName);
  logger.info(
    `[chat] 🔒 Acquired local GPU slot for ${resolvedModel} (${providerName}) ` +
      `(${queueState.activeCount}/${queueState.maxConcurrency} active` +
      (queueState.pending > 0 ? `, ${queueState.pending} queued)` : ")"),
  );
  return localRelease;
}

/**
 * Parse and validate incoming request parameters, resolve images,
 * model, and acquire GPU lock if needed.
 *
 * Returns a prepared context object shared by handleConversation
 * and handleAgent, or throws on validation failure.
 */
async function prepareGenerationContext(
  params: Record<string, unknown>,
  emit: EmitFunction,
  { signal }: { signal?: AbortSignal } = {},
) {
  const requestStart = performance.now();
  const requestId = crypto.randomUUID();
  const validatedParams = validateIncomingChatRequest(params);

  const {
    provider: _providerName,
    model: requestedModel,
    messages,
    conversationId: incomingConversationId,
    agentConversationId: incomingAgentConversationId,
    conversationMeta: incomingConversationMeta,
    traceId: incomingTraceId,
    project,
    username,
    clientIp,
    agent,
    thinkingEnabled,
    skipConversation,
    workspaceRoot,
    ...extraParams
  } = validatedParams;

  const options = buildOptionsFromValidatedParams(
    validatedParams as Record<string, unknown>,
    (extraParams as Record<string, unknown>).systemPrompt,
  );
  synchronizeThinkingOptions(options, thinkingEnabled);

  const personaThinkingDefault = await applyAgentPersonaDefaults(
    agent,
    options,
    thinkingEnabled,
  );

  LocalProviderGateway.applyLocalDefaults(_providerName, options, {
    thinkingEnabled: thinkingEnabled ?? personaThinkingDefault ?? undefined,
  });

  const activeMessages = messages.filter((message) => !message.deleted);
  const providerMessages = await resolveMessageMediaReferences(
    activeMessages as ConversationMessage[],
    project,
    username,
  );

  const initialModel =
    requestedModel ||
    getDefaultModels(TYPES.TEXT, TYPES.TEXT)[_providerName as string];

  const vllmResolved = await resolveDynamicVllmModelIfNeeded(_providerName, initialModel);
  const { providerName, resolvedModel } = await resolveLocalInstanceAndModel(
    vllmResolved.providerName,
    vllmResolved.resolvedModel as string,
    requestedModel,
  );

  const provider = getProvider(providerName);
  const modelDefinition = getModelByName(resolvedModel);
  const isImageAPIModel =
    (modelDefinition as Record<string, unknown> | null)?.imageAPI &&
    provider.generateImage;

  const localRelease = await acquireLocalGpuSlotIfNeeded(providerName, resolvedModel);
  const userMessage =
    messages?.filter((message) => message.role === "user").pop() || null;

  return {
    provider,
    providerName,
    resolvedModel,
    requestedModel,
    modelDefinition,
    isImageAPIModel,
    messages: providerMessages,
    originalMessages: activeMessages,
    rawMessages: messages,
    options,
    userMessage,
    // Identity
    incomingConversationId,
    incomingAgentConversationId: incomingAgentConversationId || null,
    agentConversationId: incomingAgentConversationId || null,
    incomingConversationMeta,
    incomingTraceId,
    skipConversation,
    project,
    username,
    clientIp,
    agent,
    // Multi-workspace
    workspaceRoot: workspaceRoot || null,
    // Timing
    requestStart,
    requestId,
    // Control
    emit,
    signal,
    localRelease,
  };
}

// ─── Chat / Conversation persistence path ───────────────────

function resolveChatConversationIdentity(
  context: Awaited<ReturnType<typeof prepareGenerationContext>>,
) {
  let conversationId = context.skipConversation ? null : context.incomingConversationId;
  let conversationMeta = context.skipConversation ? null : context.incomingConversationMeta;
  if (!context.skipConversation && !conversationId) {
    conversationId = crypto.randomUUID();
    const firstUserMessage = (context.rawMessages as ConversationMessage[])
      ?.filter((conversationMessage) => conversationMessage.role === "user")
      .pop();
    const titleSnippet =
      (firstUserMessage?.content || "").slice(0, 100).trim() ||
      DEFAULT_CONVERSATION_TITLE;
    conversationMeta = conversationMeta || { title: titleSnippet };
  }
  const traceId = context.incomingTraceId || null;
  if (traceId && conversationMeta) {
    (conversationMeta as Record<string, unknown>).traceId = traceId;
  } else if (traceId) {
    conversationMeta = { traceId };
  }
  return {
    conversationId: conversationId || null,
    conversationMeta,
    traceId,
  };
}

function filterChatFunctionCallingTools(
  builtInTools: ReturnType<typeof ToolOrchestratorService.getToolSchemas>,
  options: Record<string, unknown>,
): ReturnType<typeof ToolOrchestratorService.getToolSchemas> {
  if (Array.isArray(options.enabledTools)) {
    const enabledSet = new Set(options.enabledTools as string[]);
    return builtInTools.filter((toolItem) => enabledSet.has(toolItem.name));
  }
  if (Array.isArray(options.disabledTools)) {
    const disabledSet = new Set(options.disabledTools as string[]);
    return builtInTools.filter((toolItem) => !disabledSet.has(toolItem.name));
  }
  return builtInTools;
}

async function configureChatFunctionCallingTools(
  fullContext: GenerationContext,
): Promise<void> {
  const { options, providerName, resolvedModel, modelDefinition } = fullContext;
  if (!options.functionCallingEnabled || options.agenticLoopEnabled) {
    return;
  }
  const useNativeMcp = LocalProviderGateway.isNativeMCP(providerName);
  const { default: SettingsService } = await import("../services/SettingsService.ts");
  const settings = await SettingsService.getSection("agents");
  const defaultTopology =
    (options.topology as string) || settings?.topology || DEFAULT_TOPOLOGY;
  const builtInTools = ToolOrchestratorService.getToolSchemas(defaultTopology);
  const tools = filterChatFunctionCallingTools(builtInTools, options);
  options.tools = tools;

  injectToolsIntoSystemPrompt(
    fullContext.messages as Array<{
      role: string;
      content?: string;
      [key: string]: unknown;
    }>,
    tools as ToolSchemaWithDomain[],
  );

  const modelContextLength = (modelDefinition as Record<string, unknown> | null)?.contextLength;
  if (useNativeMcp && modelContextLength) {
    options.contextLength = modelContextLength;
  }

  logger.info(
    `[chat] FC tools resolved and injected into system prompt: ${tools.length} tools enabled for ${providerName} ${resolvedModel}`,
  );
}

async function persistFailedConversationState(
  fullContext: GenerationContext,
  error: unknown,
): Promise<void> {
  const { conversationId, project, username, conversationMeta, userMessage } = fullContext;
  if (!conversationId) return;
  try {
    const partialAssistantText =
      ((fullContext as Record<string, unknown>).partialAssistantText as string | undefined) || "";
    const failureMessages = sanitizeMessagesForPersistence([
      ...(userMessage ? [userMessage as ConversationMessage] : []),
      {
        role: "assistant",
        content: partialAssistantText,
        error: getErrorMessage(error),
      } as ConversationMessage,
    ]);
    await appendAndFinalize(
      conversationId,
      project,
      username as string,
      failureMessages,
      conversationMeta,
      getCollectionOpts(project),
    );
  } catch (persistError: unknown) {
    logger.warn(
      `[chat] Failed to persist error state for ${conversationId}: ${getErrorMessage(persistError)}`,
    );
  }
}

async function handleConversationFailure(
  fullContext: GenerationContext,
  error: unknown,
): Promise<void> {
  const {
    conversationId,
    project,
    username,
    clientIp,
    providerName,
    resolvedModel,
    requestedModel,
    traceId,
    requestStart,
    requestId,
    rawMessages,
    options,
    emit,
  } = fullContext;
  markGenerating(
    conversationId,
    project,
    username,
    false,
    getCollectionOpts(project),
  );
  await persistFailedConversationState(fullContext, error);
  const totalSec = (performance.now() - requestStart) / 1000;
  RequestLogger.logChatGeneration({
    requestId,
    endpoint: "/chat",
    operation: "chat",
    project,
    username,
    clientIp,
    provider: providerName,
    model: resolvedModel || requestedModel || "any",
    conversationId: conversationId || null,
    traceId: traceId || null,
    success: false,
    errorMessage: getErrorMessage(error),
    totalSec,
    messages: rawMessages || [],
    options,
  });
  emit({
    type: SERVER_SENT_EVENT_TYPES.ERROR,
    message: getErrorMessage(error),
  });
}

/**
 * Handle a conversation request: text generation, image generation,
 * vision/captioning — with conversationId-based persistence.
 *
 * Used by the /chat route and any non-agent callers.
 */
export async function handleConversation(
  params: Record<string, unknown>,
  emit: EmitFunction,
  { signal }: { signal?: AbortSignal } = {},
) {
  let context: Awaited<ReturnType<typeof prepareGenerationContext>> | null =
    null;
  try {
    context = await prepareGenerationContext(params, emit, { signal });
  } catch (error: unknown) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.ERROR,
      message: getErrorMessage(error),
      ...(error instanceof ProviderError && { statusCode: error.statusCode }),
    });
    return;
  }
  const { providerName, resolvedModel, modelDefinition, localRelease } = context;
  const identity = resolveChatConversationIdentity(context);
  const fullContext: GenerationContext = {
    ...context,
    ...identity,
    agentConversationId: null,
  };
  try {
    try {
      if (context.isImageAPIModel) {
        await handleImageAPIModel(fullContext);
        return;
      }
      if (!context.provider.generateTextStream && !context.provider.generateText) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      await configureChatFunctionCallingTools(fullContext);

      const useStreaming =
        typeof context.provider.generateTextStream === "function" &&
        (modelDefinition as Record<string, unknown> | null)?.streaming !== false;
      if (useStreaming) {
        await handleStreamingText(fullContext);
      } else {
        await handleNonStreamingText(fullContext);
      }
    } finally {
      if (localRelease) {
        localRelease();
        logger.info(`[chat] 🔓 Released local GPU lock for ${resolvedModel}`);
      }
    }
  } catch (error: unknown) {
    await handleConversationFailure(fullContext, error);
  }
}
// ─── Agent conversation path (agentConversationId, no conversationId) ─
/**
 * Handle an agent request: always dispatches to AgenticLoopService.
 * Persistence uses agentConversationId (not conversationId).
 *
 * Used exclusively by the /agent route.
 */
export async function handleAgent(
  params: Record<string, unknown>,
  emit: (event: SseEvent) => void,
  { signal }: { signal?: AbortSignal } = {},
) {
  let context: Awaited<ReturnType<typeof prepareGenerationContext>> | null =
    null;
  try {
    context = await prepareGenerationContext(params, emit, { signal });
  } catch (error: unknown) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.ERROR,
      message: getErrorMessage(error),
      ...(error instanceof ProviderError && { statusCode: error.statusCode }),
    });
    return;
  }
  const {
    providerName,
    resolvedModel,
    requestedModel,
    options,
    incomingConversationId,
    agentConversationId,
    incomingConversationMeta,
    incomingTraceId,
    project,
    username,
    clientIp,
    agent,
    requestStart,
    requestId,
    localRelease,
  } = context;
  // ── Agent conversation identity ─────────────────────────────────
  const resolvedAgentConversationId = agentConversationId || crypto.randomUUID();
  const conversationId = incomingConversationId || crypto.randomUUID();
  const traceId = incomingTraceId || null;
  const conversationMeta = incomingConversationMeta || null;
  // ── Eager conversation stub ───────────────────────────────────────
  // Create the conversation document immediately via upsert so that
  // GET /agent-conversations/:id never 404s while the loop is running
  // (e.g. when the user switches away and back during generation).
  markGenerating(conversationId, project, username, true, {
    ...getCollectionOpts(project, agent),
    agent: agent ?? undefined,
    agentConversationId: resolvedAgentConversationId,
    title:
      typeof conversationMeta?.title === "string"
        ? conversationMeta.title
        : undefined,
  });
  try {
    try {
      if (
        !context!.provider.generateTextStream &&
        !context!.provider.generateText
      ) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      const { default: AgenticLoopService } =
        await import("../services/AgenticLoopService.js");

      await AgenticLoopService.runAgenticLoop({
        provider:
          context.provider as import("../services/harnesses/types.ts").LLMProvider,
        providerName,
        resolvedModel,
        modelDefinition: context.modelDefinition,
        messages: context.messages,
        originalMessages: context.originalMessages as ConversationMessage[],
        options,
        agentConversationId: resolvedAgentConversationId,
        conversationId,
        isNewConversation: !incomingConversationId,
        userMessage: context.userMessage as ConversationMessage | null,
        conversationMeta,
        traceId,
        project,
        username,
        clientIp,
        agent,
        workspaceRoot: context.workspaceRoot,
        requestId,
        requestStart,
        emit,
        signal,
      });
    } finally {
      if (localRelease) {
        localRelease();
        logger.info(`[agent] 🔓 Released local GPU lock for ${resolvedModel}`);
      }
      // When the SSE connection is severed (user pressed stop), abort any
      // spawned sub-agents that are still running under this orchestrator session.
      if (signal?.aborted) {
        try {
          const { default: OrchestratorService } =
            await import("../services/OrchestratorService.js");
          await OrchestratorService.abortSubAgentsByConversation(
            conversationId,
          );
        } catch (cleanupError: unknown) {
          logger.warn(
            `[agent] Sub-agent cleanup failed: ${getErrorMessage(cleanupError)}`,
          );
        }
      }
    }
  } catch (error: unknown) {
    markGenerating(
      conversationId,
      project,
      username,
      false,
      getCollectionOpts(project, agent),
    );
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.logChatGeneration({
      requestId,
      endpoint: "/agent",
      operation: "agent",
      project,
      username,
      clientIp,
      agent: agent || null,
      harness: (options.harness as string) || null,
      provider: providerName,
      model: resolvedModel || requestedModel || "any",
      agentConversationId: resolvedAgentConversationId,
      conversationId: conversationId || null,
      traceId: traceId || null,
      success: false,
      errorMessage: getErrorMessage(error),
      totalSec,
      messages: context.rawMessages || [],
      options,
    });
    emit({
      type: SERVER_SENT_EVENT_TYPES.ERROR,
      message: getErrorMessage(error),
    });
  }
}
// ─── Dispatch: Image API models (e.g. GPT Image 1.5, OpenAI images) ─
async function handleImageAPIModel(
  context: Awaited<ReturnType<typeof prepareGenerationContext>> & {
    conversationId?: string | null;
    conversationMeta?: Record<string, unknown> | null;
    traceId?: string | null;
  },
) {
  const {
    provider,
    providerName,
    resolvedModel,
    modelDefinition,
    messages,
    options,
    conversationId,
    userMessage,
    conversationMeta,
    traceId,
    project,
    username,
    clientIp,
    requestId,
    requestStart,
    emit,
  } = context;
  // Mark conversation as generating
  markGenerating(conversationId, project, username, true, {
    ...getCollectionOpts(project),
    title:
      typeof conversationMeta?.title === "string"
        ? conversationMeta.title
        : undefined,
  });
  const lastUserMessage = (messages as ConversationMessage[])
    .filter((conversationMessage) => conversationMessage.role === "user")
    .pop();
  const prompt = lastUserMessage?.content || "";
  // Collect all images from the conversation
  const allImages: string[] = [];
  for (const message of messages as ConversationMessage[]) {
    if (message.images && message.images.length > 0) {
      allImages.push(...message.images);
    }
  }
  if (!provider.generateImage) {
    throw new Error(
      `Provider "${providerName}" does not support image generation`,
    );
  }
  const result = await provider.generateImage(
    prompt,
    allImages,
    resolvedModel,
    options?.systemPrompt as string | undefined,
  );
  const totalSec = (performance.now() - requestStart) / 1000;
  // Cost calculation
  const imgPricing =
    getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel as string] ||
    (modelDefinition as Record<string, unknown> | null)?.pricing;
  const outputImgTokens =
    ((modelDefinition as Record<string, unknown> | null)
      ?.imageTokensPerImage as number) ||
    (providerName === PROVIDERS.OPENAI ? 1056 : 1120);
  const estimatedCost = calculateImageCost(
    prompt,
    imgPricing,
    allImages.length,
    outputImgTokens,
  );
  logger.request(
    project,
    username,
    clientIp,
    `[chat/image-api] ${providerName} ${resolvedModel} — ` +
      `total: ${totalSec.toFixed(2)}s` +
      formatCostTag(estimatedCost),
  );
  // Upload generated image to MinIO
  let minioRef: string | null = null;
  if (result.imageData) {
    try {
      const mimeType = result.mimeType || "image/png";
      const dataUrl = `data:${mimeType};base64,${result.imageData}`;
      const { ref } = await FileService.uploadFile(
        dataUrl,
        FILE_CATEGORIES.GENERATIONS,
        project,
        username,
      );
      minioRef = ref;
    } catch (uploadError: unknown) {
      logger.error(
        `[chat/image-api] MinIO upload failed: ${getErrorMessage(uploadError)}`,
      );
    }
  }
  // Estimate token counts for tracking
  const estimatedInputTokens =
    estimateTokens(prompt) +
    allImages.length *
      (((modelDefinition as Record<string, unknown> | null)
        ?.imageTokensPerImage as number) || 1120);
  RequestLogger.log({
    requestId,
    endpoint: "/chat",
    operation: "chat:image",
    project,
    username,
    clientIp,
    provider: providerName,
    model: resolvedModel,
    conversationId: conversationId || null,
    traceId: traceId || null,
    success: true,
    inputTokens: estimatedInputTokens,
    outputTokens: outputImgTokens,
    inputCharacters: prompt.length,
    outputCharacters: result.text ? result.text.length : 0,
    estimatedCost,
    totalTime: roundMilliseconds(totalSec),
  });
  // Emit events
  if (result.text) {
    emit({ type: SERVER_SENT_EVENT_TYPES.CHUNK, content: result.text });
  }
  emit({
    type: SERVER_SENT_EVENT_TYPES.IMAGE,
    data: result.imageData,
    mimeType: result.mimeType || "image/png",
    minioRef,
  });
  // Link conversation to session
  // Auto-append to conversation — persist BEFORE emitting `done`
  // so the client's post-stream DB fetch sees the complete conversation.
  if (conversationId) {
    const messagesToAppend: ConversationMessage[] = [];
    // Only append the user message on the first call for this turn
    // (indicated by conversationMeta). Follow-up tool iterations reuse
    // the same conversationId but omit conversationMeta, so the user
    // message is already persisted from the first call.
    if (userMessage && conversationMeta) {
      messagesToAppend.push({
        ...userMessage,
        role: "user",
        timestamp:
          (userMessage as ConversationMessage).timestamp ||
          new Date().toISOString(),
      } as ConversationMessage);
    }
    const assistantImages = minioRef ? [minioRef] : [];
    messagesToAppend.push({
      role: "assistant",
      content: result.text || "",
      ...(assistantImages.length > 0 && { images: assistantImages }),
      model: resolvedModel,
      provider: providerName,
      timestamp: new Date().toISOString(),
      totalTime: roundMilliseconds(totalSec),
      estimatedCost,
    });
    const meta = conversationMeta
      ? {
          ...conversationMeta,
          settings: { provider: providerName, model: resolvedModel },
        }
      : undefined;
    await appendAndFinalize(
      conversationId,
      project,
      username,
      messagesToAppend,
      meta,
      getCollectionOpts(project),
    );
  }
  emit({
    type: SERVER_SENT_EVENT_TYPES.DONE,
    usage: null,
    estimatedCost,
    totalTime: totalSec,
    ...(traceId && { traceId }),
    ...(conversationId && { conversationId }),
  });
}

type GenerationContext = Awaited<
  ReturnType<typeof prepareGenerationContext>
> & {
  conversationId: string | null;
  conversationMeta?: Record<string, unknown> | null;
  traceId?: string | null;
  agentConversationId: string | null;
};

type StreamStateType = ReturnType<typeof createStreamState>;
type StreamToolCallItem = StreamStateType["toolCalls"][number];

function isPendingChatToolCall(toolCall: StreamToolCallItem): boolean {
  if (toolCall.result) return false;
  return toolCall.status !== "done" && toolCall.status !== "error";
}

function getPendingChatToolCalls(streamState: StreamStateType): StreamToolCallItem[] {
  return streamState.toolCalls.filter(isPendingChatToolCall);
}

async function consumeChatProviderStream(
  stream: AsyncIterable<unknown> & { return?: () => unknown },
  streamState: StreamStateType,
  context: GenerationContext,
  logPrefix: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<void> {
  const { signal, providerName, resolvedModel, emit, project, username } = context;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        if (typeof stream.return === "function") stream.return();
        if (logPrefix === "chat/stream") {
          logger.info(
            `[chat] Client disconnected, aborting stream for ${providerName} ${resolvedModel}`,
          );
        }
        break;
      }
      await dispatchChunk(
        chunk as Record<string, unknown>,
        streamState,
        { emit, project, username },
        { onUsage, logPrefix },
      );
    }
  } catch (streamError: unknown) {
    (context as Record<string, unknown>).partialAssistantText = streamState.text;
    throw streamError;
  }
}

function isErrorToolExecutionResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return Boolean("error" in result && (result as { error?: unknown }).error);
}

async function executeAuthorizedChatToolCall(
  toolCall: StreamToolCallItem,
  context: GenerationContext,
  functionCallIteration: number,
): Promise<void> {
  const {
    project,
    username,
    agent,
    requestId,
    conversationId,
    traceId,
    clientIp,
    providerName,
    resolvedModel,
    emit,
  } = context;
  const startTime = Date.now();
  try {
    const result = await ToolOrchestratorService.executeTool(
      toolCall.name as string,
      toolCall.args as Record<string, unknown>,
      {
        project,
        username,
        agent: agent || null,
        requestId,
        conversationId: conversationId || null,
        traceId: traceId || null,
        clientIp: clientIp || null,
        iteration: functionCallIteration,
        _providerName: providerName,
        _resolvedModel: resolvedModel,
      },
    );
    const durationMs = Date.now() - startTime;
    toolCall.result = result;
    toolCall.status = isErrorToolExecutionResult(result) ? "error" : "done";
    toolCall.durationMs = durationMs;
    emit({
      type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
      result,
      status: toolCall.status,
      durationMs,
    });
  } catch (error: unknown) {
    const durationMs = Date.now() - startTime;
    toolCall.result = { error: getErrorMessage(error) };
    toolCall.status = "error";
    toolCall.durationMs = durationMs;
    emit({
      type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
      result: toolCall.result,
      status: "error",
      durationMs,
    });
  }
}

async function executeSingleChatToolCall(
  toolCall: StreamToolCallItem,
  context: GenerationContext,
  offeredToolNames: Set<string>,
  chatPolicies: PolicyRule[],
  functionCallIteration: number,
): Promise<void> {
  const { emit } = context;
  emit({
    type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
    status: "calling",
  });
  const authorization = decideToolCall({
    name: String(toolCall.name),
    args: (toolCall.args ?? {}) as Record<string, unknown>,
    isAllowListed: offeredToolNames.has(String(toolCall.name)),
    policies: chatPolicies,
    autoApprove: true,
    unattended: false,
  });
  if (authorization.verdict === "deny") {
    toolCall.result = deniedToolResult(String(toolCall.name), authorization);
    toolCall.status = "error";
    toolCall.durationMs = 0;
    emit({
      type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
      result: toolCall.result,
      status: "error",
      durationMs: 0,
    });
    return;
  }
  await executeAuthorizedChatToolCall(toolCall, context, functionCallIteration);
}

function serializeStreamToolCallEntry(toolCall: StreamToolCallItem): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
  };
  if (toolCall.responsesItemId) entry.responsesItemId = toolCall.responsesItemId;
  if (toolCall.thoughtSignature) entry.thoughtSignature = toolCall.thoughtSignature;
  if (toolCall.reasoningItem) entry.reasoningItem = toolCall.reasoningItem;
  return entry;
}

function buildChatToolFollowUpMessages(streamState: StreamStateType) {
  const assistantToolMessage: Record<string, unknown> = {
    role: "assistant",
    content: streamState.text || "",
    toolCalls: streamState.toolCalls.map(serializeStreamToolCallEntry),
  };
  if (streamState.thinking) {
    assistantToolMessage.thinking = streamState.thinking;
  }
  if (streamState.thinkingSignature) {
    assistantToolMessage.thinkingSignature = streamState.thinkingSignature;
  }
  const toolResultMsgs = streamState.toolCalls
    .filter((toolCall) => toolCall.result)
    .map((toolCall) => ({
      role: "tool",
      tool_call_id: toolCall.id,
      name: toolCall.name,
      content:
        typeof toolCall.result === "string"
          ? toolCall.result
          : JSON.stringify(toolCall.result),
    }));
  return { assistantToolMessage, toolResultMsgs };
}

async function runChatFunctionCallingIteration(
  context: GenerationContext,
  streamState: StreamStateType,
  offeredToolNames: Set<string>,
  chatPolicies: PolicyRule[],
  functionCallIteration: number,
): Promise<boolean> {
  const { provider, resolvedModel, messages, options, signal, emit } = context;
  const pendingCalls = getPendingChatToolCalls(streamState);
  if (pendingCalls.length === 0) return false;

  logger.info(
    `[chat/FC] Iteration ${functionCallIteration}: executing ${pendingCalls.length} tool call(s)`,
  );
  await scheduleToolCalls(
    pendingCalls,
    (toolCall) =>
      executeSingleChatToolCall(
        toolCall,
        context,
        offeredToolNames,
        chatPolicies,
        functionCallIteration,
      ),
    (call) => toolTier(String(call.name)) === APPROVAL_TIERS.AUTO,
    Math.max(1, Number(process.env.CHAT_TOOL_CONCURRENCY) || 4),
  );

  const { assistantToolMessage, toolResultMsgs } = buildChatToolFollowUpMessages(streamState);
  const updatedMessages = [
    ...messages,
    assistantToolMessage,
    ...toolResultMsgs,
  ];

  streamState.text = "";
  streamState.thinking = "";
  streamState.thinkingSignature = "";
  streamState.toolCalls.length = 0;

  const followUpStream = provider.generateTextStream(
    updatedMessages as ChatMessage[],
    resolvedModel,
    { ...options, signal },
  );
  const usageMerger = (followUpUsage: TokenUsage) => {
    if (streamState.usage) {
      mergeUsage(streamState.usage, followUpUsage);
    } else {
      streamState.usage = followUpUsage;
    }
  };
  await consumeChatProviderStream(followUpStream, streamState, context, "chat/FC", usageMerger);

  if (streamState.usage) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
      usage: {
        ...withTotalInputTokens(streamState.usage as TokenUsage),
        requests: functionCallIteration + 1,
      },
    });
  }
  (messages as Record<string, unknown>[]).push(
    assistantToolMessage,
    ...toolResultMsgs,
  );
  return true;
}

function applyChatTruncationWarningIfNeeded(
  streamState: StreamStateType,
  emit: EmitFunction,
): void {
  const isLengthStop =
    streamState.stopReason === "length" || streamState.stopReason === "max_tokens";
  if (!isLengthStop || streamState.text.trim()) {
    return;
  }
  const truncationWarning =
    `⚠️ The model's response was cut short because the **max_tokens** limit was reached ` +
    `before it could finish generating. Try increasing the **Max Tokens** setting.`;
  emit({
    type: SERVER_SENT_EVENT_TYPES.CHUNK,
    content: truncationWarning,
  });
  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message:
      (STATUS_MESSAGES as Record<string, string>).MAX_TOKENS_TRUNCATED ||
      "max_tokens_truncated",
    phase: "truncated",
  });
  streamState.text = truncationWarning;
}

function buildStreamFinalizationResult(
  streamState: StreamStateType,
  options: Record<string, unknown>,
  requestStart: number,
  now: number,
) {
  const timeToGenerationSec = streamState.firstTokenTime
    ? (streamState.firstTokenTime - requestStart) / 1000
    : null;
  const generationSec =
    streamState.firstTokenTime && streamState.generationEnd
      ? (streamState.generationEnd - streamState.firstTokenTime) / 1000
      : null;
  return {
    text: streamState.text,
    thinking: streamState.thinking,
    images: streamState.images,
    toolCalls: streamState.toolCalls.map(
      (toolCall): ToolCallPayload => ({
        name: toolCall.name,
        id: toolCall.id,
        args: toolCall.args as Record<string, unknown>,
        ...(toolCall.thoughtSignature
          ? { thoughtSignature: toolCall.thoughtSignature }
          : {}),
        durationMs: toolCall.durationMs,
      }),
    ),
    audioChunks: streamState.audioChunks,
    audioSampleRate: streamState.audioSampleRate,
    usage: streamState.usage as FinalizerTokenUsage | null,
    resolvedEnabledTools:
      (options.tools as ToolSchema[] | undefined)?.map(
        (toolSchema) => toolSchema.name,
      ) || null,
    outputCharacters: streamState.outputCharacters,
    timeToGenerationSec,
    generationSec,
    totalSec: (now - requestStart) / 1000,
    rateLimits: streamState.rateLimits as Record<string, unknown> | null,
  };
}

async function handleStreamingText(context: GenerationContext) {
  const {
    provider,
    resolvedModel,
    modelDefinition,
    messages,
    options,
    conversationId,
    conversationMeta,
    project,
    username,
    requestStart,
    emit,
    signal,
  } = context;
  markGenerating(conversationId, project, username, true, {
    ...getCollectionOpts(project),
    title:
      typeof conversationMeta?.title === "string"
        ? conversationMeta.title
        : undefined,
  });
  const useLiveStream = Boolean(
    (modelDefinition as Record<string, unknown> | null)?.liveAPI &&
      provider.generateTextStreamLive,
  );
  const stream = useLiveStream
    ? provider.generateTextStreamLive!(messages as ChatMessage[], resolvedModel, {
        ...options,
        signal,
      })
    : provider.generateTextStream(messages as ChatMessage[], resolvedModel, {
        ...options,
        signal,
      });
  const streamState = createStreamState();
  streamState.requestStart = requestStart;
  await consumeChatProviderStream(stream, streamState, context, "chat/stream");

  const MAX_FUNCTIONCALL_ITERATIONS = 10;
  let functionCallIteration = 0;
  const offeredToolNames = new Set(
    ((options.tools as Array<{ name: string }> | undefined) ?? []).map((tool) => tool.name),
  );
  const chatPolicies = (options.policies as PolicyRule[] | undefined) ?? [];
  while (
    options.functionCallingEnabled &&
    getPendingChatToolCalls(streamState).length > 0 &&
    functionCallIteration < MAX_FUNCTIONCALL_ITERATIONS &&
    !signal?.aborted
  ) {
    functionCallIteration++;
    const executed = await runChatFunctionCallingIteration(
      context,
      streamState,
      offeredToolNames,
      chatPolicies,
      functionCallIteration,
    );
    if (!executed) break;
  }

  applyChatTruncationWarningIfNeeded(streamState, emit);
  const now = performance.now();
  await finalizeTextGeneration(
    context,
    buildStreamFinalizationResult(streamState, options, requestStart, now),
  );
}

// ─── Dispatch: Non-streaming text generation (fallback) ─────

function emitNonStreamingResultEvents(
  genResult: Awaited<ReturnType<GenerationContext["provider"]["generateText"]>>,
  emit: EmitFunction,
): void {
  if (genResult.text) {
    emit({ type: SERVER_SENT_EVENT_TYPES.CHUNK, content: genResult.text });
  }
  if (genResult.thinking) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.THINKING,
      content: genResult.thinking,
    });
  }
  if (!genResult.toolCalls || genResult.toolCalls.length === 0) {
    return;
  }
  for (const toolCall of genResult.toolCalls) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
      id: toolCall.id || null,
      name: toolCall.name,
      args: toolCall.args || {},
      thoughtSignature: toolCall.thoughtSignature || undefined,
    });
  }
}

async function uploadAndEmitNonStreamingImages(
  genResult: Awaited<ReturnType<GenerationContext["provider"]["generateText"]>>,
  project: string | undefined,
  username: string | undefined,
  emit: EmitFunction,
): Promise<string[]> {
  const images: string[] = [];
  if (!genResult.images || genResult.images.length === 0) {
    return images;
  }
  for (const image of genResult.images) {
    let minioRef: string | null = null;
    const mimeType = image.mimeType || "image/png";
    if (image.data) {
      const dataUrl = `data:${mimeType};base64,${image.data}`;
      try {
        const { ref } = await FileService.uploadFile(
          dataUrl,
          FILE_CATEGORIES.GENERATIONS,
          project,
          username,
        );
        minioRef = ref;
      } catch (uploadError: unknown) {
        logger.error(
          `[chat/non-stream] MinIO upload failed: ${getErrorMessage(uploadError)}`,
        );
      }
      images.push(minioRef || dataUrl);
    }
    emit({
      type: SERVER_SENT_EVENT_TYPES.IMAGE,
      data: image.data,
      mimeType: image.mimeType,
      minioRef,
    });
  }
  return images;
}

function buildNonStreamingFinalizationResult(
  genResult: Awaited<ReturnType<GenerationContext["provider"]["generateText"]>>,
  images: string[],
  options: Record<string, unknown>,
  requestStart: number,
  generationStart: number,
  now: number,
) {
  return {
    text: genResult.text || "",
    thinking: genResult.thinking || "",
    images,
    toolCalls:
      genResult.toolCalls?.map((toolCall) => ({
        id: toolCall.id || null,
        name: toolCall.name,
        args: toolCall.args || {},
        thoughtSignature: toolCall.thoughtSignature || undefined,
        durationMs: toolCall.durationMs as number | undefined,
      })) || [],
    audioChunks: [],
    audioSampleRate: 24000,
    usage: genResult.usage || { inputTokens: 0, outputTokens: 0 },
    resolvedEnabledTools:
      (options.tools as ToolSchema[] | undefined)?.map(
        (toolSchema) => toolSchema.name,
      ) || null,
    outputCharacters: genResult.text ? genResult.text.length : 0,
    timeToGenerationSec: (generationStart - requestStart) / 1000,
    generationSec: (now - generationStart) / 1000,
    totalSec: (now - requestStart) / 1000,
    rateLimits: genResult.rateLimits || null,
  };
}

async function handleNonStreamingText(context: GenerationContext) {
  const {
    provider,
    resolvedModel,
    messages,
    options,
    conversationId,
    conversationMeta,
    project,
    username,
    requestStart,
    emit,
  } = context;
  markGenerating(conversationId, project, username, true, {
    ...getCollectionOpts(project),
    title:
      typeof conversationMeta?.title === "string"
        ? conversationMeta.title
        : undefined,
  });
  const subRequestId = context.agentConversationId
    ? `sub-${context.requestId || crypto.randomUUID()}`
    : null;
  if (subRequestId && context.agentConversationId) {
    ConversationGenerationTracker.register(context.agentConversationId, subRequestId, {
      provider: context.providerName,
      model: resolvedModel,
      source: "tool-sub-request",
    });
  }
  const generationStart = performance.now();
  const genResult = await provider.generateText(
    messages as ChatMessage[],
    resolvedModel,
    options,
  );
  const now = performance.now();
  if (subRequestId && context.agentConversationId) {
    const outTokens = genResult.usage?.outputTokens || 0;
    if (outTokens > 0) {
      ConversationGenerationTracker.update(subRequestId, {
        outputTokens: outTokens,
      });
    }
    ConversationGenerationTracker.complete(subRequestId);
  }
  emitNonStreamingResultEvents(genResult, emit);
  const images = await uploadAndEmitNonStreamingImages(genResult, project, username, emit);
  await finalizeTextGeneration(
    context,
    buildNonStreamingFinalizationResult(genResult, images, options, requestStart, generationStart, now),
  );
}
// ─── SSE streaming or JSON fallback ─────────────────────────
/**
 * POST /chat
 *
 * Response mode (see utils/StreamNegotiation.ts wantsSse):
 *   Default: SSE streaming (text/event-stream).
 *   JSON only on an explicit opt-out: `?stream=false`, body `"stream": false`,
 *   or `Accept: application/json` without text/event-stream.
 *   `?stream=true` always streams.
 *
 * Body (flat, OpenAI-style):
 *   { provider, model?, messages, tools?, temperature?, maxTokens?, ... }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const params = {
      ...req.body,
      project: req.project,
      username: req.username,
      clientIp: req.clientIp,
    };
    if (wantsSse(req)) {
      // persistOnDisconnect mirrors /agent: a dropped TCP connection (e.g.
      // mobile screen lock) must not abort generation — the handler keeps
      // running server-side and the final messages still land in the
      // conversation via the finalizer.
      await handleSseRequest(req, res, params, handleConversation, {
        persistOnDisconnect: true,
      });
    } else {
      await handleJsonRequest(req, res, next, params);
    }
  }),
);
export default router;
