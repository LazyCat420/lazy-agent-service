import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.js";
import EmbeddingService from "../services/EmbeddingService.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";
import { PostSkillSchema, PutSkillSchema } from "../types/index.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = express.Router();
router.use(requireDb);
const COLLECTION = COLLECTIONS.AGENT_SKILLS;
/**
 * Generate an embedding vector for skill content.
 * Combines name + description + content for richer semantic representation.
 */
async function generateSkillEmbedding(skill) {
    const text = [skill.name, skill.description, skill.content]
        .filter(Boolean)
        .join("\n");
    return EmbeddingService.embed(text, {
        source: "skill-creation",
        endpoint: "/skills",
    });
}
/**
 * GET /skills
 * List all skills for the given project + username.
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const project = req.project || "any";
        const username = req.username || "any";
        const { db } = req;
        const skills = await db
            .collection(COLLECTION)
            .find({ project, username })
            .sort({ createdAt: -1 })
            // Don't return embedding vectors to the client — they're large
            .project({ embedding: 0 })
            .toArray();
        res.json(skills.map((skill) => ({
            ...skill,
            id: skill._id ? skill._id.toString() : "",
        })));
    }
    catch (error) {
        next(error);
    }
}));
/**
 * POST /skills
 * Create a new skill. Generates an embedding vector at creation time.
 */
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const project = req.project || "any";
        const username = req.username || "any";
        const { db } = req;
        const validated = PostSkillSchema.parse(req.body);
        const document = {
            project,
            username,
            name: validated.name,
            description: validated.description,
            content: validated.content,
            enabled: validated.enabled,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        // Generate embedding for semantic similarity search
        try {
            document.embedding = await generateSkillEmbedding(document);
        }
        catch (error) {
            logger.warn(`[Skills] Embedding generation failed: ${getErrorMessage(error)}`);
            document.embedding = null;
        }
        const result = await db
            .collection(COLLECTION)
            .insertOne(document);
        logger.info(`Skill created: ${document.name} (${result.insertedId})`);
        const { embedding: _, ...response } = document;
        res.status(201).json({ ...response, id: result.insertedId.toString() });
    }
    catch (error) {
        next(error);
    }
}));
/**
 * PUT /skills/:id
 * Update an existing skill. Re-generates embedding if content changes.
 */
router.put("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const validated = PutSkillSchema.parse(req.body);
        const updates = {
            ...(validated.name !== undefined && { name: validated.name }),
            ...(validated.description !== undefined && {
                description: validated.description,
            }),
            ...(validated.content !== undefined && { content: validated.content }),
            ...(validated.enabled !== undefined && { enabled: validated.enabled }),
            updatedAt: new Date(),
        };
        // Re-generate embedding if any semantic content changed
        const contentChanged = validated.name !== undefined ||
            validated.description !== undefined ||
            validated.content !== undefined;
        if (contentChanged) {
            try {
                // Need current doc to merge fields for embedding
                const current = await db
                    .collection(COLLECTION)
                    .findOne({ _id: new ObjectId(req.params.id) });
                if (current) {
                    const merged = {
                        name: updates.name ?? current.name,
                        description: updates.description ?? current.description,
                        content: updates.content ?? current.content,
                    };
                    updates.embedding = await generateSkillEmbedding(merged);
                }
            }
            catch (error) {
                logger.warn(`[Skills] Embedding re-generation failed: ${getErrorMessage(error)}`);
            }
        }
        const result = await db
            .collection(COLLECTION)
            .findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: updates }, { returnDocument: "after", projection: { embedding: 0 } });
        if (!result) {
            return res.status(404).json({ error: "Skill not found" });
        }
        logger.info(`Skill updated: ${result.name} (${req.params.id})`);
        res.json({ ...result, id: result._id ? result._id.toString() : "" });
    }
    catch (error) {
        next(error);
    }
}));
/**
 * DELETE /skills/:id
 * Delete a skill.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const result = await db
            .collection(COLLECTION)
            .findOneAndDelete({ _id: new ObjectId(req.params.id) });
        if (!result) {
            return res.status(404).json({ error: "Skill not found" });
        }
        logger.info(`Skill deleted: ${result.name} (${req.params.id})`);
        res.json({ success: true });
    }
    catch (error) {
        next(error);
    }
}));
export default router;
//# sourceMappingURL=SkillsRoutes.js.map