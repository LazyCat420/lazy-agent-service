import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import { getInstancesByType, getInstanceType } from "../providers/instance-registry.ts";
import { resolveModelForInstances } from "../utils/ModelResolution.ts";
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

// ─── Candidate Collection ────────────────────────────────────────────────────

interface CandidateCollection {
  batches: ConsolidationBatch[];
  /** Key used for run-count resets when this path finds nothing to do. */
  resetKey: string;
}

/** Cluster/stale detection plus batching for the conversational agent path. */
function collectConversationalBatches(
  allMemories: MemoryDoc[],
  agentId: string,
): ConsolidationBatch[] {
  const partitions = partitionConversationalMemories(allMemories);
  logger.info(
    `[MemoryConsolidation] Conversational (${agentId}): ${partitions.size} partitions (unique observer→subject pairs)`,
  );

  const batches: ConsolidationBatch[] = [];
  for (const [key, memories] of partitions) {
    if (memories.length < 2) continue;

    // Cluster within this partition using the higher conversational threshold
    const partitionClusters = findClusters(
      memories,
      CONVERSATIONAL_CLUSTER_THRESHOLD,
    );
    const partitionStale = findStaleConversationalMemories(memories);

    // ── Release embeddings after clustering ──────────────────────
    // Versioned embeddings (768-dim float arrays) are only needed
    // for cosine similarity in findClusters(). Strip them now so
    // GC can reclaim before the LLM batch loop.
    for (const message of memories) {
      delete message.semanticEmbedding;
    }

    if (partitionClusters.length === 0 && partitionStale.length === 0) continue;

    // Extract metadata for the partition header
    const sample = memories[0];
    const partitionMeta: PartitionMeta = {
      aboutUserId: sample.aboutUserId || "",
      aboutUsername: sample.aboutUsername || "",
      sourceUserId: sample.sourceUserId || "",
      sourceUsername: sample.sourceUsername || "",
    };

    // Build batches for this partition
    const partitionBatches = buildBatches(partitionClusters, partitionStale);
    for (const batch of partitionBatches) {
      batch.partitionMeta = partitionMeta;
    }
    batches.push(...partitionBatches);

    logger.info(
      `[MemoryConsolidation] Conversational partition ${key}: ${memories.length} memories → ${partitionClusters.length} clusters, ${partitionStale.length} stale`,
    );
  }
  return batches;
}

/** Cluster/stale detection plus batching for the coding/default path. */
function collectDefaultBatches(allMemories: MemoryDoc[]): ConsolidationBatch[] {
  const clusters = findClusters(allMemories);

  // ── Release embeddings after clustering ──────────────────────
  // Versioned embeddings (768-dim float arrays) are only needed
  // for cosine similarity in findClusters(). Strip them now so
  // GC can reclaim before the LLM batch loop.
  for (const message of allMemories) {
    delete message.semanticEmbedding;
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
    return [];
  }

  const batches = buildBatches(clusters, staleMemories);
  logger.info(
    `[MemoryConsolidation] Split into ${batches.length} batch(es) ` +
      `(${clusters.length} clusters, ${staleMemories.length} stale)`,
  );
  return batches;
}

function collectCandidates(
  allMemories: MemoryDoc[],
  agentId: string,
  isConversational: boolean,
  project: string | null,
  guildId: string | undefined,
): CandidateCollection {
  if (isConversational) {
    return {
      batches: collectConversationalBatches(allMemories, agentId),
      resetKey: project || guildId || "global",
    };
  }
  return {
    batches: collectDefaultBatches(allMemories),
    resetKey: project || "global",
  };
}

// ─── Model Resolution & Loading ──────────────────────────────────────────────

/**
 * Resolve the configured consolidation model onto a live instance. Throws when
 * no sibling instance has it loaded — consolidation cannot run anywhere.
 */
async function resolveConsolidationTarget(
  consolidationProvider: string,
  consolidationModel: string,
): Promise<{ providerId: string; model: string }> {
  const baseType =
    getInstanceType(consolidationProvider) || consolidationProvider;
  const siblings = getInstancesByType(baseType);
  const modelRes = await resolveModelForInstances(consolidationModel, siblings);

  if (modelRes.usable.length === 0) {
    throw new Error(
      `[MemoryConsolidation] Model resolution failed: "${consolidationModel}" is not loaded on any instances of provider type "${baseType}".`,
    );
  }

  const providerId = modelRes.usable[0].id;
  const override = modelRes.modelOverrides.get(providerId);
  return { providerId, model: override ?? consolidationModel };
}

/** Load the agent's memories with the embeddings clustering needs. */
async function loadConsolidationMemories(
  db: ReturnType<typeof MongoWrapper.getDb>,
  agentId: string,
  project: string | null,
  isConversational: boolean,
  guildId: string | undefined,
): Promise<MemoryDoc[]> {
  if (!db) throw new Error("Database not available");

  const query: Record<string, unknown> = { agent: agentId };
  if (project) query.project = project;
  if (isConversational && guildId) query.guildId = guildId;

  // LUPOS needs extra fields for attribution-preserving merges.
  const projection = isConversational
    ? {
        semanticEmbedding: 1,
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
    : { semanticEmbedding: 1, id: 1, type: 1, title: 1, content: 1, createdAt: 1 };

  return (await db
    .collection(COLLECTIONS.MEMORIES)
    .find(query)
    .project(projection)
    .toArray()) as MemoryDoc[];
}

// ─── Batch Planning ──────────────────────────────────────────────────────────

interface PlanActionsContext {
  provider: ProcessBatchOptions["provider"];
  consolidationProvider: string;
  consolidationModel: string;
  agent: string;
  project: string | null;
  username: string;
  trigger: string;
  endpoint: string | undefined;
  traceId: string | null | undefined;
  agentConversationId: string | null | undefined;
  broadcast: ConsolidateOptions["broadcast"];
  isConversational: boolean;
}

/** Run every batch through the LLM and flatten the returned actions. */
async function planActions(
  batches: ConsolidationBatch[],
  context: PlanActionsContext,
): Promise<ConsolidationAction[]> {
  const allActions: ConsolidationAction[] = [];
  const conversationalOptions = context.isConversational
    ? {
        systemPrompt: CONVERSATIONAL_CONSOLIDATION_PROMPT,
        inputBuilder: buildConversationalBatchInput,
      }
    : {};

  for (let i = 0; i < batches.length; i++) {
    const batchActions = await processBatch(batches[i], i, batches.length, {
      provider: context.provider,
      consolidationProvider: context.consolidationProvider,
      consolidationModel: context.consolidationModel,
      agent: context.agent,
      project: context.project,
      username: context.username,
      trigger: context.trigger,
      endpoint: context.endpoint,
      traceId: context.traceId,
      agentConversationId: context.agentConversationId,
      broadcast: context.broadcast,
      ...conversationalOptions,
    });
    allActions.push(...batchActions);
  }
  return allActions;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

interface PersistConsolidationParams {
  results: { merged: number; deleted: number; errors: number };
  allActions: ConsolidationAction[];
  batches: ConsolidationBatch[];
  total: number;
  project: string | null;
  guildId: string | undefined;
  trigger: string;
  broadcast: ConsolidateOptions["broadcast"];
  startTime: number;
}

/** Reset the run counter, record history and broadcast the completion. */
async function persistConsolidation({
  results,
  allActions,
  batches,
  total,
  project,
  guildId,
  trigger,
  broadcast,
  startTime,
}: PersistConsolidationParams) {
  await resetRunCount(project || guildId || "global");
  const summary = `Merged ${results.merged}, deleted ${results.deleted} (${batches.length} batches)`;
  const durationMs = Math.round(performance.now() - startTime);
  logger.info(`[MemoryConsolidation] Complete: ${summary} (${durationMs}ms)`);

  // Record history for audit trail
  await recordHistory(
    project || guildId || "global",
    trigger || "manual",
    total,
    allActions,
    summary,
    durationMs,
  );
  const consolidationResult = {
    ...results,
    actionsApplied: allActions.length,
    batchCount: batches.length,
    summary,
    total,
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
}

// ─── Public API ──────────────────────────────────────────────────────────────
/**
 * Normalize consolidation options once: identity defaults, logging context and
 * the scope keys used by the run-count guards.
 */
function prepareConsolidation(options: ConsolidateOptions) {
  const startTime = performance.now();
  const agentId = options.agent || AGENT_IDS.CODING;
  const persona = AgentPersonaRegistry.get(agentId);
  const agentType = persona?.type || "";
  const isConversational = agentType === "conversational";
  logger.info(
    `[MemoryConsolidation] Starting ${agentType || "general"} consolidation for agent "${agentId}", project "${options.project}" (trigger: ${options.trigger})`,
  );
  return {
    startTime,
    agentId,
    agentType,
    isConversational,
    // Scope used by the daily cost guard and run-count resets.
    scopeKey: options.project || options.guildId || "global",
    projectScope: options.project || null,
    usernameOwner: options.username || "system",
    triggerName: options.trigger || "manual",
  };
}

const MemoryConsolidationService = {
  /**
   * Run memory consolidation for a specific agent within a project.
   * Processes memories in batches to avoid context window overflow.
   */
  async consolidate(options: ConsolidateOptions) {
    const {
      startTime,
      agentId,
      agentType,
      isConversational,
      scopeKey,
      projectScope,
      usernameOwner,
      triggerName,
    } = prepareConsolidation(options);

    // Cost guard — check daily budget
    if (!(await canRunToday(scopeKey))) {
      return { skipped: true, reason: "daily_limit_reached", total: 0 };
    }

    const allMemories = await loadConsolidationMemories(
      MongoWrapper.getDb(MONGO_DB_NAME),
      agentId,
      projectScope,
      isConversational,
      options.guildId,
    );

    if (allMemories.length < 2) {
      logger.info(
        `[MemoryConsolidation] Only ${allMemories.length} memories — skipping`,
      );
      await resetRunCount(scopeKey);
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
    const config = await getConsolidationConfig();

    // Guard: consolidation is a chat/generation task. An embedding model only
    // exposes /v1/embeddings, so a generateText call against it 404s. Fail fast
    // with a clear message rather than emitting an opaque "404 Not Found".
    // (VllmModelSyncService should never heal this role onto an embedding model,
    // but a manual misconfiguration must not silently corrupt every run.)
    if (/embed/i.test(config.model)) {
      logger.error(
        `[MemoryConsolidation] Configured consolidation model "${config.model}" is an embedding model — ` +
          `it cannot serve chat completions. Set a generation model in Settings → Memory Models.`,
      );
      return {
        skipped: true,
        reason: "consolidation_model_is_embedding",
        total: allMemories.length,
      };
    }

    const target = await resolveConsolidationTarget(
      config.provider,
      config.model,
    );

    // Build a lookup map for metadata preservation during merges
    const memoryLookup = new Map<string, MemoryDoc>(
      allMemories.map((message) => [message.id, message]),
    );

    const candidates = collectCandidates(
      allMemories,
      agentId,
      isConversational,
      projectScope,
      options.guildId,
    );
    if (candidates.batches.length === 0) {
      if (isConversational) {
        logger.info(
          `[MemoryConsolidation] Conversational (${agentId}): No consolidation candidates across partitions`,
        );
      }
      await resetRunCount(candidates.resetKey);
      return {
        skipped: true,
        reason: "no candidates",
        total: allMemories.length,
      };
    }

    const allActions = await planActions(candidates.batches, {
      provider: getProvider(target.providerId),
      consolidationProvider: target.providerId,
      consolidationModel: target.model,
      agent: agentId,
      project: projectScope,
      username: usernameOwner,
      trigger: triggerName,
      endpoint: options.endpoint,
      traceId: options.traceId,
      agentConversationId: options.agentConversationId,
      broadcast: options.broadcast,
      isConversational,
    });

    if (allActions.length === 0) {
      logger.info(
        "[MemoryConsolidation] LLM found no actions needed across all batches",
      );
      await resetRunCount(scopeKey);
      return {
        actions: 0,
        summary: "No consolidation needed",
        total: allMemories.length,
      };
    }

    // Apply all accumulated actions
    logger.info(
      `[MemoryConsolidation] Applying ${allActions.length} actions from ${candidates.batches.length} batch(es)`,
    );
    const results = await applyActions(
      allActions,
      agentId,
      agentType,
      projectScope,
      usernameOwner,
      {
        traceId: options.traceId,
        endpoint: options.endpoint,
        memoryLookup: isConversational ? memoryLookup : undefined,
      },
    );

    return persistConsolidation({
      results,
      allActions,
      batches: candidates.batches,
      total: allMemories.length,
      project: projectScope,
      guildId: options.guildId,
      trigger: options.trigger,
      broadcast: options.broadcast,
      startTime,
    });
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
