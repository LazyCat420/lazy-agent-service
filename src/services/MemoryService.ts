import {
  AGENT_IDS,
  DEFAULT_PROJECT,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import crypto from "crypto";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { getProvider } from "../providers/index.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import EmbeddingService from "./EmbeddingService.ts";
import PromptLocaleService from "./PromptLocaleService.ts";
import RequestLogger from "./RequestLogger.ts";
import logger from "../utils/logger.ts";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import { parseJsonFromLargeLanguageModelResponse } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS } from "../constants.ts";
import SettingsService from "./SettingsService.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
// ─── Constants ────────────────────────────────────────────────────────────────
/** Single unified collection for all agent memories. */
const COLLECTION = COLLECTIONS.MEMORIES;
/** Resolve the current extraction provider + model from settings. */
async function getExtractionConfig() {
  return SettingsService.getMemoryModelConfig("extraction");
}
/**
 * Duplicate detection threshold — two memories with cosine similarity above
 * this are considered duplicates and the newer one is skipped.
 */
const DUPLICATE_THRESHOLD = 0.92;
const RELEVANCE_THRESHOLD = 0.3;
/**
 * Valid memory types — inspired by Claude Code's memdir taxonomy.
 *
 * Memories are constrained to these types. LUPOS additionally uses its own
 * category values (personal, preference, gaming, etc.) stored in the `type`
 * field — the schema is flexible per agent.
 */
export const CODING_MEMORY_TYPES = ["user", "feedback", "project", "reference"];
// ─── Types ────────────────────────────────────────────────────────────────────
export interface MemoryStoreParams {
  agent: string;
  project?: string | null;
  username?: string | null;
  type?: string;
  title?: string | null;
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  conversationId?: string | null;
  traceId?: string;
  agentConversationId?: string;
  endpoint?: string;
}

export interface MemoryExtractAndStoreParams {
  guildId?: string;
  channelId?: string;
  messages: Record<string, unknown>[];
  participants: Record<string, unknown>[];
  sourceMessageId?: string;
  traceId?: string;
  project?: string;
  endpoint?: string;
}
export interface MemorySearchParams {
  agent: string;
  project?: string | null;
  guildId?: string;
  userIds?: string[];
  queryText: string;
  limit?: number;
  conversationId?: string;
  traceId?: string;
  agentConversationId?: string;
  endpoint?: string;
  username?: string;
}

export interface MemoryListParams {
  agent?: string;
  project?: string | null;
  guildId?: string;
  userId?: string;
  limit?: number;
  skip?: number;
  type?: string;
}

export interface MemoryUpdateParams {
  title?: string;
  content?: string;
  type?: string;
}

export interface EmbedOptions {
  source?: string;
  project?: string | null;
  conversationId?: string;
  traceId?: string;
  agentConversationId?: string;
  endpoint?: string;
  agent?: string;
  username?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function generateEmbedding(text: string, options: EmbedOptions = {}) {
  return EmbeddingService.embed(text, { source: "memory", ...options });
}
function memoryAgeDays(createdAt: string) {
  return daysSinceIso(createdAt);
}
/**
 * Human-readable age string. Models are poor at date arithmetic —
 * "47 days ago" triggers staleness reasoning better than a raw ISO timestamp.
 */
function memoryAge(createdAt: string) {
  const ageDays = memoryAgeDays(createdAt);
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "yesterday";
  return `${ageDays} days ago`;
}
/**
 * Staleness caveat for memories >1 day old.
 * Returns empty string for fresh memories.
 */
function freshnessCaveat(createdAt: string) {
  const ageDays = memoryAgeDays(createdAt);
  if (ageDays <= 1) return "";
  return ` ⚠️ ${ageDays} days old — verify against current code before acting on this.`;
}
interface ExtractedFact {
  fact: string;
  aboutUserId: string;
  aboutUsername: string;
  sourceUserId?: string;
  sourceUsername?: string;
  category?: string;
  confidence?: number;
}

// ─── LUPOS Fact Extraction ────────────────────────────────────────────────────
/**
 * Call an AI provider to extract facts from a conversation.
 * Returns an array of { fact, aboutUserId, aboutUsername, category, confidence }.
 */
async function extractFactsFromConversation(
  messages: Record<string, unknown>[],
  participants: Record<string, unknown>[],
  meta: Record<string, unknown> = {},
): Promise<ExtractedFact[]> {
  const endpoint = meta.endpoint || null;
  const agent = meta.agent || null;
  const { provider: extractionProvider, model: extractionModel } =
    await getExtractionConfig();
  const provider = getProvider(extractionProvider);
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
  const participantList = participants
    .map(
      (participant: Record<string, unknown>) =>
        `- ID: ${participant.id}, Username: ${participant.username}, Display: ${participant.displayName || participant.username}`,
    )
    .join("\n");
  const conversationText = messages
    .map(
      (message: Record<string, unknown>) =>
        `${message.name || message.role}: ${message.content}`,
    )
    .join("\n");
  const systemPrompt = PromptLocaleService.get("en", "memory.discordExtractionPrompt", { participantList });
  const aiMessages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: PromptLocaleService.get("en", "memory.discordExtractInstruction", { conversationText }),
    },
  ];
  let result: { text: string; usage?: Record<string, unknown> } | undefined;
  let success = true;
  let errorMessage = null;
  try {
    result = await provider.generateText(aiMessages, extractionModel, {
      maxTokens: 1000,
      temperature: 0.1,
      thinkingEnabled: false,
    });
  } catch (error: unknown) {
    success = false;
    errorMessage = getErrorMessage(error);
    throw error;
  } finally {
    RequestLogger.logBackgroundLlmCall({
      requestId,
      endpoint: endpoint as string | null,
      operation: "memory:extract",
      project: (meta.project as string) || null,
      username: (meta.username as string) || "system",
      agent: agent as string | null,
      provider: extractionProvider,
      model: extractionModel,
      traceId: (meta.traceId as string) || null,
      agentConversationId: (meta.agentConversationId as string) || null,
      aiMessages,
      resultText: result?.text || "",
      usage: result?.usage || null,
      success,
      errorMessage,
      requestStartMs: requestStart,
      extraRequestPayload: {
        participantCount: participants.length,
        messageCount: messages.length,
      },
    });
  }
  const facts = parseJsonFromLargeLanguageModelResponse(result?.text);
  if (!Array.isArray(facts)) return [];
  // Validate each fact has the required fields
  return (facts as Record<string, unknown>[]).filter(
    (fact: Record<string, unknown>) =>
      fact.fact &&
      fact.aboutUserId &&
      fact.aboutUsername &&
      typeof fact.confidence === "number" &&
      fact.confidence >= 0.5,
  ) as unknown as ExtractedFact[];
}
// ─── Unified Memory Service ──────────────────────────────────────────────────
/**
 * MemoryService — unified, agent-scoped memory system.
 *
 * All memories live in a single `memories` collection. Every document carries
 * an `agent` field ("LUPOS", "CODING", etc.) and all queries filter by it,
 * ensuring complete isolation between agents.
 *
 * LUPOS memories: personal facts about Discord users (guild-scoped)
 * CODING memories: project knowledge from coding sessions (project-scoped)
 */
const MemoryService = {
  // ── Store ──────────────────────────────────────────────────────────────────
  async store({
    agent,
    project,
    username,
    type,
    title,
    content,
    embedding,
    metadata = {},
    conversationId,
    traceId,
    agentConversationId,
    endpoint,
  }: MemoryStoreParams) {
    if (!agent)
      throw new Error("MemoryService.store requires an agent identifier");
    if (!content) throw new Error("MemoryService.store requires content");
    // Validate type for CODING agent
    if (agent === AGENT_IDS.CODING) {
      type = CODING_MEMORY_TYPES.includes(type as string) ? type : "project";
    }
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const embedText = title ? `${title}: ${content}` : content;
    // Generate embedding if not provided
    if (!embedding) {
      const embedOpts: EmbedOptions = { project };
      if (conversationId) embedOpts.conversationId = conversationId;
      if (traceId) embedOpts.traceId = traceId;
      if (agentConversationId) embedOpts.agentConversationId = agentConversationId;
      if (endpoint) embedOpts.endpoint = endpoint;
      if (agent) embedOpts.agent = agent;
      if (username) embedOpts.username = username;
      embedding = await generateEmbedding(embedText, embedOpts);
    }
    // Duplicate detection — compare against existing memories for the same agent
    const dedupFilter: Record<string, unknown> = { agent };
    if (project) dedupFilter.project = project;
    if (metadata.guildId) dedupFilter.guildId = metadata.guildId;
    if (metadata.aboutUserId) dedupFilter.aboutUserId = metadata.aboutUserId;
    const existing = await collection
      .find(dedupFilter)
      .project({ embedding: 1 })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    const isDuplicate = existing.some((document: Record<string, unknown>) => {
      if (!document.embedding) return false;
      return (
        cosineSimilarity(
          embedding as number[],
          document.embedding as number[],
        ) > DUPLICATE_THRESHOLD
      );
    });
    if (isDuplicate) {
      logger.info(
        `[MemoryService] Skipping duplicate for ${agent}: "${(title || content).substring(0, 60)}"`,
      );
      return null;
    }
    const now = new Date().toISOString();
    const memory = {
      // Spread agent-specific metadata first — core fields below take precedence
      // to prevent accidental overwrites of id, agent, embedding, etc.
      ...metadata,
      id: crypto.randomUUID(),
      agent,
      project: project || null,
      username: username || null,
      type: type || "other",
      title: title || null,
      content,
      embedding,
      conversationId: conversationId || null,
      agentConversationId: agentConversationId || null,
      createdAt: now,
      updatedAt: now,
    };
    await collection.insertOne(memory);
    logger.info(
      `[MemoryService] Stored [${agent}/${memory.type}] "${(title || content).substring(0, 60)}"`,
    );
    return memory;
  },
  // ── LUPOS: Extract & Store ─────────────────────────────────────────────────
  async extractAndStore({
    guildId,
    channelId,
    messages,
    participants,
    sourceMessageId,
    traceId,
    project,
    endpoint,
  }: MemoryExtractAndStoreParams) {
    // Extract facts from the conversation via AI
    const facts = await extractFactsFromConversation(messages, participants, {
      project,
      traceId,
      endpoint,
      agent: AGENT_IDS.LUPOS,
    });
    if (facts.length === 0) {
      logger.info(
        "[MemoryService] No personal facts extracted from conversation.",
      );
      return [];
    }
    logger.info(
      `[MemoryService] Extracted ${facts.length} fact(s), generating embeddings...`,
    );
    const storedMemories: Record<string, unknown>[] = [];
    for (const fact of facts) {
      try {
        const embedding = await generateEmbedding(fact.fact, {
          project,
          traceId,
          endpoint,
          agent: AGENT_IDS.LUPOS,
        });
        const memory = await this.store({
          agent: AGENT_IDS.LUPOS,
          project: project || null,
          username: fact.sourceUsername || null,
          type: fact.category || "other",
          title: null,
          content: fact.fact,
          embedding,
          metadata: {
            guildId,
            channelId,
            aboutUserId: fact.aboutUserId,
            aboutUsername: fact.aboutUsername,
            sourceUserId: fact.sourceUserId,
            sourceUsername: fact.sourceUsername,
            confidence: fact.confidence,
            sourceMessageId: sourceMessageId || null,
          },
        });
        if (memory) {
          storedMemories.push(memory);
          logger.info(
            `[MemoryService] Stored: "${fact.fact.substring(0, 60)}..." (about: ${fact.aboutUsername})`,
          );
        }
      } catch (error: unknown) {
        logger.error(
          `[MemoryService] Failed to store fact: ${getErrorMessage(error)}`,
        );
      }
    }
    return storedMemories;
  },
  // ── Search ─────────────────────────────────────────────────────────────────
  /**
   * Search for relevant memories using cosine similarity.
   * Always scoped by `agent`.
   */
  async search({
    agent,
    project,
    guildId,
    userIds,
    queryText,
    limit = 10,
    conversationId,
    traceId,
    agentConversationId,
    endpoint,
    username,
  }: MemorySearchParams) {
    if (!agent)
      throw new Error("MemoryService.search requires an agent identifier");
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    // Generate embedding for the search query
    const embeddingOpts: EmbedOptions = {};
    if (conversationId) embeddingOpts.conversationId = conversationId;
    if (traceId) embeddingOpts.traceId = traceId;
    if (agentConversationId) embeddingOpts.agentConversationId = agentConversationId;
    if (project) embeddingOpts.project = project;
    if (endpoint) embeddingOpts.endpoint = endpoint;
    if (agent) embeddingOpts.agent = agent;
    if (username) embeddingOpts.username = username;
    const queryEmbedding = await generateEmbedding(queryText, embeddingOpts);
    // Build the filter — always scoped by agent
    const filter: Record<string, unknown> = { agent };
    if (project) filter.project = project;
    if (guildId) filter.guildId = guildId;
    if (userIds && userIds.length > 0) {
      filter.aboutUserId = { $in: userIds };
    }
    // Fetch all memories matching the filter
    const memories = await collection
      .find(filter, {
        projection: {
          embedding: 1,
          type: 1,
          title: 1,
          content: 1,
          aboutUserId: 1,
          aboutUsername: 1,
          confidence: 1,
          createdAt: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();
    if (memories.length === 0) return [];
    // Compute cosine similarity and sort
    const scored = memories
      .filter(
        (memory: Record<string, unknown>) =>
          memory.embedding && (memory.embedding as number[]).length > 0,
      )
      .map((memory: Record<string, unknown>) => ({
        id: memory._id,
        type: memory.type || "other",
        title:
          memory.title ||
          (memory.content
            ? (memory.content as string).substring(0, 60)
            : "untitled"),
        content: memory.content || "",
        aboutUserId: memory.aboutUserId,
        aboutUsername: memory.aboutUsername,
        confidence: memory.confidence,
        createdAt: memory.createdAt,
        age: memoryAge(memory.createdAt as string),
        ageDays: memoryAgeDays(memory.createdAt as string),
        score: cosineSimilarity(
          queryEmbedding as number[],
          memory.embedding as number[],
        ),
      }))
      .filter((message) => message.score > RELEVANCE_THRESHOLD)
      .sort((firstItem, secondItem) => secondItem.score - firstItem.score)
      .slice(0, limit);
    logger.info(
      `[MemoryService] Search found ${scored.length} relevant memories for ${agent} (from ${memories.length} total)`,
    );
    return scored;
  },
  // ── List ────────────────────────────────────────────────────────────────────
  async list({
    agent,
    project,
    guildId,
    userId,
    limit = 50,
    skip = 0,
    type,
  }: MemoryListParams) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const filter: Record<string, unknown> = {};
    if (agent) filter.agent = agent;
    if (project) filter.project = project;
    if (guildId) filter.guildId = guildId;
    if (userId) filter.aboutUserId = userId;
    if (type) filter.type = type;
    const [memories, total] = await Promise.all([
      collection
        .find(filter, { projection: { embedding: 0 } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return { memories, total };
  },
  // ── Discover ───────────────────────────────────────────────────────────────
  /**
   * Aggregate all distinct project/agent combinations with memory counts.
   * Bypasses project scoping — used by the consolidation CLI's --all sweep.
   */
  async discoverCombos() {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    return collection
      .aggregate([
        {
          $group: {
            _id: { project: "$project", agent: "$agent" },
            count: { $sum: 1 },
          },
        },
        {
          $project: {
            _id: 0,
            project: { $ifNull: ["$_id.project", DEFAULT_PROJECT] },
            agent: { $ifNull: ["$_id.agent", AGENT_IDS.CODING] },
            count: 1,
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();
  },
  // ── Delete / Remove ────────────────────────────────────────────────────────
  async delete(memoryId: string) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const result = await collection.deleteOne({ id: memoryId });
    return result.deletedCount > 0;
  },
  async remove(memoryId: string) {
    return this.delete(memoryId);
  },
  // ── Update ─────────────────────────────────────────────────────────────────
  async update(memoryId: string, { title, content, type }: MemoryUpdateParams) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTION);
    const $set: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (title !== undefined) $set.title = title;
    if (content !== undefined) $set.content = content;
    if (type !== undefined) $set.type = type;
    // Re-generate embedding if content changed
    if (content !== undefined) {
      const document = await collection.findOne(
        { id: memoryId },
        { projection: { project: 1, title: 1 } },
      );
      const embedText =
        title || document?.title
          ? `${title || document?.title}: ${content}`
          : content;
      $set.embedding = await generateEmbedding(embedText, {
        project: document?.project,
      });
    }
    const result = await collection.updateOne({ id: memoryId }, { $set });
    return result.modifiedCount > 0;
  },
  // ── Format ─────────────────────────────────────────────────────────────────
  /**
   * Format memories for injection into the system prompt.
   * Adds type badges and staleness caveats.
   */
  formatForPrompt(memories: Record<string, unknown>[]) {
    if (!memories || memories.length === 0) return "";
    return memories
      .map((memory: Record<string, unknown>) => {
        const badge = `[${memory.type}]`;
        const age = memory.age !== "today" ? ` (${memory.age})` : "";
        const caveat = freshnessCaveat(memory.createdAt as string);
        return `- ${badge} **${memory.title}**${age}: ${memory.content}${caveat}`;
      })
      .join("\n");
  },
  // ── Indexes ────────────────────────────────────────────────────────────────
  async ensureIndexes() {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) return;
    const collection = db.collection(COLLECTION);
    // Primary lookup: by agent + project (covers CODING queries)
    await collection.createIndex({ agent: 1, project: 1 });
    // LUPOS queries: agent + guild + user
    await collection.createIndex({ agent: 1, guildId: 1, aboutUserId: 1 });
    // Type-filtered queries
    await collection.createIndex({ agent: 1, project: 1, type: 1 });
    // Conversation backlinks: memory → conversation provenance lookup
    await collection.createIndex({ agent: 1, conversationId: 1 });
    // Unique ID
    await collection.createIndex({ id: 1 }, { unique: true });
    // Chronological listing
    await collection.createIndex({ createdAt: -1 });
    logger.info(
      "[MemoryService] Indexes ensured on unified memories collection.",
    );
  },
};
export default MemoryService;
