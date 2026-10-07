import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
import { COLLECTIONS } from "../constants.js";
import { MAX_TOOL_ITERATIONS } from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../utils/logger.js";
// ────────────────────────────────────────────────────────────
// SkillService — Reusable Workflow Templates
// ────────────────────────────────────────────────────────────
// Skills are stored multi-step workflow templates that the
// agent can invoke by name. Each skill defines:
//   - A prompt template (with {{variable}} interpolation)
//   - A list of steps (optional — for documentation)
//   - Execution parameters (model, tools, max iterations)
//
// Skills live in the `agent_skills` MongoDB collection and
// are executed by spawning an AgenticLoopService run with
// the skill's prompt + configuration.
//
// This is the SkillTool pattern from Claude Code — reusable
// agentic workflows stored as atomic operations.
// ────────────────────────────────────────────────────────────
/** @returns {import("mongodb").Collection} */
function getCollection() {
    return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_SKILLS);
}
const SkillService = {
    /**
     * Create a new skill.
     */
    async create(data) {
        const collection = getCollection();
        if (!collection)
            throw new Error("Database not available");
        const { name, description, prompt, steps, tools, maxIterations, model, project, agent, } = data;
        if (!name || typeof name !== "string") {
            return { error: "'name' is required (string)" };
        }
        if (!prompt || typeof prompt !== "string") {
            return { error: "'prompt' is required (string)" };
        }
        // Derive a stable skill ID
        const skillId = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "");
        // Check for duplicate
        const existing = await collection.findOne({ skillId });
        if (existing) {
            return {
                error: `Skill "${skillId}" already exists. Delete it first or use a different name.`,
            };
        }
        const document = {
            skillId,
            name,
            description: description || "",
            prompt,
            steps: Array.isArray(steps) ? steps : [],
            tools: Array.isArray(tools) ? tools : null, // null = all tools
            maxIterations: typeof maxIterations === "number"
                ? Math.min(100, Math.max(1, maxIterations))
                : MAX_TOOL_ITERATIONS,
            model: model || null,
            project: project || null,
            agent: agent || null,
            usageCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };
        await collection.insertOne(document);
        logger.info(`[SkillService] Created skill "${name}" (${skillId})`);
        return {
            skill: sanitize(document),
            message: `Skill "${name}" created. Execute with execute_skill({ skillId: "${skillId}" }).`,
        };
    },
    /**
     * List all skills.
  
  
     */
    async list({ project, limit = 50 } = {}) {
        const collection = getCollection();
        if (!collection)
            return { skills: [], total: 0 };
        const filter = {};
        if (project)
            filter.project = project;
        const skills = await collection
            .find(filter)
            .sort({ usageCount: -1, name: 1 })
            .limit(Math.min(limit, 100))
            .toArray();
        return {
            skills: skills.map(sanitize),
            total: skills.length,
        };
    },
    /**
     * Get a single skill by skillId.
  
  
     */
    async get(skillId) {
        const collection = getCollection();
        if (!collection)
            return null;
        const document = await collection.findOne({ skillId });
        return document ? sanitize(document) : null;
    },
    /**
     * Delete a skill by skillId.
     */
    async delete(skillId) {
        const collection = getCollection();
        if (!collection)
            return { error: "Database not available" };
        const document = await collection.findOne({ skillId });
        if (!document) {
            return { error: `Skill "${skillId}" not found` };
        }
        await collection.deleteOne({ skillId });
        logger.info(`[SkillService] Deleted skill "${document.name}" (${skillId})`);
        return { deleted: true, skillId, name: document.name };
    },
    /**
     * Execute a skill — interpolates variables, increments usage, and
     * returns the assembled prompt + config for the agentic loop.
     *
     * The caller (ToolOrchestratorService) is responsible for actually
     * running the agentic loop with the returned config.
     */
    async prepare(skillId, variables = {}) {
        const collection = getCollection();
        if (!collection)
            return { error: "Database not available" };
        const document = await collection.findOne({ skillId });
        if (!document) {
            return {
                error: `Skill "${skillId}" not found. Use list_skills to see available skills.`,
            };
        }
        // Interpolate variables into the prompt template
        let prompt = document.prompt;
        for (const [key, value] of Object.entries(variables)) {
            prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
        }
        // Warn about unresolved variables
        const unresolvedMatch = prompt.match(/\{\{(\w+)\}\}/g);
        const unresolved = unresolvedMatch
            ? [
                ...new Set(unresolvedMatch.map((message) => message.slice(2, -2))),
            ]
            : [];
        // Increment usage counter
        await collection.updateOne({ skillId }, {
            $inc: { usageCount: 1 },
            $set: { updatedAt: new Date().toISOString() },
        });
        const config = {
            maxIterations: document.maxIterations || MAX_TOOL_ITERATIONS,
            model: document.model || null,
            tools: document.tools || null, // null = all tools
            agent: document.agent || null,
            project: document.project || null,
        };
        return {
            skillId,
            name: document.name,
            prompt,
            config,
            unresolved: unresolved.length > 0 ? unresolved : undefined,
            steps: document.steps?.length > 0 ? document.steps : undefined,
        };
    },
};
function sanitize(document) {
    if (!document)
        return null;
    const { _id, ...rest } = document;
    return rest;
}
export default SkillService;
//# sourceMappingURL=SkillService.js.map