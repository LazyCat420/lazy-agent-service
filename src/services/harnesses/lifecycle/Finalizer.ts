import {
  formatCostTag,
  roundMilliseconds,
} from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  calculateTextCost,
  getTotalInputTokens,
} from "../../../utils/CostCalculator.ts";
import { calculateTokensPerSec } from "../../../utils/math.ts";
import { TYPES, getPricing } from "../../../config.ts";
import RequestLogger from "../../RequestLogger.ts";
import FileService from "../../FileService.ts";
import AgentPersonaRegistry from "../../AgentPersonaRegistry.ts";
import ToolOrchestratorService from "../../ToolOrchestratorService.ts";
import { resolveToolEntriesToSet } from "../../../utils/resolveToolEntriesToSet.ts";
import { appendAndFinalize } from "../../../utils/ConversationUtilities.ts";
import {
  COLLECTIONS,
  FILE_CATEGORIES,
  PROMPT_DELIMITERS,
} from "../../../constants.ts";
import logger from "../../../utils/logger.ts";
import {
  TokenUsage,
  MessagePayload,
  ToolCallPayload,
  LlmOptions,
} from "../../RequestLogger.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";
import crypto from "node:crypto";
import { DeterministicVerifiers } from "../../../platform/verify/DeterministicVerifiers.ts";
import { RunEvidenceStore } from "../../../platform/verify/RunEvidenceStore.ts";
import { Span } from "../../../platform/trace/Span.ts";
import { TraceExporter } from "../../../platform/trace/TraceExporter.ts";
import { TraceContext } from "../../../platform/trace/TraceContext.ts";

export interface FinalizerContext {
  providerName: string;
  resolvedModel: string;
  modelDefinition?: Record<string, unknown> | null;
  messages: MessagePayload[];
  originalMessages?: MessagePayload[];
  options: LlmOptions;
  conversationId: string | null;
  agentConversationId?: string | null;
  parentAgentConversationId?: string | null;
  parentConversationId?: string | null;
  userMessage?: MessagePayload | null;
  conversationMeta?: Record<string, unknown> | null;
  traceId?: string | null;
  project?: string | null;
  username?: string | null;
  clientIp?: string | null;
  agent?: string | null;
  workspaceRoot?: string | null;
  requestId?: string;
  emit?: (event: { type: string; [key: string]: unknown }) => void;
  signal?: AbortSignal;
}

export interface FinalizerPayload {
  text: string | null;
  thinking: string | null;
  thinkingSignature?: string | null;
  images?: string[];
  toolCalls?: ToolCallPayload[];
  audioChunks?: string[];
  audioSampleRate?: number;
  usage?: TokenUsage | null;
  outputCharacters?: number;
  timeToGenerationSec?: number | null;
  generationSec?: number | null;
  totalSec?: number | null;
  rateLimits?: Record<string, unknown> | null;
  contentSegments?: unknown[];
  textFragments?: unknown[];
  thinkingFragments?: unknown[];
  resolvedEnabledTools?: string[] | null;
}

/**
 * Resolve the MongoDB collection for conversation persistence.
 * Agent requests always go to agent_conversations; everything else to model_conversations.
 */
function getCollectionOpts(
  project: string | null | undefined,
  agent?: string | null,
) {
  if (agent || AgentPersonaRegistry.isAgentProject(project || "")) {
    return { collection: COLLECTIONS.AGENT_CONVERSATIONS };
  }
  return undefined;
}

/**
 * Swap content and rawContent if present to ensure the database and caller get clean text.
 * Fallback to regex parsing for legacy/unmigrated messages to populate rawContent and clean content.
 */
export function swapMessageContent(message: MessagePayload) {
  if (message.role === "user" && typeof message.content === "string") {
    if (
      message.rawContent?.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT) ||
      message.rawContent?.startsWith(
        PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX,
      )
    ) {
      return;
    }
    if (message.rawContent) {
      const dirty = message.content;
      message.content = message.rawContent;
      message.rawContent = dirty;
    } else if (message.content.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT)) {
      const dirty = message.content;
      let clean = message.content;
      const splitDelimiter = "\n\n" + PROMPT_DELIMITERS.USER_MESSAGE + "\n";
      const splitIndex = message.content.indexOf(splitDelimiter);
      if (splitIndex !== -1) {
        clean = message.content.substring(splitIndex + splitDelimiter.length);
      } else {
        const altDelimiter = PROMPT_DELIMITERS.USER_MESSAGE + "\n";
        const altSplit = message.content.indexOf(altDelimiter);
        if (altSplit !== -1) {
          clean = message.content.substring(altSplit + altDelimiter.length);
        }
      }
      message.content = clean;
      message.rawContent = dirty;
    } else if (
      message.content.startsWith(
        PROMPT_DELIMITERS.SYSTEM_CONTEXT_LOCAL_TIME_PREFIX,
      )
    ) {
      const dirty = message.content;
      let clean = message.content;
      const index = message.content.indexOf("]\n\n");
      if (index !== -1) {
        clean = message.content.slice(index + 3);
      }
      message.content = clean;
      message.rawContent = dirty;
    }
  }
}

/**
 * Finalizer — shared generation finalization logic extracted from ChatRoutes.
 *
 * Handles:
 *   - Cost calculation (text, image, mixed)
 *   - Console logging with telemetry
 *   - WAV audio assembly from PCM chunks
 *   - Request logging (non-agentic paths)
 *   - Done event emission
 *   - Conversation/session persistence via appendAndFinalize
 *
 * Used by all harness implementations and the /chat streaming path.
 */
export async function finalizeTextGeneration(
  context: FinalizerContext,
  {
    text,
    thinking,
    thinkingSignature,
    images = [],
    toolCalls = [],
    audioChunks = [],
    audioSampleRate = 16000,
    usage,
    outputCharacters = 0,
    timeToGenerationSec,
    generationSec,
    totalSec,
    rateLimits,
    // Display segment metadata (from AgenticLoopService)
    contentSegments,
    textFragments,
    thinkingFragments,
    resolvedEnabledTools,
  }: FinalizerPayload,
  overrideMessagesToAppend: MessagePayload[] | null = null,
) {
  const {
    providerName,
    resolvedModel,
    modelDefinition,
    messages,
    originalMessages,
    options,
    conversationId,
    agentConversationId,
    parentAgentConversationId,
    parentConversationId,
    userMessage,
    conversationMeta,
    traceId,
    project,
    username,
    clientIp,
    agent,
    workspaceRoot,
    requestId,
    emit,
    signal,
  } = context;

  // Swap content and rawContent if present to ensure the database and caller get clean text
  if (messages) {
    for (const message of messages) {
      swapMessageContent(message);
    }
  }
  if (overrideMessagesToAppend) {
    for (const message of overrideMessagesToAppend) {
      swapMessageContent(message);
    }
  }
  if (userMessage) {
    swapMessageContent(userMessage);
  }
  // ── Cost calculation ──────────────────────────────────────────
  let estimatedCost: number | null = null;
  let tokensPerSec: number | null = null;
  if (usage) {
    const imageCount = images.length;
    if (imageCount > 0) {
      const imgPricing =
        getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel] ||
        (modelDefinition?.pricing as Record<string, number>);
      if (imgPricing?.imageOutputPerMillion) {
        // Derive image tokens dynamically from the API-reported total.
        // The API's outputTokens already includes both text and image tokens,
        // so we estimate text tokens from the generated text length (~4 chars/token)
        // and attribute the remainder to images. This adapts to any resolution
        // (512px≈747tok, 1024px≈1120tok, 2048px≈1680tok, 4096px≈2520tok).
        const estimatedTextOutputTokens = Math.ceil((text?.length || 0) / 4);
        const imageTokens = Math.max(
          0,
          (usage.outputTokens || 0) - estimatedTextOutputTokens,
        );
        const textOutputTokens = Math.max(
          0,
          (usage.outputTokens || 0) - imageTokens,
        );
        const inputCost =
          ((usage.inputTokens || 0) / 1_000_000) *
          (imgPricing.inputPerMillion || 0);
        const textOutCost =
          (textOutputTokens / 1_000_000) * (imgPricing.outputPerMillion || 0);
        const imageOutCost =
          (imageTokens / 1_000_000) * imgPricing.imageOutputPerMillion;
        estimatedCost = parseFloat(
          (inputCost + textOutCost + imageOutCost).toFixed(8),
        );
      } else {
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        estimatedCost = calculateTextCost(usage, pricing);
      }
    } else {
      const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
      estimatedCost = calculateTextCost(usage, pricing);
    }
    tokensPerSec = calculateTokensPerSec(
      usage.outputTokens || 0,
      generationSec,
      {
        providerReported: usage.tokensPerSec as number | undefined,
        fallbackSec: totalSec,
      },
    );
  }
  // ── Console logging ───────────────────────────────────────────
  const inputTokens = usage ? getTotalInputTokens(usage) : 0;
  const outputTokens = usage?.outputTokens || 0;
  const tokensPerSecondString =
    tokensPerSec !== null ? tokensPerSec.toFixed(1) : "N/A";
  const cacheInfo =
    usage?.cacheReadInputTokens || usage?.cacheCreationInputTokens
      ? `, cache_read: ${usage.cacheReadInputTokens || 0}, cache_write: ${usage.cacheCreationInputTokens || 0}`
      : "";
  logger.request(
    project || "",
    username as string,
    clientIp || null,
    `[chat] ${providerName} ${resolvedModel} — ` +
      `in: ${inputTokens} tokens, out: ${outputTokens} tokens${cacheInfo}, ` +
      `speed: ${tokensPerSecondString} tok/s, ` +
      `ttg: ${timeToGenerationSec != null ? timeToGenerationSec.toFixed(2) + "s" : "N/A"}, ` +
      `generation: ${generationSec != null ? generationSec.toFixed(2) + "s" : "N/A"}, ` +
      `total: ${totalSec != null ? totalSec.toFixed(2) : "0.00"}s` +
      formatCostTag(estimatedCost),
  );
  // ── Build WAV from accumulated PCM audio chunks ───────────────
  let audioRef: string | null = null;
  if (audioChunks.length > 0) {
    try {
      const pcmBuffers = audioChunks.map((b64) => Buffer.from(b64, "base64"));
      const pcmData = Buffer.concat(pcmBuffers);
      const numberOfChannels = 1;
      const bitsPerSample = 16;
      const byteRate = audioSampleRate * numberOfChannels * (bitsPerSample / 8);
      const blockAlign = numberOfChannels * (bitsPerSample / 8);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write("RIFF", 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write("WAVE", 8);
      wavHeader.write("fmt ", 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(numberOfChannels, 22);
      wavHeader.writeUInt32LE(audioSampleRate, 24);
      wavHeader.writeUInt32LE(byteRate, 28);
      wavHeader.writeUInt16LE(blockAlign, 32);
      wavHeader.writeUInt16LE(bitsPerSample, 34);
      wavHeader.write("data", 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);
      const wavBuffer = Buffer.concat([wavHeader, pcmData]);
      const dataUrl = `data:audio/wav;base64,${wavBuffer.toString("base64")}`;
      const { ref } = await FileService.uploadFile(
        dataUrl,
        FILE_CATEGORIES.GENERATIONS,
        project as string,
        username || "system",
      );
      audioRef = ref;
    } catch (error: unknown) {
      logger.error(
        `[chat] Failed to build/upload Live API audio WAV: ${getErrorMessage(error)}`,
      );
    }
  }
  // ── Request logging with sanitized payloads ────────────────────
  // Placed after audio build so audioRef is available for modality detection.
  // Agentic requests are logged granularly per-iteration by AgenticLoopService,
  // so we only log here for non-agentic paths (chat, live).
  if (!options.agenticLoopEnabled) {
    RequestLogger.logChatGeneration({
      requestId,
      endpoint: modelDefinition?.liveAPI ? "/live" : "/chat",
      operation: modelDefinition?.liveAPI ? "live" : "chat",
      project,
      username,
      clientIp,
      agent,
      provider: providerName,
      model: resolvedModel,
      conversationId,
      agentConversationId: agentConversationId || null,
      parentAgentConversationId: parentAgentConversationId || null,
      traceId: traceId || null,
      success: true,
      usage: usage || undefined,
      estimatedCost,
      tokensPerSec,
      timeToGenerationSec,
      generationSec,
      totalSec,
      options,
      messages: originalMessages || messages,
      text,
      thinking,
      images,
      toolCalls,
      outputCharacters,
      audioRef,
      rateLimits,
    });
  }
  // ── Conversation persistence ──────────────────────────────────
  // IMPORTANT: Persist BEFORE emitting `done` so the client's post-stream
  // DB fetch sees the complete conversation. Previously, `done` fired first
  // and `appendAndFinalize` was fire-and-forget, causing a race condition
  // where the client fetched stale data from MongoDB.
  //
  // Sub-agents share the parent's conversationId for telemetry correlation but
  // must NOT persist their messages into the parent conversation document —
  // their output is returned via the create_team tool call result instead.
  if (conversationId) {
    const messagesToAppend = assembleMessagesToAppend({
      overrideMessagesToAppend,
      text,
      thinking,
      thinkingSignature,
      images,
      audioReference: audioRef,
      toolCalls,
      resolvedModel,
      providerName,
      usage,
      totalSeconds: totalSec,
      tokensPerSecond: tokensPerSec,
      estimatedCost,
      contentSegments,
      textFragments,
      thinkingFragments,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      thinkingEnabled: options.thinkingEnabled,
      reasoningEffort: options.reasoningEffort,
      thinkingBudget: options.thinkingBudget,
      userMessage,
      conversationMeta,
    });
    let toolConfig: Record<string, unknown> | undefined = undefined;
    if (resolvedEnabledTools) {
      const existingSettings = conversationMeta?.settings as
        | Record<string, unknown>
        | undefined;
      const existingToolConfig = existingSettings?.toolConfig as
        | Record<string, unknown>
        | undefined;
      const disabledTools: string[] =
        (Array.isArray(options.disabledTools) ? options.disabledTools : null) ||
        (Array.isArray(existingToolConfig?.disabledTools)
          ? (existingToolConfig.disabledTools as string[])
          : null) ||
        [];
      let availableTools: string[] = [];
      if (agent) {
        const persona = AgentPersonaRegistry.get(agent);
        if (persona) {
          const clientSchemas =
            ToolOrchestratorService.getClientToolSchemas() || [];
          const resolvedAvailable = resolveToolEntriesToSet(
            persona.availableTools,
            clientSchemas,
          );
          availableTools = [...resolvedAvailable];
        }
      } else {
        const clientSchemas =
          ToolOrchestratorService.getClientToolSchemas() || [];
        availableTools = clientSchemas.map((toolSchema) => toolSchema.name);
      }
      toolConfig = {
        availableTools,
        disabledTools,
        enabledTools: resolvedEnabledTools,
      };
    }

    const mergedSettings = {
      ...(conversationMeta?.settings as any || {}),
      provider: providerName,
      model: resolvedModel,
      agent: agent || undefined,
      workspaceRoot: workspaceRoot || undefined,
      toolConfig: toolConfig || undefined,
      harness: options.harness || undefined,
      topology: options.topology || undefined,
      thoughtStructure: options.thoughtStructure || undefined,
      locale: options.locale || undefined,
    };

    const finalMeta: Record<string, unknown> = {
      ...(conversationMeta || {}),
      settings: mergedSettings,
    };

    if (parentAgentConversationId) {
      finalMeta.parentAgentConversationId = parentAgentConversationId;
      finalMeta.isSubAgent = true;
    }
    if (parentConversationId) {
      finalMeta.parentConversationId = parentConversationId;
    }
    if (workspaceRoot) {
      finalMeta.workspaceRoot = workspaceRoot;
    }
    if (agent) {
      finalMeta.agent = agent;
    }
    // Ensure all user messages to append are properly swapped/sanitized,
    // then filter out synthetic compaction artifacts that should never
    // reach MongoDB (context notes, compaction summaries, cleared stubs).
    const sanitizedMessagesToAppend =
      sanitizeMessagesForPersistence(messagesToAppend);

    await appendAndFinalize(
      conversationId || "",
      project || "",
      username as string,
      sanitizedMessagesToAppend,
      finalMeta,
      getCollectionOpts(project, agent),
    );
  }
  // ── Verification assertion & Done event ───────────────────────
  let verResult: { passed: boolean; reason?: string; evidence_refs: string[] } | null = null;
  try {
    const effectiveRunId = (context as any).runId || TraceContext.runId() || agentConversationId || "run_final";
    const runSpans = RunEvidenceStore.getGlobalInstance().getSpans(effectiveRunId);
    const recordedSpans = runSpans.length > 0 ? runSpans : TraceExporter.getGlobalInstance().getQueuedSpans();
    verResult = DeterministicVerifiers.verifyCompletionClaim(text || "", recordedSpans);

    const effectiveTraceId = TraceContext.traceId() || (context as any).rootSpan?.trace_id || traceId || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const effectiveParentSpanId = TraceContext.currentSpanId() || (context as any).rootSpan?.span_id || null;

    const verSpan = new Span({
      trace_id: effectiveTraceId,
      parent_span_id: effectiveParentSpanId,
      run_id: effectiveRunId,
      name: "verification:completion_claim",
      kind: "verifier",
      attributes: {
        passed: verResult.passed,
        reason: verResult.reason,
        evidence_count: verResult.evidence_refs.length,
      },
    });
    verSpan.end(verResult.passed ? "OK" : "ERROR", verResult.reason);
    TraceExporter.getGlobalInstance().enqueueSpan(verSpan.toJSON());
  } catch (verErr) {
    logger.debug(`[DeterministicVerifiers] Finalizer verification error: ${verErr}`);
  }

  // ── Emit done event ───────────────────────────────────────────
  // Emitted AFTER persistence so the client's post-stream DB fetch
  // is guaranteed to see the complete, up-to-date conversation.
  if (!signal?.aborted) {
    if (emit) {
      const activeCtx = TraceContext.get();
      const resolvedTraceId = activeCtx?.trace_id || (context as any).rootSpan?.trace_id || traceId || null;
      const resolvedRunId = activeCtx?.run_id || (context as any).runId || null;
      const resolvedSpanId = activeCtx?.current_span_id || (context as any).rootSpan?.span_id || null;

      emit({
        type: SERVER_SENT_EVENT_TYPES.DONE,
        provider: providerName,
        model: resolvedModel,
        usage: usage || null,
        estimatedCost,
        tokensPerSec,
        ...(audioRef ? { audioRef } : {}),
        timeToGeneration:
          timeToGenerationSec != null
            ? roundMilliseconds(timeToGenerationSec)
            : null,
        generationTime:
          generationSec != null ? roundMilliseconds(generationSec) : null,
        totalTime: totalSec != null ? roundMilliseconds(totalSec) : null,
        ...(resolvedTraceId && { traceId: resolvedTraceId, trace_id: resolvedTraceId }),
        ...(conversationId && { conversationId }),
        ...(resolvedRunId && { run_id: resolvedRunId }),
        ...(resolvedSpanId && { span_id: resolvedSpanId }),
        ...(verResult && {
          verification: {
            passed: verResult.passed,
            reason: verResult.reason,
            evidence_count: verResult.evidence_refs.length,
          },
        }),
      });
    }
  }
}

export { getCollectionOpts };

/**
 * Sanitize messages for MongoDB persistence — clones each message,
 * applies content/rawContent swapping, strips runtime-only tags,
 * and filters out synthetic compaction artifacts that should never
 * reach the database (context notes, compaction summaries, planning
 * injections, eagerly-persisted stubs). System context messages
 * (_isInjectedContext) are preserved for conversation history visibility;
 * only the internal marker flag is cleaned from the persisted payload.
 *
 * Shared between production finalizer and test assertion suites.
 */
export function sanitizeMessagesForPersistence(
  messagesToAppend: MessagePayload[],
): MessagePayload[] {
  return messagesToAppend
    .filter((message) => {
      if (message._isIdentityPrompt === true) return false;

      if (message.role === "user" && typeof message.content === "string") {
        if (message.content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX))
          return false;
        if (message.content.startsWith(PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX))
          return false;
        if (message.isCompactSummary === true) return false;
      }
      if (message._isPlanningInjection === true) return false;
      if (message._alreadyPersisted === true) return false;
      return true;
    })
    .map((message) => {
      const cloned = { ...message };
      swapMessageContent(cloned);
      delete cloned._isIdentityPrompt;
      delete cloned._isInjectedContext;
      return cloned;
    });
}

/**
 * Standard utility to assemble the messages array to append to the database.
 * Shared between production finalizers and test assertion modules.
 */
export function assembleMessagesToAppend(options: {
  overrideMessagesToAppend?: MessagePayload[] | null;
  text: string | null;
  thinking?: string | null;
  thinkingSignature?: string | null;
  images?: string[];
  audioReference?: string | null;
  toolCalls?: ToolCallPayload[];
  resolvedModel: string;
  providerName: string;
  usage?: TokenUsage | null;
  totalSeconds?: number | null;
  tokensPerSecond?: number | null;
  estimatedCost?: number | null;
  contentSegments?: unknown[];
  textFragments?: unknown[];
  thinkingFragments?: unknown[];
  temperature?: number;
  maxTokens?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
  userMessage?: MessagePayload | null;
  conversationMeta?: Record<string, unknown> | null;
}): MessagePayload[] {
  const {
    overrideMessagesToAppend,
    text,
    thinking,
    thinkingSignature,
    images = [],
    audioReference,
    toolCalls = [],
    resolvedModel,
    providerName,
    usage,
    totalSeconds,
    tokensPerSecond,
    estimatedCost,
    contentSegments,
    textFragments,
    thinkingFragments,
    temperature,
    maxTokens,
    thinkingEnabled,
    reasoningEffort,
    thinkingBudget,
    userMessage,
    conversationMeta,
  } = options;

  let messagesToAppend: MessagePayload[] = [];

  if (overrideMessagesToAppend) {
    messagesToAppend = [...overrideMessagesToAppend];
    const hasIntermediateToolMessages = overrideMessagesToAppend.some(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls &&
        message.toolCalls.length > 0,
    );
    let finalThinking = thinking || "";
    if (hasIntermediateToolMessages && finalThinking) {
      for (const message of overrideMessagesToAppend) {
        if (
          message.role === "assistant" &&
          message.thinking &&
          finalThinking.startsWith(message.thinking)
        ) {
          finalThinking = finalThinking.slice(message.thinking.length).trim();
        }
      }
    }
    messagesToAppend.push({
      role: "assistant",
      content: text,
      ...(finalThinking && { thinking: finalThinking }),
      ...(thinkingSignature && { thinkingSignature }),
      ...(images.length > 0 && { images }),
      ...(audioReference && { audio: audioReference }),
      ...(!hasIntermediateToolMessages &&
        toolCalls.length > 0 && { toolCalls }),
      model: resolvedModel,
      provider: providerName,
      timestamp: new Date().toISOString(),
      usage: usage || null,
      totalTime:
        totalSeconds != null ? roundMilliseconds(totalSeconds as number) : null,
      tokensPerSec: tokensPerSecond,
      estimatedCost,
      ...(!hasIntermediateToolMessages && contentSegments?.length
        ? { contentSegments }
        : {}),
      ...(!hasIntermediateToolMessages && textFragments?.length
        ? { textFragments }
        : {}),
      ...(!hasIntermediateToolMessages && thinkingFragments?.length
        ? { thinkingFragments }
        : {}),
      generationSettings: {
        temperature,
        maxTokens,
        thinkingEnabled: thinkingEnabled || false,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(thinkingBudget ? { thinkingBudget } : {}),
      },
    } as MessagePayload);
  } else {
    if (userMessage && conversationMeta) {
      messagesToAppend.push({
        ...userMessage,
        role: "user",
        timestamp: userMessage.timestamp || new Date().toISOString(),
      });
    }
    messagesToAppend.push({
      role: "assistant",
      content: text,
      ...(thinking && { thinking }),
      ...(thinkingSignature && { thinkingSignature }),
      ...(images.length > 0 && { images }),
      ...(audioReference && { audio: audioReference }),
      ...(toolCalls.length > 0 && { toolCalls }),
      model: resolvedModel,
      provider: providerName,
      timestamp: new Date().toISOString(),
      usage: usage || null,
      totalTime: totalSeconds != null ? roundMilliseconds(totalSeconds) : null,
      tokensPerSec: tokensPerSecond,
      estimatedCost,
      generationSettings: {
        temperature,
        maxTokens,
        thinkingEnabled: thinkingEnabled || false,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(thinkingBudget ? { thinkingBudget } : {}),
      },
    } as MessagePayload);
  }

  return messagesToAppend;
}

/**
 * Slice and filter message history to identify new messages for the current turn.
 * Shared between BaseAgenticHarness execution and test suite assertion suites to ensure
 * they do not diverge.
 *
 * For sub-agents, the initial messages array contains both a system message
 * (operational context: topology, workspace, delegation rules) and a user
 * message (the task prompt). Both are new and must be persisted. The scan
 * below walks backward from the default slice point to find the earliest
 * consecutive non-persisted original message so nothing is dropped.
 */
export function computeNewTurnMessages(
  originalMessages: MessagePayload[],
  currentMessages: MessagePayload[],
  originalMessageCount: number,
): MessagePayload[] {
  const lastOriginalMessage = originalMessages[originalMessageCount - 1];
  const isLastAlreadyPersisted =
    lastOriginalMessage && lastOriginalMessage._alreadyPersisted === true;

  let sliceIndex: number;
  if (isLastAlreadyPersisted) {
    // All originals are already in the DB — only persist new messages
    sliceIndex = originalMessageCount;
  } else {
    // Default: include the last original message (the triggering user input)
    sliceIndex = Math.max(0, originalMessageCount - 1);

    // Walk backward to include any preceding non-persisted original messages
    // (e.g. sub-agent operational context system message at index 0)
    for (let scanIndex = sliceIndex - 1; scanIndex >= 0; scanIndex--) {
      if (originalMessages[scanIndex]?._alreadyPersisted) break;
      sliceIndex = scanIndex;
    }
  }

  return currentMessages
    .slice(sliceIndex)
    .filter(
      (message) =>
        !(
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX)
        ) && !message._alreadyPersisted,
    );
}
