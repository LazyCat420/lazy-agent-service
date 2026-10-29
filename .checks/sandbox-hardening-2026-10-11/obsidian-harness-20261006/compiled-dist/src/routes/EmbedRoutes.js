import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { ProviderError } from "../utils/errors.js";
import EmbeddingService from "../services/EmbeddingService.js";
const router = express.Router();
/**
 * POST /embed
 * Body: {
 *   provider,          // required
 *   model?,            // optional, falls back to provider default
 *   text?,             // optional — text content
 *   images?,           // optional — array of base64 / data URL strings
 *   audio?,            // optional — base64 / data URL string
 *   video?,            // optional — base64 / data URL string
 *   pdf?,              // optional — base64 / data URL string
 *   taskType?,         // optional — e.g. SEMANTIC_SIMILARITY, RETRIEVAL_DOCUMENT
 *   dimensions?,       // optional — output dimensionality (128–3072)
 * }
 * Response: { embedding, dimensions, provider, model }
 */
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const { provider: pName, model, text, images, audio, video, pdf, taskType, dimensions, traceId, } = req.body;
        if (!pName) {
            throw new ProviderError("server", "Missing required field: provider", 400);
        }
        // At least one content input is required
        const hasContent = text || (images && images.length > 0) || audio || video || pdf;
        if (!hasContent) {
            throw new ProviderError("server", "At least one content input is required (text, images, audio, video, or pdf)", 400);
        }
        // Build content for provider — text-only vs multimodal
        let content;
        const isMultimodal = (images && images.length > 0) || audio || video || pdf;
        if (!isMultimodal && text) {
            content = text;
        }
        else {
            const parts = [];
            if (text) {
                parts.push({ text });
            }
            const parseDataUrl = (data, fallbackMime) => {
                if (typeof data === "string" && data.includes(";base64,")) {
                    const segments = data.split(";base64,");
                    return {
                        data: segments[1],
                        mimeType: segments[0].replace("data:", ""),
                    };
                }
                return { data, mimeType: fallbackMime };
            };
            if (images && images.length > 0) {
                for (const image of images) {
                    const { data, mimeType } = parseDataUrl(image, "image/jpeg");
                    parts.push({ inlineData: { data, mimeType } });
                }
            }
            if (audio) {
                const { data, mimeType } = parseDataUrl(audio, "audio/mpeg");
                parts.push({ inlineData: { data, mimeType } });
            }
            if (video) {
                const { data, mimeType } = parseDataUrl(video, "video/mp4");
                parts.push({ inlineData: { data, mimeType } });
            }
            if (pdf) {
                const { data, mimeType } = parseDataUrl(pdf, "application/pdf");
                parts.push({ inlineData: { data, mimeType } });
            }
            content = parts;
        }
        const result = await EmbeddingService.generate(content, {
            provider: pName,
            model,
            taskType,
            dimensions,
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
            source: "api",
            endpoint: "/embed",
            traceId: traceId || null,
        });
        res.json(result);
    }
    catch (error) {
        next(error);
    }
}));
export default router;
//# sourceMappingURL=EmbedRoutes.js.map