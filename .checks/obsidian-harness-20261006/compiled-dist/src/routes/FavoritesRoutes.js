import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import requireDb from "../middleware/RequireDbMiddleware.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { GetFavoritesQuerySchema, PostFavoritesBodySchema, DeleteFavoritesQuerySchema, } from "../types/index.js";
const router = express.Router();
router.use(requireDb);
const COLLECTION = COLLECTIONS.FAVORITES;
/**
 * GET /favorites?type=model
 * List favorites, optionally filtered by type.
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const db = req.db;
        const project = req.project || "any";
        const username = req.username || "any";
        const parseResult = GetFavoritesQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
            return res.status(400).json({
                error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            });
        }
        const filter = { project, username };
        if (parseResult.data.type) {
            filter.type = parseResult.data.type;
        }
        const favorites = await db
            .collection(COLLECTION)
            .find(filter)
            .sort({ createdAt: -1 })
            .toArray();
        res.json(favorites);
    }
    catch (error) {
        logger.error(`Error fetching favorites: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * POST /favorites
 * Add a favorite. Body: { type, key, meta? }
 * - type: "model", "workflow", "conversation", etc.
 * - key: unique identifier within the type (e.g. "openai:gpt-4o")
 * - meta: optional metadata object (e.g. { provider, name })
 */
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const db = req.db;
        const project = req.project || "any";
        const username = req.username || "any";
        const parseResult = PostFavoritesBodySchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json({
                error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            });
        }
        const { type, key, meta } = parseResult.data;
        const document = {
            project,
            username,
            type,
            key,
            meta: meta || {},
            createdAt: new Date().toISOString(),
        };
        // Upsert to prevent duplicates
        await db
            .collection(COLLECTION)
            .updateOne({ project, username, type, key }, { $set: document }, { upsert: true });
        res.json({ success: true, favorite: document });
    }
    catch (error) {
        logger.error(`Error adding favorite: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * DELETE /favorites?type=model&key=openai:gpt-4o
 * Remove a specific favorite by type + key.
 */
router.delete("/", asyncHandler(async (req, res, next) => {
    try {
        const db = req.db;
        const project = req.project || "any";
        const username = req.username || "any";
        const parseResult = DeleteFavoritesQuerySchema.safeParse(req.query);
        if (!parseResult.success) {
            return res.status(400).json({
                error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            });
        }
        const { type, key } = parseResult.data;
        const result = await db
            .collection(COLLECTION)
            .deleteOne({ project, username, type, key });
        res.json({ success: true, deleted: result.deletedCount });
    }
    catch (error) {
        logger.error(`Error removing favorite: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=FavoritesRoutes.js.map