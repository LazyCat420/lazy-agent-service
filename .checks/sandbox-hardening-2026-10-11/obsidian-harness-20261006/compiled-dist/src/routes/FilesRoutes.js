import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import FileService from "../services/FileService.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = express.Router();
/**
 * POST /files/upload
 * Upload a base64 data URL to file storage (MinIO or inline fallback).
 * Body: { data: "data:image/png;base64,..." }
 * Response: { ref, size, contentType }
 */
router.post("/upload", asyncHandler(async (req, res, next) => {
    try {
        const { data } = req.body;
        if (!data) {
            return res.status(400).json({ error: "Missing required field: data" });
        }
        const result = await FileService.uploadFile(data);
        res.json(result);
    }
    catch (error) {
        logger.error(`File upload error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /files/:key(*)
 * Stream a file from MinIO storage.
 * The key is the full object path, e.g. "files/abc-123.png"
 */
router.get("/*key", asyncHandler(async (req, res, next) => {
    try {
        // Express 5 returns wildcard params as arrays of path segments
        const rawKey = req.params.key;
        const key = Array.isArray(rawKey) ? rawKey.join("/") : rawKey;
        if (!key) {
            return res.status(400).json({ error: "Missing file key" });
        }
        const result = await FileService.getFile(key);
        if (!result) {
            return res.status(404).json({ error: "File not found" });
        }
        res.setHeader("Content-Type", result.contentType);
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        result.stream.pipe(res);
    }
    catch (error) {
        logger.error(`File retrieval error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=FilesRoutes.js.map