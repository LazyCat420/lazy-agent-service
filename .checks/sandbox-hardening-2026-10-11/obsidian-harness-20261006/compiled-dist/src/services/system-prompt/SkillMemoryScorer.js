import MemoryService from "../MemoryService.js";
import EmbeddingService from "../EmbeddingService.js";
import MongoWrapper from "../../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../../config.js";
import { COLLECTIONS } from "../../constants.js";
import logger from "../../utils/logger.js";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import { getErrorMessage } from "../../utils/ErrorHelpers.js";
const SKILL_RELEVANCE_THRESHOLD = 0.3;
export class SkillMemoryScorer {
    /**
     * Fetch relevant memories via embedding similarity search.
     * Queries the unified `memories` collection using cosine similarity,
     * scoped by agent and project.
     */
    async fetchMemories(agent, project, queryText, { traceId, agentConversationId, conversationId, endpoint, _username, guildId, userIds, } = {}) {
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
            if (!memories || memories.length === 0)
                return "";
            logger.info(`[SystemPromptAssembler] Memory search returned ${memories.length} results for ${agent}`);
            return MemoryService.formatForPrompt(memories);
        }
        catch (error) {
            logger.warn(`[SystemPromptAssembler] Memory fetch error: ${getErrorMessage(error)}`);
            return "";
        }
    }
    async fetchSkills(project, username, queryText, { traceId, agentConversationId, endpoint, agent } = {}) {
        try {
            const db = MongoWrapper.getDb(MONGO_DB_NAME);
            if (!db)
                return [];
            const skills = await db
                .collection(COLLECTIONS.AGENT_SKILLS)
                .find({ project, username, enabled: true })
                .project({ name: 1, content: 1, description: 1, embedding: 1 })
                .toArray();
            if (skills.length === 0)
                return [];
            // If no query or no skills have embeddings, return all (graceful fallback)
            const hasEmbeddings = skills.some((skill) => Array.isArray(skill.embedding) && skill.embedding.length > 0);
            if (!queryText || !hasEmbeddings) {
                logger.info(`[SystemPromptAssembler] Returning all ${skills.length} skills (no query or no embeddings)`);
                return skills.map((skill) => ({
                    name: skill.name,
                    content: skill.content,
                    description: skill.description,
                    score: 1,
                }));
            }
            // Generate query embedding
            let queryEmbedding;
            try {
                queryEmbedding = await EmbeddingService.embed(queryText, {
                    source: "skill-relevance",
                    project,
                    endpoint: endpoint || "/agent",
                    traceId: traceId || null,
                    agentConversationId: agentConversationId || null,
                    agent: agent || null,
                });
            }
            catch (error) {
                logger.warn(`[SystemPromptAssembler] Query embedding failed: ${getErrorMessage(error)} — returning all skills`);
                return skills.map((skill) => ({
                    name: skill.name,
                    content: skill.content,
                    description: skill.description,
                    score: 1,
                }));
            }
            // Score and filter by relevance threshold
            const scored = skills
                .map((skill) => ({
                name: skill.name,
                content: skill.content,
                description: skill.description,
                score: skill.embedding
                    ? cosineSimilarity(queryEmbedding, skill.embedding)
                    : 0,
            }))
                .filter((skill) => skill.score >= SKILL_RELEVANCE_THRESHOLD)
                .sort((firstItem, b) => b.score - firstItem.score);
            logger.info(`[SystemPromptAssembler] Skills: ${scored.length}/${skills.length} above threshold (${scored.map((skill) => `${skill.name}:${skill.score.toFixed(2)}`).join(", ")})`);
            return scored;
        }
        catch (error) {
            logger.warn(`[SystemPromptAssembler] Skills fetch error: ${getErrorMessage(error)}`);
            return [];
        }
    }
}
//# sourceMappingURL=SkillMemoryScorer.js.map