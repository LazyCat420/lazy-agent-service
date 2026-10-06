import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import EmbeddingService from "./EmbeddingService.ts";
import { indexedEmbedding } from "./SemanticEmbedding.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import type { AgenticContext, ConversationMessage } from "./harnesses/types.ts";

// ────────────────────────────────────────────────────────────
// ConversationEmbeddingService
// ────────────────────────────────────────────────────────────
// Generates and persists a summary embedding on agent conversation
// documents to enable cross-session semantic search.
//
// Strategy (lean, zero extra LLM cost):
//   1. Read the conversation title from the document
//   2. Read the most recent memories stored for this conversationId
//   3. Concatenate title + memory contents → embed
//   4. $set { summaryEmbedding, summaryUpdatedAt } on the conversation doc
//
// Guards:
//   - Agent sessions only (not regular chat)
//   - Min 6 messages to avoid trivial conversations
//   - 5-minute cooldown since last summaryUpdatedAt
// ────────────────────────────────────────────────────────────

const MINIMUM_MESSAGES_FOR_EMBEDDING = 6;
const COOLDOWN_MILLISECONDS = 5 * 60 * 1000;

interface AfterResponseOutput {
  messages?: ConversationMessage[];
}

const ConversationEmbeddingService = {
  /**
   * Create an afterResponse hook handler for AgentHooks.
   * Runs as fire-and-forget (inspect category — errors are swallowed).
   */
  createHook() {
    return async (
      context: AgenticContext,
      { messages }: AfterResponseOutput,
    ) => {
      ConversationEmbeddingService.generateAndPersist({
        conversationId: context.conversationId as string | null,
        agentConversationId: context.agentConversationId,
        project: context.project,
        username: context.username,
        agent: context.agent || null,
        traceId: context.traceId || null,
        messageCount: (messages || context.messages || []).length,
        title: (context.messages || []).find(message => message.role === "user" && typeof message.content === "string")?.content?.toString().slice(0, 120),
        endpoint:
          ((context as Record<string, unknown>).endpoint as string | null) ||
          "/agent",
      }).catch((error: unknown) =>
        logger.error(
          `[ConversationEmbeddingService] Background embedding failed: ${getErrorMessage(error)}`,
        ),
      );
    };
  },

  /**
   * Generate a summary embedding for the conversation and persist it.
   * Designed to be called fire-and-forget from the afterResponse hook.
   */
  async generateAndPersist({
    conversationId,
    agentConversationId,
    project,
    username,
    agent,
    traceId,
    messageCount,
    endpoint,
    title,
  }: {
    conversationId: string | null;
    agentConversationId: string;
    project: string;
    username: string;
    agent: string | null;
    traceId: string | null;
    messageCount: number;
    endpoint: string | null;
    title?: string;
  }): Promise<void> {
    if (!conversationId) return;

    // This hook is attached to harness sessions, including arbitrary repo projects.
    if (!project) return;

    // Minimum message threshold
    if (messageCount < MINIMUM_MESSAGES_FOR_EMBEDDING) {
      logger.info(
        `[ConversationEmbeddingService] Skipping — only ${messageCount} messages (min: ${MINIMUM_MESSAGES_FOR_EMBEDDING})`,
      );
      return;
    }

    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return;

    const conversationCollection = database.collection(
      COLLECTIONS.AGENT_CONVERSATIONS,
    );

    // Cooldown check — don't re-embed if we did it recently
    let existingConversation: Record<string, unknown> | null = await conversationCollection.findOne(
      { id: conversationId, project, username },
      { projection: { title: 1, summaryUpdatedAt: 1, compactionSummary: 1 } },
    );

    if (!existingConversation) {
      if (!title) return;
      existingConversation = { title };
    }

    if (existingConversation.summaryUpdatedAt) {
      const lastUpdated = new Date(
        existingConversation.summaryUpdatedAt as string,
      ).getTime();
      const elapsed = Date.now() - lastUpdated;
      if (elapsed < COOLDOWN_MILLISECONDS) {
        logger.info(
          `[ConversationEmbeddingService] Skipping — cooldown active (${Math.round(elapsed / 1000)}s / ${COOLDOWN_MILLISECONDS / 1000}s)`,
        );
        return;
      }
    }

    // Build the text to embed: title + compaction summary (if any) + recent memories
    const textParts: string[] = [];

    const conversationTitle = existingConversation.title as string | undefined;
    if (conversationTitle) {
      textParts.push(conversationTitle);
    }

    // Use compaction summary if available (free — already generated by CompactionService)
    const compactionSummary = existingConversation.compactionSummary as
      | string
      | undefined;
    if (compactionSummary) {
      textParts.push(compactionSummary);
    }

    // Fetch memories linked to this conversation
    const memoryCollection = database.collection(COLLECTIONS.MEMORIES);
    const linkedMemories = await memoryCollection
      .find(
        { conversationId, agent: agent || "CODING" },
        { projection: { title: 1, content: 1 } },
      )
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();

    if (linkedMemories.length > 0) {
      const memoryTextBlocks = linkedMemories
        .map((memory) => {
          const memoryTitle = memory.title as string | undefined;
          const memoryContent = memory.content as string | undefined;
          return memoryTitle
            ? `${memoryTitle}: ${memoryContent}`
            : memoryContent || "";
        })
        .filter(Boolean);
      textParts.push(...memoryTextBlocks);
    }

    // If we have nothing meaningful to embed, skip
    if (textParts.length === 0) {
      logger.info(
        `[ConversationEmbeddingService] Skipping — no title, summary, or memories to embed`,
      );
      return;
    }

    const embeddingSourceText = textParts.join("\n");

    // Truncate to ~2000 chars to keep embedding costs low
    const truncatedText =
      embeddingSourceText.length > 2000
        ? embeddingSourceText.slice(0, 2000)
        : embeddingSourceText;

    // Generate the embedding
    const summaryEmbedding = await EmbeddingService.generate(truncatedText, {
      taskType: "RETRIEVAL_DOCUMENT",
      source: "conversation-summary",
      project,
      endpoint: endpoint || "/agent",
      traceId,
      conversationId,
      agentConversationId: agentConversationId || "",
      agent,
    });

    // Persist on the conversation document
    await conversationCollection.updateOne(
      { id: conversationId, project, username },
      {
        $set: {
          summarySemanticEmbedding: indexedEmbedding(summaryEmbedding),
          summaryUpdatedAt: new Date().toISOString(),
        },
        $setOnInsert: { id: conversationId, project, username, title, agent: agent || "CODING", createdAt: new Date().toISOString() },
      },
      { upsert: true },
    );

    logger.info(
      `[ConversationEmbeddingService] Embedded conversation ${conversationId} ` +
        `(${textParts.length} text parts, ${linkedMemories.length} memories, ` +
        `${truncatedText.length} chars)`,
    );
  },

  /**
   * Persist a compaction summary on the conversation document.
   * Called by the harness when CompactionService produces a summary.
   * This summary is later used as an embedding source — zero extra LLM cost.
   */
  async persistCompactionSummary(
    conversationId: string,
    project: string,
    username: string,
    summaryText: string,
  ): Promise<void> {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return;

    const agentConversation = await database.collection(COLLECTIONS.AGENT_CONVERSATIONS).findOne({ id: conversationId, project, username }, { projection: { id: 1 } });
    const collection = agentConversation || AgentPersonaRegistry.isAgentProject(project)
      ? database.collection(COLLECTIONS.AGENT_CONVERSATIONS)
      : database.collection(COLLECTIONS.MODEL_CONVERSATIONS);

    await collection.updateOne(
      { id: conversationId, project, username },
      {
        $set: {
          compactionSummary: summaryText,
          compactionSummaryUpdatedAt: new Date().toISOString(),
        },
      },
    );

    logger.info(
      `[ConversationEmbeddingService] Persisted compaction summary on ${conversationId} (${summaryText.length} chars)`,
    );
  },
};

export default ConversationEmbeddingService;
