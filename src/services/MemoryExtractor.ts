import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import { getInstancesByType, getInstanceType } from "../providers/instance-registry.ts";
import { resolveModelForInstances } from "../utils/ModelResolution.ts";
import MemoryService, { CODING_MEMORY_TYPES } from "./MemoryService.ts";
import MemoryConsolidationService from "./MemoryConsolidationService.ts";
import PromptLocaleService from "./PromptLocaleService.ts";
import RequestLogger from "./RequestLogger.ts";
import SettingsService from "./SettingsService.ts";
import logger from "../utils/logger.ts";
import { parseJsonFromLargeLanguageModelResponse } from "@rodrigo-barraza/utilities-library";
import {
  TOOL_NAMES,
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  estimateTokens,
  calculateTextCost,
  getTotalInputTokens,
} from "../utils/CostCalculator.ts";
import { TYPES, getPricing } from "../config.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import type {
  ConversationMessage,
  ToolCall,
  EmitFunction,
  AgenticContext,
} from "./harnesses/types.ts";
import type { ChatMessage, GenerateTextResult } from "../types/provider.ts";
import type { MessagePayload } from "./RequestLogger.ts";
import {
  readWatermark,
  selectExtractionSpan,
  writeWatermark,
} from "./memory/ExtractionWatermark.ts";
import { runWithRequestPriority } from "./RequestPriority.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_MESSAGES_FOR_EXTRACTION = 4;

/**
 * Extraction prompt — CC-style 4-type taxonomy with explicit negative constraints.
 *
 * Types:
 *   user      — user's role, goals, expertise, preferences
 *   feedback  — corrections + confirmations ("don't mock DB", "yes, bundled PR was right")
 *   project   — non-derivable project context (deadlines, incidents, decisions)
 *   reference — pointers to external systems (Linear projects, Grafana boards, API endpoints)
 *
 * Negative constraints prevent saving information that is derivable from the
 * codebase itself (via grep, git, file reads). This is Claude Code's most
 * impactful memory quality insight — eval-validated.
 */
const EXTRACTION_PROMPT = PromptLocaleService.get("en", "memory.extractionPrompt");

interface ExtractedMemory {
  type: string;
  title: string;
  content: string;
}

interface StoredMemory {
  type: string;
  id: string;
  title: string;
}

interface MemoryExtractionContext {
  project: string;
  username: string;
  messages: ConversationMessage[];
  traceId?: string | null;
  agentConversationId?: string | null;
  conversationId?: string | null;
  endpoint?: string | null;
  agent?: string | null;
  toolCalls?: ToolCall[];
  emit?: EmitFunction | null;
  activeProviderName?: string;
  activeResolvedModel?: string;
}

interface MemorySettingsSection {
  extractionProvider?: string;
  extractionModel?: string;
  embeddingModel?: string;
}

interface AfterResponseOutput {
  _text?: string;
  messages?: ConversationMessage[];
  toolCalls?: ToolCall[];
}

// ─── MemoryExtractor ─────────────────────────────────────────────────────────

/**
 * MemoryExtractor — extracts and stores memories from agentic conversations.
 *
 * Architecture: Single-store, CC-style.
 * - 4-type taxonomy: user, feedback, project, reference
 * - All memories stored in the unified `memories` collection via MemoryService
 * - Mutual exclusion: skips extraction when the main agent used save_memory
 * - Configurable extraction model via Settings → Memory Models
 *
 * Registered as an `afterResponse` hook in AgentHooks.
 * Runs in the background (fire-and-forget) after the final response.
 */
export default class MemoryExtractor {
  private static shouldSkipExtraction(
    project: string,
    messages: ConversationMessage[] | undefined,
    toolCalls: ToolCall[] | undefined,
  ): boolean {
    if (project === "vllm-trading-bot") {
      logger.info(
        `[MemoryExtractor] Skipping — project "${project}" is isolated from harness memory extraction (B4).`,
      );
      return true;
    }
    if (!messages || messages.length < MIN_MESSAGES_FOR_EXTRACTION) {
      logger.info(
        `[MemoryExtractor] Skipping — only ${messages?.length || 0} messages (min: ${MIN_MESSAGES_FOR_EXTRACTION})`,
      );
      return true;
    }
    if (toolCalls?.some((toolCall) => toolCall.name === TOOL_NAMES.SAVE_MEMORY)) {
      logger.info(
        `[MemoryExtractor] Skipping — main agent used save_memory this turn (mutual exclusion)`,
      );
      return true;
    }
    return false;
  }

  private static async resolveExtractionTarget(
    activeProviderName?: string,
    activeResolvedModel?: string,
  ): Promise<{
    extractionProvider: string;
    extractionModel: string;
    targetProviderId: string;
    resolvedModel: string;
  } | null> {
    let extractionProvider = activeProviderName;
    let extractionModel = activeResolvedModel;

    if (!extractionProvider || !extractionModel) {
      try {
        const memorySettings = (await SettingsService.getSection(
          "memory",
        )) as MemorySettingsSection;
        extractionProvider = extractionProvider || memorySettings.extractionProvider;
        extractionModel = extractionModel || memorySettings.extractionModel;
      } catch {
        logger.info(
          "[MemoryExtractor] Extraction model not configured in Settings → Memory Models. Skipping.",
        );
        return null;
      }
    }

    if (!extractionProvider || !extractionModel) {
      logger.info("[MemoryExtractor] Extraction provider/model not set. Skipping.");
      return null;
    }

    let resolvedModel = extractionModel;
    let targetProviderId = extractionProvider;

    const baseType = getInstanceType(extractionProvider);
    if (baseType) {
      const siblings = getInstancesByType(baseType);
      const { usable, modelOverrides } = await resolveModelForInstances(resolvedModel, siblings);
      if (usable.length > 0) {
        targetProviderId = usable[0].id;
        const override = modelOverrides.get(targetProviderId);
        if (override) resolvedModel = override;
      } else {
        logger.warn(
          `[MemoryExtractor] No active instances found for model "${extractionModel}" on provider type "${baseType}". Falling back to "${targetProviderId}".`,
        );
      }
    }

    return { extractionProvider, extractionModel, targetProviderId, resolvedModel };
  }

  private static isExtractableMessage(message: ConversationMessage): boolean {
    if (message.role !== "user" && message.role !== "assistant") return false;
    const content = (message.content || "").trim();
    if (!content || content === "[tool-only turn]" || content === "[Component]") return false;
    if (message._isSystemWarning === true) return false;
    if (
      message.role === "user" &&
      (content.startsWith("[System:") ||
        content.includes("Your previous response contained only internal reasoning") ||
        content.includes("Do not repeat your reasoning"))
    ) {
      return false;
    }
    return true;
  }

  private static estimateExtractionTokens(
    aiMessages: ChatMessage[],
    result: GenerateTextResult | undefined,
  ): { approxInputTokens: number; approxOutputTokens: number } {
    const realUsage = result?.usage || null;
    if (realUsage) {
      return {
        approxInputTokens: getTotalInputTokens(realUsage),
        approxOutputTokens: realUsage.outputTokens || 0,
      };
    }
    const inputText = aiMessages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    return {
      approxInputTokens: estimateTokens(inputText),
      approxOutputTokens: result?.text ? estimateTokens(result.text) : 0,
    };
  }

  private static logAndEmitExtractionUsage(
    ctx: MemoryExtractionContext,
    extractionProvider: string,
    extractionModel: string,
    aiMessages: ChatMessage[],
    result: GenerateTextResult | undefined,
    success: boolean,
    extractionError: string | null,
    requestId: string,
    requestStart: number,
  ): void {
    const realUsage = result?.usage || null;
    const { approxInputTokens, approxOutputTokens } = MemoryExtractor.estimateExtractionTokens(
      aiMessages,
      result,
    );

    RequestLogger.logBackgroundLlmCall({
      requestId,
      endpoint: ctx.endpoint || "/agent",
      operation: "memory:extract",
      project: ctx.project,
      username: ctx.username || "system",
      agent: ctx.agent || null,
      provider: extractionProvider,
      model: extractionModel,
      traceId: ctx.traceId || null,
      conversationId: ctx.conversationId || null,
      agentConversationId: ctx.agentConversationId || null,
      aiMessages: aiMessages as MessagePayload[],
      resultText: result?.text || "",
      usage: realUsage,
      success,
      errorMessage: extractionError,
      requestStartMs: requestStart,
      extraRequestPayload: {
        messageCount: ctx.messages.length,
      },
    });

    if (ctx.emit && success) {
      try {
        const extractPricing = getPricing(TYPES.TEXT, TYPES.TEXT)[extractionModel];
        const extractCost = extractPricing
          ? calculateTextCost(
              { inputTokens: approxInputTokens, outputTokens: approxOutputTokens },
              extractPricing,
            )
          : null;
        ctx.emit({
          type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
          operation: "memory:extract",
          usage: {
            requests: 1,
            inputTokens: approxInputTokens,
            outputTokens: approxOutputTokens,
            estimatedCost: extractCost,
          },
        });
      } catch {
        /* SSE channel may be closed */
      }
    }
  }

  private static normalizeParsedMemories(rawMemories: unknown): ExtractedMemory[] | null {
    let memories = rawMemories;
    if (memories && typeof memories === "object" && !Array.isArray(memories)) {
      const record = memories as Record<string, unknown>;
      if (Array.isArray(record.memories)) {
        memories = record.memories;
      } else if (Array.isArray(record.extractedMemories)) {
        memories = record.extractedMemories;
      } else if (record.type && record.title && record.content) {
        memories = [record];
      } else {
        const arrayKey = Object.keys(record).find((key) => Array.isArray(record[key]));
        if (arrayKey) memories = record[arrayKey];
      }
    }
    return Array.isArray(memories) ? (memories as ExtractedMemory[]) : null;
  }

  private static async storeExtractedMemoryList(
    extractedMemories: ExtractedMemory[],
    ctx: MemoryExtractionContext,
  ): Promise<StoredMemory[]> {
    const agentId = ctx.agent || AGENT_IDS.CODING;
    const stored: StoredMemory[] = [];

    for (const memoryObject of extractedMemories) {
      if (!memoryObject.content || !memoryObject.title) continue;
      const type = CODING_MEMORY_TYPES.includes(memoryObject.type) ? memoryObject.type : "project";
      try {
        const storeResult = await MemoryService.store({
          agent: agentId,
          project: ctx.project,
          username: ctx.username,
          type,
          title: memoryObject.title,
          content: memoryObject.content,
          conversationId: ctx.conversationId || undefined,
          traceId: ctx.traceId || undefined,
          agentConversationId: ctx.agentConversationId || undefined,
          endpoint: ctx.endpoint || "/agent",
        });

        if (storeResult) {
          stored.push({ type, id: storeResult.id, title: memoryObject.title });
          logger.info(
            `[MemoryExtractor] Stored [${type}] "${memoryObject.title.substring(0, 60)}"`,
          );
        } else {
          logger.info(
            `[MemoryExtractor] Skipped duplicate [${type}] "${memoryObject.title.substring(0, 60)}"`,
          );
        }
      } catch (error: unknown) {
        logger.error(`[MemoryExtractor] Storage failed: ${errorMessage(error)}`);
      }
    }
    return stored;
  }

  private static async emitEmbeddingUsageIfNeeded(
    emit: EmitFunction | null | undefined,
    storedCount: number,
  ): Promise<void> {
    if (!emit || storedCount <= 0) return;
    try {
      const embedTokens = storedCount * 50;
      const embedPricing = getPricing(TYPES.TEXT, TYPES.EMBEDDING);
      const embedModel = (
        (await SettingsService.getSection("memory")) as MemorySettingsSection
      )?.embeddingModel;
      const embedModelPricing = embedModel ? embedPricing[embedModel] : null;
      const embedCost = embedModelPricing?.inputPerMillion
        ? (embedTokens / 1_000_000) * embedModelPricing.inputPerMillion
        : null;
      emit({
        type: "usage_update",
        operation: "memory:embed",
        usage: {
          requests: storedCount,
          inputTokens: embedTokens,
          outputTokens: 0,
          estimatedCost: embedCost,
        },
      });
    } catch {
      /* SSE channel may be closed */
    }
  }

  static async extractAndStore(ctx: MemoryExtractionContext): Promise<StoredMemory[]> {
    const {
      project,
      messages,
      agentConversationId,
      conversationId,
      toolCalls,
      emit,
      activeProviderName,
      activeResolvedModel,
    } = ctx;

    if (MemoryExtractor.shouldSkipExtraction(project, messages, toolCalls)) {
      return [];
    }

    try {
      const target = await MemoryExtractor.resolveExtractionTarget(
        activeProviderName,
        activeResolvedModel,
      );
      if (!target) return [];
      const { extractionProvider, extractionModel, targetProviderId, resolvedModel } = target;
      const provider = getProvider(targetProviderId);

      const transcript = messages.filter((msg) => MemoryExtractor.isExtractableMessage(msg));
      const watermarkScopeKey =
        conversationId || agentConversationId || `adhoc:${crypto.randomUUID()}`;
      const watermark = await readWatermark(watermarkScopeKey);
      const extractionSpan = selectExtractionSpan(
        transcript as Array<Record<string, unknown>>,
        watermark,
      );
      if (extractionSpan.span.length === 0) {
        logger.info(
          `[MemoryExtractor] Skipping — nothing new after the extraction watermark (${extractionSpan.reason}).`,
        );
        return [];
      }
      if (!extractionSpan.hasUserAuthored) {
        logger.info("[MemoryExtractor] Skipping — new span carries nothing the user wrote.");
        return [];
      }

      const spanMessages = extractionSpan.span as ConversationMessage[];
      const conversationText = spanMessages
        .map((message) => {
          const content = message.content || "";
          const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
          return `${message.role}: ${truncated}`;
        })
        .join("\n");

      const aiMessages: ChatMessage[] = [
        { role: "system", content: EXTRACTION_PROMPT },
        {
          role: "user",
          content: `Extract memories from this coding session:\n\n${conversationText}`,
        },
      ];

      const requestId = crypto.randomUUID();
      const requestStart = performance.now();
      let result: GenerateTextResult | undefined;
      let success = true;
      let extractionError: string | null = null;

      try {
        result = await runWithRequestPriority("background", () =>
          provider.generateText(aiMessages, resolvedModel, {
            maxTokens: 1000,
            temperature: 0.1,
            thinkingEnabled: false,
          }),
        );
      } catch (error: unknown) {
        success = false;
        extractionError = errorMessage(error);
        throw error;
      } finally {
        MemoryExtractor.logAndEmitExtractionUsage(
          ctx,
          extractionProvider,
          extractionModel,
          aiMessages,
          result,
          success,
          extractionError,
          requestId,
          requestStart,
        );
      }

      await writeWatermark(watermarkScopeKey, transcript as Array<Record<string, unknown>>);

      const rawParsed = parseJsonFromLargeLanguageModelResponse(result!.text);
      const extractedMemories = MemoryExtractor.normalizeParsedMemories(rawParsed);
      if (!extractedMemories) {
        logger.warn(
          `[MemoryExtractor] Response was not an array or a recognized memory structure. Text: ${result!.text ? result!.text.substring(0, 200) : "empty"}`,
        );
        return [];
      }

      const stored = await MemoryExtractor.storeExtractedMemoryList(extractedMemories, ctx);
      logger.info(
        `[MemoryExtractor] Stored ${stored.length}/${extractedMemories.length} memories from conversation ${conversationId || "unknown"}`,
      );
      await MemoryExtractor.emitEmbeddingUsageIfNeeded(emit, stored.length);
      return stored;
    } catch (error: unknown) {
      logger.error(`[MemoryExtractor] Failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Create an afterResponse hook handler for AgentHooks.
   * Runs as fire-and-forget (non-blocking).
   */
  static createHook() {
    return async (
      context: AgenticContext,
      { _text, messages, toolCalls }: AfterResponseOutput,
    ) => {
      // Fire-and-forget — don't block the response
      MemoryExtractor.extractAndStore({
        project: context.project,
        username: context.username,
        messages: messages || context.messages,
        traceId: context.traceId,
        agentConversationId: context.agentConversationId,
        conversationId: context.conversationId as string | null,
        endpoint:
          ((context as Record<string, unknown>).endpoint as string | null) ||
          "/agent",
        agent: context.agent || null,
        toolCalls: toolCalls || [],
        emit: context.emit || null,
        activeProviderName: context.providerName,
        activeResolvedModel: context.resolvedModel,
      })
        .then((stored) => {
          if (stored?.length > 0 && context.emit) {
            context.emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.MEMORIES_UPDATED,
              count: stored.length,
            });
          }

          // Build a broadcast callback from ctx.emit for consolidation notifications
          const broadcast = context.emit
            ? (payload: Record<string, unknown>) =>
                context.emit(
                  payload as { type: string; [key: string]: unknown },
                )
            : undefined;

          // Check if consolidation should run (tracks conversation count)
          MemoryConsolidationService.checkAndRun({
            project: context.project,
            username: context.username,
            broadcast,
            endpoint:
              ((context as Record<string, unknown>).endpoint as
                | string
                | null) || "/agent",
            agent: context.agent || null,
            traceId: context.traceId || null,
            agentConversationId: context.agentConversationId || null,
          });
        })
        .catch((error: unknown) =>
          logger.error(
            `[MemoryExtractor] Background extraction failed: ${errorMessage(error)}`,
          ),
        );
    };
  }
}
