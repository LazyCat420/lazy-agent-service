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

  const parseResult = ChatRequestSchema.safeParse(params);
  if (!parseResult.success) {
    // Custom error mappings to match the exact ones expected by existing consumers and test cases
    if (
      !params ||
      !("provider" in params) ||
      params.provider === undefined ||
      params.provider === null
    ) {
      throw new ProviderError(
        "server",
        "Missing required field: provider",
        400,
      );
    }
    if (!params || !("messages" in params) || !Array.isArray(params.messages)) {
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

  const validatedParams = parseResult.data;

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
    harness,
    topology,
    thoughtStructure,
    // Generation options — flat at top-level (OpenAI-style)
    tools,
    temperature,
    maxTokens,
    topP,
    topK,
    frequencyPenalty,
    presencePenalty,
    stopSequences,
    seed,
    minP,
    repeatPenalty,
    thinkingEnabled,
    reasoningEffort,
    thinkingLevel,
    thinkingBudget,
    webSearch,
    webFetch,
    codeExecution,
    urlContext,
    verbosity,
    reasoningSummary,
    functionCallingEnabled,
    agenticLoopEnabled,
    enabledTools,
    disabledTools,
    minContextLength,
    evalBatchSize,
    forceImageGeneration,
    responseFormat,
    serviceTier,
    textOnly,
    skipConversation,
    autoApprove,
    planFirst,
    maxIterations,
    maxSubAgentIterations,
    maxRecursionDepth,
    agentContext,
    // Multi-workspace: user-selected workspace root path (absolute fs path).
    workspaceRoot,
    // Workspace toggle: when false, workspace tools are excluded from the agent session.
    workspaceEnabled,
    // CriticGate: multi-model review of dangerous tool calls.
    enableCriticGate,
    criticModel,
    parallelToolCalls,
    candidateCount,
    branchCount,
    responseMimeType,
    store,
    mediaResolution,
    topLogprobs,
    responseLogprobs,
    logprobs,
    locale,
    ...extraParams
  } = validatedParams;

  let providerName = _providerName;
  // Build the internal options object that providers expect
  const options: Record<string, unknown> = {
    ...(tools && { tools }),
    ...(temperature != null && { temperature }),
    ...(maxTokens != null && { maxTokens }),
    ...(topP != null && { topP }),
    ...(topK != null && { topK }),
    ...(frequencyPenalty != null && { frequencyPenalty }),
    ...(presencePenalty != null && { presencePenalty }),
    ...(stopSequences && { stopSequences }),
    ...(seed != null && seed !== "" && { seed }),
    ...(minP != null && { minP }),
    ...(repeatPenalty != null && { repeatPenalty }),
    ...(thinkingEnabled != null && { thinkingEnabled }),
    ...(reasoningEffort && { reasoningEffort }),
    ...(thinkingLevel && { thinkingLevel }),
    ...(thinkingBudget != null && { thinkingBudget }),
    ...(webSearch != null && { webSearch }),
    ...(webFetch != null && { webFetch }),
    ...(codeExecution != null && { codeExecution }),
    ...(urlContext != null && { urlContext }),
    ...(verbosity && { verbosity }),
    ...(reasoningSummary && { reasoningSummary }),
    ...(functionCallingEnabled != null && { functionCallingEnabled }),
    ...(agenticLoopEnabled != null && { agenticLoopEnabled }),
    ...(enabledTools && { enabledTools }),
    ...(disabledTools && { disabledTools }),
    ...(minContextLength && { minContextLength }),
    ...(evalBatchSize && { evalBatchSize }),
    ...(forceImageGeneration != null && { forceImageGeneration }),
    ...(responseFormat != null && { responseFormat }),
    ...(serviceTier != null && { serviceTier }),
    ...(textOnly != null && { textOnly }),
    ...(autoApprove != null && { autoApprove }),
    ...(planFirst != null && { planFirst }),
    ...(maxIterations != null && { maxIterations }),
    ...(maxSubAgentIterations != null && { maxSubAgentIterations }),
    ...(maxRecursionDepth != null && { maxRecursionDepth }),
    ...(agentContext != null && { agentContext }),
    ...(enableCriticGate != null && { enableCriticGate }),
    ...(criticModel != null && { criticModel }),
    ...(workspaceEnabled != null && { workspaceEnabled }),
    ...(harness != null && { harness }),
    ...(topology != null && { topology }),
    ...(thoughtStructure != null && { thoughtStructure }),
    ...(parallelToolCalls != null && { parallelToolCalls }),
    ...(candidateCount != null && { candidateCount }),
    ...(branchCount != null && { branchCount }),
    ...(responseMimeType != null &&
      responseMimeType !== "" && { responseMimeType }),
    ...(store != null && { store }),
    ...(mediaResolution != null &&
      mediaResolution !== "" && { mediaResolution }),
    ...(topLogprobs != null && topLogprobs > 0 && { topLogprobs }),
    ...(responseLogprobs != null && { responseLogprobs }),
    ...(logprobs != null && logprobs > 0 && { logprobs }),
    ...(locale != null && locale !== "" && { locale }),
    ...((extraParams as Record<string, unknown>).systemPrompt
      ? { systemPrompt: (extraParams as Record<string, unknown>).systemPrompt }
      : {}),
  };
  // When thinking is explicitly disabled, strip all thinking sub-params
  // so providers don't inadvertently enable thinking by detecting them.
  if (thinkingEnabled === false) {
    delete options.reasoningEffort;
    delete options.thinkingLevel;
    delete options.thinkingBudget;
  } else {
    // Synchronize both fields so OpenAI/Anthropic (reasoningEffort) and Gemini (thinkingLevel) both get the correct option
    if (options.thinkingLevel && !options.reasoningEffort) {
      options.reasoningEffort = options.thinkingLevel;
    }
    if (options.reasoningEffort && !options.thinkingLevel) {
      options.thinkingLevel = options.reasoningEffort;
    }
  }

  // Apply agent-optimized defaults for parameters not explicitly set by client.
  // Agent sessions benefit from deterministic, high-output defaults
  // (e.g., temperature=0, maxTokens=16384, reasoningEffort="high").
  let personaThinkingDefault: boolean | undefined;
  if (agent) {
    const { default: AgentPersonaRegistry } = await import("../services/AgentPersonaRegistry.ts");
    if (!AgentPersonaRegistry.has(agent)) {
      throw new ProviderError("server", `Unknown agent: "${agent}"`, 400);
    }
    // A persona can declare its own thinking default (router personas set
    // false — the <think> stream is most of their latency on Qwen-class
    // models). It fills the same "client sent nothing" gap as the blanket
    // agent default below, so it must be applied first; an explicit
    // thinkingEnabled on the request still wins over both.
    personaThinkingDefault =
      AgentPersonaRegistry.get(agent)?.thinkingDefault;
    if (
      personaThinkingDefault !== undefined &&
      (thinkingEnabled === undefined || thinkingEnabled === null)
    ) {
      options.thinkingEnabled = personaThinkingDefault;
    }
    const agentDefaultValues = getAgentDefaults();
    for (const [parameterKey, defaultValue] of Object.entries(
      agentDefaultValues,
    )) {
      if (
        options[parameterKey] === undefined ||
        options[parameterKey] === null
      ) {
        options[parameterKey] = defaultValue;
      }
    }
  }

  // Local models emit thinking tokens (<think> tags) by default. Default
  // thinkingEnabled ON only when the client didn't send a value (undefined).
  // When the client explicitly sends false (thinking toggle off), respect it
  // — models can use tools without thinking. The persona default counts as
  // "a value" here, otherwise this would re-force thinking on for local
  // providers and silently undo the persona's choice.
  LocalProviderGateway.applyLocalDefaults(providerName, options, {
    thinkingEnabled: thinkingEnabled ?? personaThinkingDefault ?? undefined,
  });

  // ── Strip soft-deleted messages ──────────────────────────────
  const activeMessages = messages.filter((message) => !message.deleted);
  // ── Resolve image refs ─────────────────────────────────────
  const providerMessages = await resolveMessageMediaReferences(
    activeMessages as ConversationMessage[],
    project,
    username,
  );
  // ── Multi-instance load balancing ─────────────────────────
  // When the caller sends a base provider type (e.g. "lm-studio") and
  // multiple instances are registered, verify the model is available on
  // each instance (with quant-level fallback) and pick the least-busy
  // usable instance. Same model resolution logic as OrchestratorService.
  //
  // Instance pinning: when the caller sends a specific instance ID
  // (e.g. "lm-studio-2"), resolve its base type for model resolution
  // but skip load balancing — the request is pinned to that instance.
  let resolvedModel =
    requestedModel ||
    getDefaultModels(TYPES.TEXT, TYPES.TEXT)[providerName as string];

  // Dynamic resolution for vLLM: if no model was resolved, fetch whatever is currently loaded
  if (!resolvedModel && providerName.startsWith("vllm")) {
    const siblings = getInstancesByType(providerName);
    for (const sibling of siblings) {
      const p = getProvider(sibling.id);
      if (p && p.listModels) {
        try {
          const res = await p.listModels();
          // Type assertion to any since the exact return type might vary slightly but usually has models or data
          const models = (res as any)?.models || (res as any)?.data || [];
          if (models.length > 0) {
            resolvedModel = models[0].id || models[0].key || models[0].name;
            providerName = sibling.id;
            break;
          }
        } catch (e) {
          logger.warn(`[ChatRoutes] Failed to dynamically fetch models for ${sibling.id}:`, e);
        }
      }
    }
  }
  if (localModelQueue.isLocal(providerName)) {
    const pinnedInstanceType = getInstanceType(providerName);
    const isInstancePinned = pinnedInstanceType !== null && pinnedInstanceType !== providerName;

    if (isInstancePinned) {
      // ── Instance pinning (bypass load balancing) ──────────────
      // The caller sent a specific instance ID (e.g. "lm-studio-2").
      // Resolve the base type so we can run model resolution against
      // this single instance, then skip load balancing entirely.
      const pinnedSiblings = getInstancesByType(pinnedInstanceType).filter(
        (instance) => instance.id === providerName,
      );
      if (pinnedSiblings.length > 0) {
        const { modelOverrides } = await resolveModelForInstances(
          resolvedModel,
          pinnedSiblings,
        );
        const override = modelOverrides.get(providerName);
        if (override) {
          resolvedModel = override;
        }
        logger.info(
          `[chat] 📌 Instance pinned: ${pinnedInstanceType} → ${providerName}` +
            (override ? ` (model="${resolvedModel}")` : ""),
        );
      }
    } else {
      // ── Standard load balancing path ──────────────────────────
      let siblings = getInstancesByType(providerName);
      // ── Model resolution (always) ──────────────────────────────
      // Resolve model availability across instances with quant-level
      // fallback. Also handles @quant syntax (e.g. "qwen3-32b@q4_k_m")
      // by mapping it to the actual LM Studio model key.
      const { usable, modelOverrides } = await resolveModelForInstances(
        resolvedModel,
        siblings,
      );
      if (usable.length > 0) {
        siblings = usable;
        // For single instance, apply model override directly
        if (siblings.length === 1) {
          const override = modelOverrides.get(siblings[0].id);
          if (override) {
            resolvedModel = override;
            logger.info(
              `[chat] Model resolved: "${requestedModel}" → "${resolvedModel}" (single instance)`,
            );
          }
        }
      } else {
        logger.warn(
          `[chat] Model "${resolvedModel}" not available on any ${providerName} instance — falling back to first`,
        );
      }
      // ── Multi-instance load balancing (least-connections) ────────
      if (siblings.length > 1) {
        // Least-connections: pick the instance with the lowest load
        // normalized by capacity (total in-flight / concurrency). This ensures
        // the faster device drains its queue and picks up new work
        // sooner, rather than piling up behind a slower device.
        let bestId = providerName;
        let lowestLoad = Infinity;
        for (const inst of siblings) {
          const queueState = localModelQueue._getQueue(inst.id);
          const load = queueState.totalInflight / inst.concurrency;
          if (
            load < lowestLoad ||
            (load === lowestLoad && inst.concurrency > (getInstance(bestId)?.concurrency || 0))
          ) {
            lowestLoad = load;
            bestId = inst.id;
          }
        }
        if (bestId !== providerName) {
          // Apply model override if this instance uses a different quant
          const modelOverride = modelOverrides.get(bestId);
          if (modelOverride) {
            resolvedModel = modelOverride;
          }
          logger.info(
            `[chat] ⚖️ Load balance: ${providerName} → ${bestId} ` +
              `(model="${resolvedModel}", ${siblings.map((sibling) => `${sibling.id}:active=${localModelQueue._getQueue(sibling.id).activeCount},queued=${localModelQueue._getQueue(sibling.id).pending}`).join(", ")})`,
          );
          providerName = bestId;
        }
      }
    }
  }
  const provider = getProvider(providerName);
  // ── Resolve model ─────────────────────────────────────────
  // resolvedModel is set earlier (before load balancing) and may have
  // been updated to a quant variant by the model availability check.
  const modelDefinition = getModelByName(resolvedModel);
  const isImageAPIModel =
    (modelDefinition as Record<string, unknown> | null)?.imageAPI &&
    provider.generateImage;
  // ── Local GPU mutex ──────────────────────────────────────
  let localRelease: (() => void) | null = null;
  if (localModelQueue.isLocal(providerName)) {
    localRelease = await localModelQueue.acquire(providerName);
    const queueState = localModelQueue._getQueue(providerName);
    logger.info(
      `[chat] 🔒 Acquired local GPU slot for ${resolvedModel} (${providerName}) ` +
        `(${queueState.activeCount}/${queueState.maxConcurrency} active` +
        (queueState.pending > 0 ? `, ${queueState.pending} queued)` : ")"),
    );
  }
  // Derive userMessage from the last user message
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
    });
    return;
  }
  const {
    providerName,
    resolvedModel,
    requestedModel,
    options,
    incomingConversationId,
    incomingConversationMeta,
    incomingTraceId,
    skipConversation,
    project,
    username,
    clientIp,
    requestStart,
    requestId,
    modelDefinition,
    localRelease,
  } = context;
  // ── Conversation identity ──────────────────────────────────
  let conversationId = skipConversation ? null : incomingConversationId;
  let conversationMeta = skipConversation ? null : incomingConversationMeta;
  if (!skipConversation && !conversationId) {
    conversationId = crypto.randomUUID();
    const firstUserMessage = (context.rawMessages as ConversationMessage[])
      ?.filter((conversationMessage) => conversationMessage.role === "user")
      .pop();
    const titleSnippet =
      (firstUserMessage?.content || "").slice(0, 100).trim() ||
      DEFAULT_CONVERSATION_TITLE;
    conversationMeta = conversationMeta || { title: titleSnippet };
  }
  const traceId = incomingTraceId || null;
  if (traceId && conversationMeta) {
    (conversationMeta as Record<string, unknown>).traceId = traceId;
  } else if (traceId) {
    conversationMeta = { traceId };
  }
  // Merge conversation identity into ctx for sub-handlers
  const fullContext = {
    ...context,
    conversationId: conversationId || null,
    agentConversationId: null as string | null,
    conversationMeta,
    traceId,
  };
  try {
    try {
      if (context.isImageAPIModel) {
        await handleImageAPIModel(fullContext);
        return;
      }
      if (
        !context.provider.generateTextStream &&
        !context.provider.generateText
      ) {
        throw new ProviderError(
          providerName,
          `Provider "${providerName}" does not support text generation`,
          400,
        );
      }
      // Resolve and inject tools for /chat function calling
      if (options.functionCallingEnabled && !options.agenticLoopEnabled) {
        const useNativeMcp = LocalProviderGateway.isNativeMCP(providerName);
        const { default: SettingsService } =
          await import("../services/SettingsService.ts");
        const settings = await SettingsService.getSection("agents");
        const defaultTopology =
          (options.topology as string) ||
          settings?.topology ||
          DEFAULT_TOPOLOGY;
        const builtInTools =
          ToolOrchestratorService.getToolSchemas(defaultTopology);
        let tools = builtInTools;
        if (options.enabledTools && Array.isArray(options.enabledTools)) {
          const enabledSet = new Set(options.enabledTools as string[]);
          tools = tools.filter((toolItem) => enabledSet.has(toolItem.name));
        } else if (
          options.disabledTools &&
          Array.isArray(options.disabledTools)
        ) {
          const disabledSet = new Set(options.disabledTools as string[]);
          tools = tools.filter((toolItem) => !disabledSet.has(toolItem.name));
        }
        options.tools = tools;

        // Inject tool descriptions into the system prompt
        injectToolsIntoSystemPrompt(
          fullContext.messages as Array<{
            role: string;
            content?: string;
            [key: string]: unknown;
          }>,
          tools as ToolSchemaWithDomain[],
        );

        if (
          useNativeMcp &&
          (modelDefinition as Record<string, unknown> | null)?.contextLength
        ) {
          options.contextLength = (
            modelDefinition as Record<string, unknown>
          ).contextLength;
        }

        logger.info(
          `[chat] FC tools resolved and injected into system prompt: ${tools.length} tools enabled for ${providerName} ${resolvedModel}`,
        );
      }

      const useStreaming =
        typeof context.provider.generateTextStream === "function" &&
        (modelDefinition as Record<string, unknown> | null)?.streaming !==
          false;
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
    markGenerating(
      conversationId,
      project,
      username,
      false,
      getCollectionOpts(project),
    );
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
      messages: context.rawMessages || [],
      options,
    });
    emit({
      type: SERVER_SENT_EVENT_TYPES.ERROR,
      message: getErrorMessage(error),
    });
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

      // Inject persona-level policies into options (if the agent has them)
      if (agent && !options.policies) {
        const { default: AgentPersonaRegistry } =
          await import("../services/AgentPersonaRegistry.js");
        const persona = AgentPersonaRegistry.get(agent);
        if (persona?.policies && persona.policies.length > 0) {
          options.policies = persona.policies;
        }
      }

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
  let minioRef = null;
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

async function handleStreamingText(context: GenerationContext) {
  const {
    provider,
    providerName,
    resolvedModel,
    modelDefinition,
    messages,
    options,
    conversationId,
    conversationMeta,
    traceId,
    project,
    username,
    clientIp,
    agent,
    requestId,
    requestStart,
    emit,
    signal,
  } = context;
  // Mark conversation as generating
  markGenerating(conversationId, project, username, true, {
    ...getCollectionOpts(project),
    title:
      typeof conversationMeta?.title === "string"
        ? conversationMeta.title
        : undefined,
  });
  const stream =
    (modelDefinition as Record<string, unknown> | null)?.liveAPI &&
    provider.generateTextStreamLive
      ? provider.generateTextStreamLive(messages as ChatMessage[], resolvedModel, {
          ...options,
          signal,
        })
      : provider.generateTextStream(messages as ChatMessage[], resolvedModel, {
          ...options,
          signal,
        });
  const streamState = createStreamState();
  streamState.requestStart = requestStart;
  for await (const chunk of stream) {
    // Client disconnected — abort the upstream provider stream
    if (signal?.aborted) {
      if (typeof stream.return === "function") stream.return();
      logger.info(
        `[chat] Client disconnected, aborting stream for ${providerName} ${resolvedModel}`,
      );
      break;
    }
    await dispatchChunk(
      chunk,
      streamState,
      { emit, project, username },
      { logPrefix: "chat/stream" },
    );
  }
  // ── FC tool execution loop ─────────────────────────────────
  // When functionCallingEnabled is set on /chat (not the agentic loop),
  // execute returned tool calls via ToolOrchestratorService and re-call
  // the provider with tool results. Lightweight loop — no approval
  // engine, no context manager, just direct execution.
  const MAX_FUNCTIONCALL_ITERATIONS = 10;
  let functionCallIteration = 0;
  while (
    options.functionCallingEnabled &&
    streamState.toolCalls.length > 0 &&
    streamState.toolCalls.some(
      (toolCall) =>
        !toolCall.result &&
        toolCall.status !== "done" &&
        toolCall.status !== "error",
    ) &&
    functionCallIteration < MAX_FUNCTIONCALL_ITERATIONS &&
    !signal?.aborted
  ) {
    functionCallIteration++;
    const pendingCalls = streamState.toolCalls.filter(
      (toolCall) =>
        !toolCall.result &&
        toolCall.status !== "done" &&
        toolCall.status !== "error",
    );
    if (pendingCalls.length === 0) break;
    logger.info(
      `[chat/FC] Iteration ${functionCallIteration}: executing ${pendingCalls.length} tool call(s)`,
    );
    // Execute all pending tool calls
    for (const toolCall of pendingCalls) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.TOOL_CALL,
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        status: "calling",
      });
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
        toolCall.status =
          result &&
          typeof result === "object" &&
          "error" in result &&
          result.error
            ? "error"
            : "done";
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
    // Build tool result messages for the provider
    const assistantToolMessage = {
      role: "assistant",
      content: streamState.text || "",
      toolCalls: streamState.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
        ...(toolCall.responsesItemId
          ? { responsesItemId: toolCall.responsesItemId }
          : {}),
        ...(toolCall.thoughtSignature
          ? { thoughtSignature: toolCall.thoughtSignature }
          : {}),
        ...(toolCall.reasoningItem
          ? { reasoningItem: toolCall.reasoningItem }
          : {}),
      })),
      ...(streamState.thinking ? { thinking: streamState.thinking } : {}),
      ...(streamState.thinkingSignature
        ? { thinkingSignature: streamState.thinkingSignature }
        : {}),
    };
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
    // Re-call provider with tool results appended
    const updatedMessages = [
      ...messages,
      assistantToolMessage,
      ...toolResultMsgs,
    ];
    // Reset accumulators for the follow-up stream
    streamState.text = "";
    streamState.thinking = "";
    streamState.thinkingSignature = "";
    streamState.toolCalls.length = 0;
    const followUpStream = provider.generateTextStream(
      updatedMessages as ChatMessage[],
      resolvedModel,
      {
        ...options,
        signal,
      },
    );
    // Use dispatchChunk with a custom usage merger for follow-up iteration
    const usageMerger = (followUpUsage: TokenUsage) => {
      if (streamState.usage) {
        mergeUsage(streamState.usage, followUpUsage);
      } else {
        streamState.usage = followUpUsage;
      }
    };
    for await (const chunk of followUpStream) {
      if (signal?.aborted) {
        if (typeof followUpStream.return === "function")
          followUpStream.return();
        break;
      }
      await dispatchChunk(
        chunk,
        streamState,
        { emit, project, username },
        { onUsage: usageMerger, logPrefix: "chat/FC" },
      );
    }
    // Emit intermediate usage update so the frontend has authoritative
    // per-iteration token counts instead of relying on chunk heuristics
    if (streamState.usage) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
        usage: {
          ...(streamState.usage as Record<string, unknown>),
          requests: functionCallIteration + 1,
        },
      });
    }
    // Update messages ref for potential next iteration
    (messages as Record<string, unknown>[]).push(
      assistantToolMessage,
      ...toolResultMsgs,
    );
  }
  // Surface max_tokens truncation if the model produced no useful output
  const isChatTruncated =
    (streamState.stopReason === "length" ||
      streamState.stopReason === "max_tokens") &&
    !streamState.text.trim();
  if (isChatTruncated) {
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
  // Build normalized result for shared finalization
  const now = performance.now();
  await finalizeTextGeneration(context, {
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
    timeToGenerationSec: streamState.firstTokenTime
      ? (streamState.firstTokenTime - requestStart) / 1000
      : null,
    generationSec:
      streamState.firstTokenTime && streamState.generationEnd
        ? (streamState.generationEnd - streamState.firstTokenTime) / 1000
        : null,
    totalSec: (now - requestStart) / 1000,
    rateLimits: streamState.rateLimits as Record<string, unknown> | null,
  });
}
// ─── Dispatch: Non-streaming text generation (fallback) ─────
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
  // Mark conversation as generating
  markGenerating(conversationId, project, username, true, {
    ...getCollectionOpts(project),
    title:
      typeof conversationMeta?.title === "string"
        ? conversationMeta.title
        : undefined,
  });
  // Track this sub-request in ConversationGenerationTracker if it belongs
  // to an active agent conversation (e.g., tools-api calling /chat?stream=false
  // for generate_image prompt-softening or describe_image).
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
  // Complete sub-request tracking with actual token data
  if (subRequestId && context.agentConversationId) {
    const outTokens = genResult.usage?.outputTokens || 0;
    if (outTokens > 0) {
      ConversationGenerationTracker.update(subRequestId, {
        outputTokens: outTokens,
      });
    }
    ConversationGenerationTracker.complete(subRequestId);
  }
  // Emit chunk/thinking/toolCall events before finalization
  if (genResult.text) {
    emit({ type: SERVER_SENT_EVENT_TYPES.CHUNK, content: genResult.text });
  }
  if (genResult.thinking) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.THINKING,
      content: genResult.thinking,
    });
  }
  if (genResult.toolCalls && genResult.toolCalls.length > 0) {
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
  // Handle images from the generation result (e.g. Gemini image models)
  const images: string[] = [];
  if (genResult.images && genResult.images.length > 0) {
    for (const image of genResult.images) {
      let minioRef = null;
      if (image.data) {
        try {
          const mimeType = image.mimeType || "image/png";
          const dataUrl = `data:${mimeType};base64,${image.data}`;
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
        images.push(
          minioRef ||
            `data:${image.mimeType || "image/png"};base64,${image.data}`,
        );
      }
      emit({
        type: SERVER_SENT_EVENT_TYPES.IMAGE,
        data: image.data,
        mimeType: image.mimeType,
        minioRef,
      });
    }
  }
  // Build normalized result for shared finalization
  await finalizeTextGeneration(context, {
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
  });
}
// ─── SSE streaming or JSON fallback ─────────────────────────
/**
 * POST /chat
 *
 * Default:       SSE streaming (text/event-stream)
 * ?stream=false: Plain JSON response (for server-to-server callers)
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
    const acceptsSse = req.headers.accept?.includes("text/event-stream");
    const streamQuery = req.query.stream;
    const isSse = streamQuery === "true" || (acceptsSse && streamQuery !== "false" && req.body.stream !== false);

    if (isSse) {
      await handleSseRequest(req, res, params);
    } else {
      await handleJsonRequest(req, res, next, params);
    }
  }),
);
export default router;
