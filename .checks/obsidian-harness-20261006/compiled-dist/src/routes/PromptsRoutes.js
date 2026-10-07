import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import requireDb from "../middleware/RequireDbMiddleware.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";
import { PostPromptSchema, PatchPromptSchema, GetPromptsQuerySchema, } from "../types/index.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { generateUUID } from "@rodrigo-barraza/utilities-library";
const router = express.Router();
router.use(requireDb);
// ─── GET /prompts — list all prompts for the current project & user ──────────
router.get("/", asyncHandler(async (req, res) => {
    try {
        const parseResult = GetPromptsQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
            return res.status(400).json({
                error: `Validation failed: ${parseResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
            });
        }
        const { page, limit, search } = parseResult.data;
        const skip = (page - 1) * limit;
        const filter = {
            project: req.project,
            username: req.username,
        };
        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: "i" } },
                { content: { $regex: search, $options: "i" } },
                { tags: { $regex: search, $options: "i" } },
            ];
        }
        const database = req.db;
        const collection = database.collection(COLLECTIONS.PROMPTS);
        const [total, prompts] = await Promise.all([
            collection.countDocuments(filter),
            collection
                .find(filter)
                .sort({ updatedAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray(),
        ]);
        res.json({ data: prompts, total, page, limit });
    }
    catch (error) {
        logger.error(`[Prompts][GET] Error listing prompts: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to list prompts" });
    }
}));
// ─── GET /prompts/:id — get a single prompt by ID ────────────────────────────
router.get("/:id", asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        const database = req.db;
        const prompt = await database.collection(COLLECTIONS.PROMPTS).findOne({
            id,
            project: req.project,
            username: req.username,
        });
        if (!prompt) {
            return res.status(404).json({ error: "Prompt not found" });
        }
        res.json(prompt);
    }
    catch (error) {
        logger.error(`[Prompts][GET /:id] Error fetching prompt: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to fetch prompt" });
    }
}));
// ─── POST /prompts — create a new prompt ─────────────────────────────────────
router.post("/", asyncHandler(async (req, res) => {
    try {
        const parseResult = PostPromptSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json({
                error: `Validation failed: ${parseResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
            });
        }
        const { title, content, tags, color } = parseResult.data;
        const now = new Date();
        const promptDocument = {
            id: generateUUID(),
            title,
            content,
            tags,
            color,
            project: req.project,
            username: req.username,
            createdAt: now,
            updatedAt: now,
        };
        const database = req.db;
        await database.collection(COLLECTIONS.PROMPTS).insertOne(promptDocument);
        res.status(201).json(promptDocument);
    }
    catch (error) {
        logger.error(`[Prompts][POST] Error creating prompt: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to create prompt" });
    }
}));
// ─── PATCH /prompts/:id — update an existing prompt ──────────────────────────
router.patch("/:id", asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        const parseResult = PatchPromptSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json({
                error: `Validation failed: ${parseResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
            });
        }
        const updates = parseResult.data;
        const database = req.db;
        const result = await database
            .collection(COLLECTIONS.PROMPTS)
            .findOneAndUpdate({ id, project: req.project, username: req.username }, { $set: { ...updates, updatedAt: new Date() } }, { returnDocument: "after" });
        if (!result) {
            return res.status(404).json({ error: "Prompt not found" });
        }
        res.json(result);
    }
    catch (error) {
        logger.error(`[Prompts][PATCH] Error updating prompt ${req.params.id}: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to update prompt" });
    }
}));
// ─── DELETE /prompts/:id — delete a prompt ───────────────────────────────────
router.delete("/:id", asyncHandler(async (req, res) => {
    try {
        const { id } = req.params;
        const database = req.db;
        const result = await database.collection(COLLECTIONS.PROMPTS).deleteOne({
            id,
            project: req.project,
            username: req.username,
        });
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Prompt not found" });
        }
        res.json({ success: true });
    }
    catch (error) {
        logger.error(`[Prompts][DELETE] Error deleting prompt ${req.params.id}: ${getErrorMessage(error)}`);
        res.status(500).json({ error: "Failed to delete prompt" });
    }
}));
export default router;
//# sourceMappingURL=PromptsRoutes.js.map