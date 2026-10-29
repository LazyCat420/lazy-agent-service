import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { getProvider } from "../providers/index.js";
import { isInstance } from "../providers/instance-registry.js";
import { PROVIDERS } from "../constants.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = express.Router();
function resolveInstanceId(req) {
    const id = req.query.instance ||
        req.body?.instance ||
        PROVIDERS.OLLAMA;
    if (!isInstance(id))
        return PROVIDERS.OLLAMA;
    return id;
}
/**
 * GET /ollama/models
 * List all models available from Ollama (with loaded status).
 */
router.get("/models", asyncHandler(async (req, res, next) => {
    try {
        const instanceId = resolveInstanceId(req);
        const provider = getProvider(instanceId);
        if (!provider.listModels) {
            throw new Error(`Provider "${instanceId}" does not support listing models`);
        }
        const data = await provider.listModels();
        res.json(data);
    }
    catch (error) {
        logger.error(`GET /ollama/models error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=OllamaRoutes.js.map