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
  static async extractAndStore({
    project,
    username,
    messages,
    traceId,
    agentConversationId,
    conversationId,
    endpoint,
    agent,
    toolCalls,
    emit,
  }: MemoryExtractionContext): Promise<StoredMemory[]> {
    if (!messages || messages.length < MIN_MESSAGES_FOR_EXTRACTION) {
      logger.info(
        `[MemoryExtractor] Skipping — only ${messages?.length || 0} messages (min: ${MIN_MESSAGES_FOR_EXTRACTION})`,
      );
      return [];
    }

    // ── Mutual Exclusion ──────────────────────────────────────────
    // If the main agent already wrote memories this turn via save_memory,
    // skip extraction — the agent's explicit memory writes take precedence.
    // This prevents duplicate or conflicting memories from the extraction
    // pipeline when the agent has already decided what to remember.
    if (
      toolCalls?.some((toolCall) => toolCall.name === TOOL_NAMES.SAVE_MEMORY)
    ) {
      logger.info(
        `[MemoryExtractor] Skipping — main agent used save_memory this turn (mutual exclusion)`,
      );
      return [];
    }

    try {
      // ── Resolve extraction model from settings ────────────────
      let extractionProvider: string | undefined;
      let extractionModel: string | undefined;
      try {
        const memorySettings = (await SettingsService.getSection(
          "memory",
        )) as MemorySettingsSection;
        extractionProvider = memorySettings.extractionProvider;
        extractionModel = memorySettings.extractionModel;
      } catch {
        // Settings not configured — skip extraction silently
        logger.info(
          "[MemoryExtractor] Extraction model not configured in Settings → Memory Models. Skipping.",
        );
        return [];
      }

      if (!extractionProvider || !extractionModel) {
        logger.info(
          "[MemoryExtractor] Extraction provider/model not set. Skipping.",
        );
        return [];
      }

      let resolvedModel = extractionModel;
      let targetProviderId = extractionProvider;

      const baseType = getInstanceType(extractionProvider) || extractionProvider;
      let siblings = getInstancesByType(baseType);
      let modelRes = await resolveModelForInstances(resolvedModel, siblings);
      let usable = modelRes.usable;
      let modelOverrides = modelRes.modelOverrides;

      if (usable.length === 0) {
        throw new Error(
          `[MemoryExtractor] Model resolution failed: "${extractionModel}" is not loaded on any instances of provider type "${baseType}".`
        );
      }

      targetProviderId = usable[0].id;
      const override = modelOverrides.get(targetProviderId);
      if (override) {
        resolvedModel = override;
      }

      const provider = getProvider(targetProviderId);

      // Build conversation text (compact format to save tokens)
      const conversationText = messages
        .filter((message) => {
          if (message.role !== "user" && message.role !== "assistant") {
            return false;
          }
          const content = (message.content || "").trim();
          if (!content) {
            return false;
          }
          if (content === "[tool-only turn]" || content === "[Component]") {
            return false;
          }
          if (
            message._isSystemWarning === true ||
            (message.role === "user" &&
              (content.startsWith("[System:") ||
                content.includes("Your previous response contained only internal reasoning") ||
                content.includes("Do not repeat your reasoning")))
          ) {
            return false;
          }
          return true;
        })
        .map((message) => {
          const content = message.content || "";
          // Truncate very long messages to save tokens
          const truncated =
            content.length > 500 ? content.slice(0, 500) + "..." : content;
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
        result = await provider.generateText(aiMessages, resolvedModel, {
          maxTokens: 1000,
          temperature: 0.1,
          thinkingEnabled: false,
        });
      } catch (error: unknown) {
        success = false;
        extractionError = errorMessage(error);
        throw error;
      } finally {
        // Use real API-reported usage when available; fall back to heuristic
        const realUsage = result?.usage || null;
        const inputText = aiMessages
          .map((message) =>
            typeof message.content === "string" ? message.content : "",
          )
          .join("\n");
        const approxInputTokens = realUsage
          ? getTotalInputTokens(realUsage)
          : estimateTokens(inputText);
        const approxOutputTokens = realUsage
          ? realUsage.outputTokens || 0
          : result?.text
            ? estimateTokens(result.text)
            : 0;

        RequestLogger.logBackgroundLlmCall({
          requestId,
          endpoint: endpoint || "/agent",
          operation: "memory:extract",
          project,
          username: username || "system",
          agent: agent || null,
          provider: extractionProvider,
          model: extractionModel,
          traceId: traceId || null,
          conversationId: conversationId || null,
          agentConversationId: agentConversationId || null,
          aiMessages: aiMessages as MessagePayload[],
          resultText: result?.text || "",
          usage: realUsage,
          success,
          errorMessage: extractionError,
          requestStartMs: requestStart,
          extraRequestPayload: {
            messageCount: messages.length,
          },
        });

        // Emit incremental usage so the UI token badge updates in real-time
        // instead of jumping when fetchConversationStats runs 2-8s later.
        // Include estimatedCost so the conversation cost badge is accurate
        // before the backend aggregation (fetchConversationStats) completes.
        if (emit && success) {
          try {
            const extractPricing = getPricing(TYPES.TEXT, TYPES.TEXT)[
              extractionModel
            ];
            const extractCost = extractPricing
              ? calculateTextCost(
                  {
                    inputTokens: approxInputTokens,
                    outputTokens: approxOutputTokens,
                  },
                  extractPricing,
                )
              : null;
            emit({
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

      let memories: unknown = parseJsonFromLargeLanguageModelResponse(
        result!.text,
      );
      if (
        memories &&
        typeof memories === "object" &&
        !Array.isArray(memories)
      ) {
        const memoriesRecord = memories as Record<string, unknown>;
        if (Array.isArray(memoriesRecord.memories)) {
          memories = memoriesRecord.memories;
        } else if (Array.isArray(memoriesRecord.extractedMemories)) {
          memories = memoriesRecord.extractedMemories;
        } else if (
          memoriesRecord.type &&
          memoriesRecord.title &&
          memoriesRecord.content
        ) {
          memories = [memoriesRecord];
        } else {
          const arrayKey = Object.keys(memoriesRecord).find((key) =>
            Array.isArray(memoriesRecord[key]),
          );
          if (arrayKey) {
            memories = memoriesRecord[arrayKey];
          }
        }
      }

      if (!Array.isArray(memories)) {
        logger.warn(
          `[MemoryExtractor] Response was not an array or a recognized memory structure. Text: ${result!.text ? result!.text.substring(0, 200) : "empty"}`,
        );
        return [];
      }

      const extractedMemories = memories as ExtractedMemory[];

      // ── Store each memory via MemoryService ─────────────────────
      const agentId = agent || AGENT_IDS.CODING;
      const stored: StoredMemory[] = [];

      for (const memoryObject of extractedMemories) {
        if (!memoryObject.content || !memoryObject.title) continue;

        // Validate type — default to "project" if unknown
        const type = CODING_MEMORY_TYPES.includes(memoryObject.type)
          ? memoryObject.type
          : "project";

        try {
          const storeResult = await MemoryService.store({
            agent: agentId,
            project,
            username,
            type,
            title: memoryObject.title,
            content: memoryObject.content,
            conversationId: conversationId || undefined,
            traceId: traceId || undefined,
            agentConversationId: agentConversationId || undefined,
            endpoint: endpoint || "/agent",
          });

          if (storeResult) {
            stored.push({
              type,
              id: storeResult.id,
              title: memoryObject.title,
            });
            logger.info(
              `[MemoryExtractor] Stored [${type}] "${memoryObject.title.substring(0, 60)}"`,
            );
          } else {
            logger.info(
              `[MemoryExtractor] Skipped duplicate [${type}] "${memoryObject.title.substring(0, 60)}"`,
            );
          }
        } catch (error: unknown) {
          logger.error(
            `[MemoryExtractor] Storage failed: ${errorMessage(error)}`,
          );
        }
      }

      logger.info(
        `[MemoryExtractor] Stored ${stored.length}/${extractedMemories.length} memories from conversation ${conversationId || "unknown"}`,
      );

      // Emit usage for the embedding calls that happened during storage.
      // Each MemoryService.store() generates one embedding — report the
      // aggregate so the UI request count grows incrementally.
      if (emit && stored.length > 0) {
        try {
          const embedTokens = stored.length * 50; // ~50 tokens per memory title+content
          // Embedding cost: input tokens only (no output tokens)
          const embedPricing = getPricing(TYPES.TEXT, TYPES.EMBEDDING);
          const embedModel = (
            (await SettingsService.getSection(
              "memory",
            )) as MemorySettingsSection
          )?.embeddingModel;
          const embedModelPricing = embedModel
            ? embedPricing[embedModel]
            : null;
          const embedCost = embedModelPricing?.inputPerMillion
            ? (embedTokens / 1_000_000) * embedModelPricing.inputPerMillion
            : null;
          emit({
            type: "usage_update",
            operation: "memory:embed",
            usage: {
              requests: stored.length,
              inputTokens: embedTokens,
              outputTokens: 0,
              estimatedCost: embedCost,
            },
          });
        } catch {
          /* SSE channel may be closed */
        }
      }

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
