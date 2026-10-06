import MemoryService from "../MemoryService.ts";
import EmbeddingService from "../EmbeddingService.ts";
import { compatibleVector } from "../SemanticEmbedding.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../../config.ts";
import { COLLECTIONS } from "../../constants.ts";
import logger from "../../utils/logger.ts";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import { MemoryFetchOptions, SkillFetchOptions, ScoredSkill } from "./types.ts";

const SKILL_RELEVANCE_THRESHOLD = 0.3;

export class SkillMemoryScorer {
  /**
   * Fetch relevant memories via embedding similarity search.
   * Queries the unified `memories` collection using cosine similarity,
   * scoped by agent and project.
   */
  async fetchMemories(
    agent: string,
    project: string | null,
    queryText: string,
    {
      traceId,
      agentConversationId,
      conversationId,
      endpoint,
      _username,
      guildId,
      userIds,
    }: MemoryFetchOptions = {},
  ): Promise<string> {
    try {
      const memories = await MemoryService.search({
        agent,
        project,
        queryText,
        limit: 10,
        conversationId: conversationId || undefined,
        traceId: traceId || undefined,
        agentConversationId: agentConversationId || undefined,
        endpoint: endpoint || "/agent",
        username: _username || undefined,
        guildId: guildId || undefined,
        userIds: userIds || undefined,
      });

      if (!memories || memories.length === 0) return "";

      logger.info(
        `[SystemPromptAssembler] Memory search returned ${memories.length} results for ${agent}`,
      );
      return MemoryService.formatForPrompt(memories);
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Memory fetch error: ${getErrorMessage(error)}`,
      );
      return "";
    }
  }

  async fetchSkills(
    project: string | null,
    username: string,
    queryText: string,
    { traceId, agentConversationId, endpoint, agent }: SkillFetchOptions = {},
  ): Promise<ScoredSkill[]> {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) return [];

      const skills = await db
        .collection(COLLECTIONS.AGENT_SKILLS)
        .find({ project, username, enabled: true })
        .project({ name: 1, content: 1, description: 1, semanticEmbedding: 1 })
        .toArray();

      if (skills.length === 0) return [];

      // If no query or no skills have embeddings, return all (graceful fallback)
      const hasEmbeddings = skills.some(
        (skill) => !!skill.semanticEmbedding,
      );
      if (!queryText || !hasEmbeddings) {
        logger.info(
          `[SystemPromptAssembler] Returning all ${skills.length} skills (no query or no embeddings)`,
        );
        return skills.map((skill) => ({
          name: skill.name as string,
          content: skill.content as string,
          description: skill.description as string,
          score: 1,
        }));
      }

      // Generate query embedding
      let queryEmbedding: Awaited<ReturnType<typeof EmbeddingService.generate>>;
      try {
        queryEmbedding = await EmbeddingService.generate(queryText, {
          taskType: "RETRIEVAL_QUERY",
          source: "skill-relevance",
          project,
          endpoint: endpoint || "/agent",
          traceId: traceId || null,
          agentConversationId: agentConversationId || null,
          agent: agent || null,
        });
      } catch (error: unknown) {
        logger.warn(
          `[SystemPromptAssembler] Query embedding failed: ${getErrorMessage(error)} — returning all skills`,
        );
        return skills.map((skill) => ({
          name: skill.name as string,
          content: skill.content as string,
          description: skill.description as string,
          score: 1,
        }));
      }

      // Score and filter by relevance threshold
      const scored: ScoredSkill[] = skills
        .map((skill) => ({
          name: skill.name as string,
          content: skill.content as string,
          description: skill.description as string,
          score: compatibleVector(skill.semanticEmbedding, queryEmbedding.space)
            ? cosineSimilarity(queryEmbedding.embedding, compatibleVector(skill.semanticEmbedding, queryEmbedding.space)!)
            : 1, // Untagged/legacy skills remain available without false semantic ranking.
        }))
        .filter((skill) => skill.score >= SKILL_RELEVANCE_THRESHOLD)
        .sort((firstItem, b) => b.score - firstItem.score);

      logger.info(
        `[SystemPromptAssembler] Skills: ${scored.length}/${skills.length} above threshold (${scored.map((skill) => `${skill.name}:${skill.score.toFixed(2)}`).join(", ")})`,
      );

      return scored;
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Skills fetch error: ${getErrorMessage(error)}`,
      );
      return [];
    }
  }
}
