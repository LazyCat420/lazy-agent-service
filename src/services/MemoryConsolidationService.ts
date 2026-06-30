import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import type { ChatMessage } from "../types/provider.ts";
import type { MessagePayload } from "./conversation/types.ts";
import MemoryService from "./MemoryService.ts";
import RequestLogger from "./RequestLogger.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import { parseJsonFromLargeLanguageModelResponse } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS } from "../constants.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import SettingsService from "./SettingsService.ts";
import {
  estimateTokens,
  calculateTextCost,
  getTotalInputTokens,
} from "../utils/CostCalculator.ts";
import { TYPES, getPricing } from "../config.ts";

// ── Extracted sub-modules ───────────────────────────────────
import {
  findClusters,
  CONVERSATIONAL_CLUSTER_THRESHOLD,
} from "./memory/ClusterDetection.ts";
import {
  CONSOLIDATION_PROMPT,
  CONVERSATIONAL_CONSOLIDATION_PROMPT,
  buildBatchInput,
  buildConversationalBatchInput,
} from "./memory/ConsolidationPrompts.ts";
import { buildBatches } from "./memory/BatchBuilder.ts";
import {
  SESSIONS_BETWEEN_RUNS,
  getRunCount,
  incrementRunCount,
  resetRunCount,
  recordHistory,
  canRunToday,
  getHistory,
} from "./memory/ConsolidationTracker.ts";
import {
  partitionConversationalMemories,
  findStaleConversationalMemories,
} from "./memory/ConversationalMemoryPartitioner.ts";

import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import type {
  MemoryDoc,
  ConsolidationAction,
  ConsolidationBatch,
  PartitionMeta,
  ProcessBatchOptions,
  ApplyActionsOptions,
  ConsolidateOptions,
  CheckAndRunOptions,
} from "./memory/types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────
/** Resolve the current consolidation provider + model from settings. */
async function getConsolidationConfig() {
  return SettingsService.getMemoryModelConfig("consolidation");
}
/** Memories older than this (days) with ephemeral types get flagged for staleness review */
const STALENESS_DAYS = 30;
/** Output token limit per LLM call — 2000 was too low for complex merges */
const LLM_MAX_OUTPUT_TOKENS = 4096;

function daysSince(isoDate: string) {
  return daysSinceIso(isoDate);
}

// ─── Action Execution ────────────────────────────────────────────────────────
/**
 * Apply consolidation actions. For conversational agent merges, memoryLookup
 * is used to preserve source attribution metadata on the merged document.
 */
async function applyActions(
  actions: ConsolidationAction[],
  agent: string,
  agentType: string,
  project: string | null,
  username: string,
  { traceId, endpoint, memoryLookup }: ApplyActionsOptions = {},
) {
  const results = { merged: 0, deleted: 0, errors: 0 };
  const isConversational = agentType === "conversational";

  for (const action of actions) {
    try {
      if (
        action.type === "merge" &&
        action.sourceIds?.length &&
        action.sourceIds.length >= 2 &&
        action.merged
      ) {
        // Collect conversational agent metadata from source memories before deletion
        let attributionMetadata: Record<string, unknown> = {};
        if (isConversational && memoryLookup) {
          const sources = action.sourceIds
            .map((id: string) => memoryLookup.get(id))
            .filter(Boolean) as MemoryDoc[];

          if (sources.length > 0) {
            // All memories in a merge share the same about/source (partitioned)
            const primary = sources[0];
            // Collect all unique sources for the mergedSources attribution chain
            const uniqueSources = new Map<
              string,
              { sourceUserId: string; sourceUsername: string }
            >();
            for (const source of sources) {
              if (
                source.sourceUserId &&
                !uniqueSources.has(source.sourceUserId)
              ) {
                uniqueSources.set(source.sourceUserId, {
                  sourceUserId: source.sourceUserId,
                  sourceUsername: source.sourceUsername || "",
                });
              }
            }
            attributionMetadata = {
              metadata: {
                aboutUserId: primary.aboutUserId,
                aboutUsername: primary.aboutUsername,
                sourceUserId: primary.sourceUserId,
                sourceUsername: primary.sourceUsername,
                guildId: primary.guildId,
                mergedSources: [...uniqueSources.values()],
              },
            };
          }
        }

        // Delete source memories
        for (const id of action.sourceIds) {
          await MemoryService.remove(id);
        }
        // Store consolidated memory
        await MemoryService.store({
          agent,
          project,
          username: username || "system",
          type: action.merged.type || (isConversational ? "other" : "project"),
          title: action.merged.title || null,
          content: action.merged.content,
          conversationId: null,
          traceId: traceId || undefined,
          endpoint: endpoint || undefined,
          ...attributionMetadata,
        });
        results.merged += action.sourceIds.length;
        logger.info(
          `[MemoryConsolidation] Merged ${action.sourceIds.length} → "${action.merged.title || action.merged.content?.substring(0, 60)}" (${action.reason || ""})`,
        );
      } else if (action.type === "delete" && action.id) {
        await MemoryService.remove(action.id);
        results.deleted++;
        logger.info(
          `[MemoryConsolidation] Deleted "${action.id}" (${action.reason || ""})`,
        );
      }
    } catch (error: unknown) {
      results.errors++;
      logger.error(
        `[MemoryConsolidation] Failed to apply action: ${getErrorMessage(error)}`,
      );
    }
  }
  return results;
}

// ─── Single Batch LLM Call ───────────────────────────────────────────────────
/**
 * Run a single LLM consolidation call for one batch.
 * Returns parsed actions array, or empty array on failure.
 */
async function processBatch(
  batch: ConsolidationBatch,
  batchIndex: number,
  totalBatches: number,
  {
    provider,
    consolidationProvider,
    consolidationModel,
    agent,
    project,
    username,
    trigger,
    endpoint,
    traceId,
    agentConversationId,
    broadcast,
    systemPrompt = CONSOLIDATION_PROMPT,
    inputBuilder,
  }: ProcessBatchOptions,
): Promise<ConsolidationAction[]> {
  const input = inputBuilder
    ? inputBuilder(batch.clusters, batch.stale, batch.partitionMeta)
    : buildBatchInput(batch.clusters, batch.stale);
  if (!input) return [];

  const batchLabel = `[batch ${batchIndex + 1}/${totalBatches}]`;
  const clusterCount = batch.clusters.length;
  const staleCount = batch.stale.length;
  logger.info(
    `[MemoryConsolidation] ${batchLabel} Processing ${clusterCount} clusters, ${staleCount} stale memories`,
  );

  const aiMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input },
  ];

  const inputText = aiMessages.map((message) => message.content).join("\n");
  const approxInputTokens = estimateTokens(inputText);
  logger.info(
    `[MemoryConsolidation] ${batchLabel} Input: ~${approxInputTokens} tokens`,
  );

  const llmRequestId = crypto.randomUUID();
  const llmStart = performance.now();
  let llmSuccess = true;
  let llmError: string | null = null;
  let result: { text?: string; usage?: Record<string, number> } | null = null;

  try {
    result = (await provider.generateText(aiMessages, consolidationModel, {
      maxTokens: LLM_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
      thinkingEnabled: false,
    })) as unknown as { text?: string; usage?: Record<string, number> };
  } catch (error: unknown) {
    llmSuccess = false;
    llmError = getErrorMessage(error);
    logger.error(
      `[MemoryConsolidation] ${batchLabel} LLM call failed: ${getErrorMessage(error)}`,
    );
  }

  // Use real API-reported usage when available; fall back to heuristic
  const realUsage = result?.usage || null;
  const inputTokens = realUsage
    ? getTotalInputTokens(realUsage)
    : estimateTokens(inputText);
  const outputTokens = realUsage
    ? realUsage.outputTokens || 0
    : result?.text
      ? estimateTokens(result.text)
      : 0;
  RequestLogger.logBackgroundLlmCall({
    requestId: llmRequestId,
    endpoint: endpoint || null,
    operation: "memory:consolidate",
    project,
    username: username || "system",
    agent: agent || null,
    provider: consolidationProvider,
    model: consolidationModel,
    traceId: traceId || null,
    agentConversationId: agentConversationId || null,
    aiMessages: aiMessages as MessagePayload[],
    resultText: result?.text || "",
    usage: realUsage,
    success: llmSuccess,
    errorMessage: llmError,
    requestStartMs: llmStart,
    extraRequestPayload: {
      trigger,
      batchIndex,
      totalBatches,
      clusterCount,
      staleCount,
    },
  });

  // Broadcast incremental usage with cost
  if (typeof broadcast === "function" && llmSuccess) {
    try {
      const consolidatePricing = getPricing(TYPES.TEXT, TYPES.TEXT)[
        consolidationModel
      ];
      const consolidateCost = consolidatePricing
        ? calculateTextCost(
            realUsage || { inputTokens, outputTokens },
            consolidatePricing,
          )
        : null;
      broadcast({
        type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
        operation: "memory:consolidate",
        usage: {
          requests: 1,
          inputTokens,
          outputTokens,
          estimatedCost: consolidateCost,
        },
      });
    } catch {
      /* SSE channel may be closed */
    }
  }

  if (!llmSuccess || !result?.text) {
    return [];
  }

  // Parse response with enhanced diagnostics
  const parsed = parseJsonFromLargeLanguageModelResponse(result.text) as {
    actions?: ConsolidationAction[];
  } | null;
  if (!parsed) {
    const responseLength = result.text?.length || 0;
    const snippet = result.text?.substring(0, 300) || "(empty)";
    const tail =
      responseLength > 300 ? result.text.substring(responseLength - 200) : "";
    logger.warn(
      `[MemoryConsolidation] ${batchLabel} Failed to parse LLM response ` +
        `(${responseLength} chars, ~${outputTokens} tokens). ` +
        `Head: ${snippet}${tail ? `\n  Tail: ${tail}` : ""}`,
    );
    return [];
  }

  return parsed.actions || [];
}

// ─── Public API ──────────────────────────────────────────────────────────────
const MemoryConsolidationService = {
  /**
   * Run memory consolidation for a specific agent within a project.
   * Processes memories in batches to avoid context window overflow.
   */
  async consolidate({
    agent = AGENT_IDS.CODING,
    project,
    username,
    trigger = "manual",
    broadcast,
    endpoint,
    traceId,
    agentConversationId,
    guildId,
  }: ConsolidateOptions) {
    const startTime = performance.now();
    const agentId = agent || AGENT_IDS.CODING;
    const persona = AgentPersonaRegistry.get(agentId);
    const agentType = persona?.type || "";
    const isConversational = agentType === "conversational";
    logger.info(
      `[MemoryConsolidation] Starting ${agentType || "general"} consolidation for agent "${agentId}", project "${project}" (trigger: ${trigger})`,
    );

    // Cost guard — check daily budget
    if (!(await canRunToday(project || guildId || "global"))) {
      return { skipped: true, reason: "daily_limit_reached", total: 0 };
    }

    // Load all memories with embeddings (LUPOS needs extra fields)
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");

    const query: Record<string, unknown> = { agent: agentId };
    if (project) query.project = project;
    if (isConversational && guildId) query.guildId = guildId;

    const projection = isConversational
      ? {
          embedding: 1,
          id: 1,
          type: 1,
          title: 1,
          content: 1,
          createdAt: 1,
          aboutUserId: 1,
          aboutUsername: 1,
          sourceUserId: 1,
          sourceUsername: 1,
          guildId: 1,
        }
      : { embedding: 1, id: 1, type: 1, title: 1, content: 1, createdAt: 1 };

    const allMemories = (await db
      .collection(COLLECTIONS.MEMORIES)
      .find(query)
      .project(projection)
      .toArray()) as MemoryDoc[];

    if (allMemories.length < 2) {
      logger.info(
        `[MemoryConsolidation] Only ${allMemories.length} memories — skipping`,
      );
      await resetRunCount(project || guildId || "global");
      return {
        skipped: true,
        reason: "insufficient memories",
        total: allMemories.length,
      };
    }

    logger.info(
      `[MemoryConsolidation] Loaded ${allMemories.length} memories for clustering`,
    );

    // Resolve the consolidation model
    const { provider: consolidationProvider, model: consolidationModel } =
      await getConsolidationConfig();
    const provider = getProvider(consolidationProvider);

    // Build a lookup map for metadata preservation during merges
    const memoryLookup = new Map<string, MemoryDoc>(
      allMemories.map((message) => [message.id, message]),
    );

    const allActions: ConsolidationAction[] = [];
    let batches: ConsolidationBatch[] = [];

    if (isConversational) {
      // ── Conversational Path: partition by (aboutUserId, sourceUserId) ────
      const partitions = partitionConversationalMemories(allMemories);
      logger.info(
        `[MemoryConsolidation] Conversational (${agentId}): ${partitions.size} partitions (unique observer→subject pairs)`,
      );

      for (const [key, memories] of partitions) {
        if (memories.length < 2) continue;

        // Cluster within this partition using the higher conversational threshold
        const partitionClusters = findClusters(
          memories,
          CONVERSATIONAL_CLUSTER_THRESHOLD,
        );
        const partitionStale = findStaleConversationalMemories(memories);

        // ── Release embeddings after clustering ──────────────────────
        // Embeddings (1536-dim float arrays, ~12KB each) are only needed
        // for cosine similarity in findClusters(). Strip them now so
        // GC can reclaim before the LLM batch loop.
        for (const message of memories) {
          message.embedding = null;
        }

        if (partitionClusters.length === 0 && partitionStale.length === 0)
          continue;

        // Extract metadata for the partition header
        const sample = memories[0];
        const partitionMeta: PartitionMeta = {
          aboutUserId: sample.aboutUserId || "",
          aboutUsername: sample.aboutUsername || "",
          sourceUserId: sample.sourceUserId || "",
          sourceUsername: sample.sourceUsername || "",
        };

        // Build batches for this partition
        const partitionBatches = buildBatches(
          partitionClusters,
          partitionStale,
        );
        for (const b of partitionBatches) {
          b.partitionMeta = partitionMeta;
        }
        batches.push(...partitionBatches);

        logger.info(
          `[MemoryConsolidation] Conversational partition ${key}: ${memories.length} memories → ${partitionClusters.length} clusters, ${partitionStale.length} stale`,
        );
      }

      if (batches.length === 0) {
        logger.info(
          `[MemoryConsolidation] Conversational (${agentId}): No consolidation candidates across partitions`,
        );
        await resetRunCount(project || guildId || "global");
        return {
          skipped: true,
          reason: "no candidates",
          total: allMemories.length,
        };
      }

      // Process conversational batches with the conversational-specific prompt
      for (let i = 0; i < batches.length; i++) {
        const batchActions = await processBatch(batches[i], i, batches.length, {
          provider,
          consolidationProvider,
          consolidationModel,
          agent: agentId,
          project: project || null,
          username: username || "system",
          trigger: trigger || "manual",
          endpoint,
          traceId,
          agentConversationId,
          broadcast,
          systemPrompt: CONVERSATIONAL_CONSOLIDATION_PROMPT,
          inputBuilder: buildConversationalBatchInput,
        });
        allActions.push(...batchActions);
      }
    } else {
      // ── Coding / Default Path: original flow ───────────────────────
      const clusters = findClusters(allMemories);

      // ── Release embeddings after clustering ──────────────────────
      // Embeddings (1536-dim float arrays, ~12KB each) are only needed
      // for cosine similarity in findClusters(). Strip them now so
      // GC can reclaim before the LLM batch loop.
      for (const message of allMemories) {
        message.embedding = null;
      }

      logger.info(
        `[MemoryConsolidation] Found ${clusters.length} clusters from ${allMemories.length} memories`,
      );

      const staleMemories = allMemories.filter((message) => {
        const age = daysSince(message.createdAt);
        return (
          age > STALENESS_DAYS &&
          (message.type === "project" || message.type === "reference")
        );
      });
      logger.info(
        `[MemoryConsolidation] Found ${staleMemories.length} stale memories (>${STALENESS_DAYS} days, ephemeral types)`,
      );

      if (clusters.length === 0 && staleMemories.length === 0) {
        logger.info(
          "[MemoryConsolidation] No clusters or stale memories — nothing to consolidate",
        );
        await resetRunCount(project || "global");
        return {
          skipped: true,
          reason: "no candidates",
          total: allMemories.length,
        };
      }

      batches = buildBatches(clusters, staleMemories);
      logger.info(
        `[MemoryConsolidation] Split into ${batches.length} batch(es) ` +
          `(${clusters.length} clusters, ${staleMemories.length} stale)`,
      );

      for (let i = 0; i < batches.length; i++) {
        const batchActions = await processBatch(batches[i], i, batches.length, {
          provider,
          consolidationProvider,
          consolidationModel,
          agent: agentId,
          project: project || null,
          username: username || "system",
          trigger: trigger || "manual",
          endpoint,
          traceId,
          agentConversationId,
          broadcast,
        });
        allActions.push(...batchActions);
      }
    }

    if (allActions.length === 0) {
      logger.info(
        "[MemoryConsolidation] LLM found no actions needed across all batches",
      );
      await resetRunCount(project || guildId || "global");
      return {
        actions: 0,
        summary: "No consolidation needed",
        total: allMemories.length,
      };
    }

    // Apply all accumulated actions
    logger.info(
      `[MemoryConsolidation] Applying ${allActions.length} actions from ${batches.length} batch(es)`,
    );
    const results = await applyActions(
      allActions,
      agentId,
      agentType,
      project || null,
      username || "system",
      {
        traceId,
        endpoint,
        memoryLookup: isConversational ? memoryLookup : undefined,
      },
    );
    await resetRunCount(project || guildId || "global");
    const summary = `Merged ${results.merged}, deleted ${results.deleted} (${batches.length} batches)`;
    const durationMs = Math.round(performance.now() - startTime);
    logger.info(`[MemoryConsolidation] Complete: ${summary} (${durationMs}ms)`);

    // Record history for audit trail
    await recordHistory(
      project || guildId || "global",
      trigger || "manual",
      allMemories.length,
      allActions,
      summary,
      durationMs,
    );
    const consolidationResult = {
      ...results,
      actionsApplied: allActions.length,
      batchCount: batches.length,
      summary,
      total: allMemories.length,
      trigger,
      durationMs,
    };
    // Broadcast to connected clients if callback provided
    if (typeof broadcast === "function") {
      try {
        broadcast({
          type: "memory_consolidation_complete",
          project: project || null,
          ...consolidationResult,
        });
      } catch (error: unknown) {
        logger.warn(
          `[MemoryConsolidation] Broadcast failed: ${getErrorMessage(error)}`,
        );
      }
    }
    return consolidationResult;
  },
  /**
   * Check if consolidation should run and trigger if needed.
   * Called by MemoryExtractor after storing new memories.
   */
  async checkAndRun({
    project,
    username,
    broadcast,
    endpoint,
    agent,
    traceId,
    agentConversationId,
  }: CheckAndRunOptions) {
    try {
      await incrementRunCount(project || "global");
      const count = await getRunCount(project || "global");
      if (count >= SESSIONS_BETWEEN_RUNS) {
        logger.info(
          `[MemoryConsolidation] Threshold reached (${count}/${SESSIONS_BETWEEN_RUNS}) — triggering`,
        );
        // Fire-and-forget
        MemoryConsolidationService.consolidate({
          agent: agent || AGENT_IDS.CODING,
          project,
          username,
          trigger: "conversation_threshold",
          broadcast,
          endpoint: endpoint || "/agent",
          traceId: traceId || null,
          agentConversationId: agentConversationId || null,
        }).catch((error: unknown) =>
          logger.error(
            `[MemoryConsolidation] Background consolidation failed: ${getErrorMessage(error)}`,
          ),
        );
      }
    } catch (error: unknown) {
      logger.error(
        `[MemoryConsolidation] checkAndRun failed: ${getErrorMessage(error)}`,
      );
    }
  },
  async getHistory(project: string, limit: number = 10) {
    return getHistory(project, limit);
  },
};
export default MemoryConsolidationService;
