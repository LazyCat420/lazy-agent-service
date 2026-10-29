import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import SettingsService from "../services/SettingsService.js";
import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const router = express.Router();
/**
 * GET /settings
 * Returns the current server-side settings, merged with defaults.
 */
router.get("/", asyncHandler(async (_req, res, next) => {
    try {
        const settings = await SettingsService.get();
        res.json(settings);
    }
    catch (error) {
        logger.error(`GET /settings error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * PUT /settings
 * Upsert settings. Accepts a partial object — deep-merged with existing.
 * When the agent locale changes, re-fetches tool schemas from tools-service
 * so remote tool descriptions are served in the correct locale.
 */
router.put("/", asyncHandler(async (req, res, next) => {
    try {
        const data = req.body;
        if (!data || typeof data !== "object") {
            return res
                .status(400)
                .json({ error: "Request body must be an object" });
        }
        const previousLocale = SettingsService.getCached()?.agents?.locale || "en";
        const updated = await SettingsService.update(data);
        const currentLocale = updated?.agents?.locale || "en";
        if (currentLocale !== previousLocale) {
            logger.info(`[Settings] Locale changed from "${previousLocale}" to "${currentLocale}" — refreshing tool schemas`);
            await ToolOrchestratorService.refreshSchemas();
        }
        res.json(updated);
    }
    catch (error) {
        logger.error(`PUT /settings error: ${getErrorMessage(error)}`);
        next(error);
    }
}));
/**
 * GET /settings/defaults
 * Returns the compiled defaults for reference (useful for "Reset" buttons).
 */
router.get("/defaults", (_req, res) => {
    res.json(SettingsService.getDefaults());
});
/**
 * GET /settings/harnesses
 * Returns the list of available agentic harnesses.
 */
router.get("/harnesses", asyncHandler(async (_req, res) => {
    const { default: AgenticLoopService } = await import("../services/AgenticLoopService.js");
    res.json(AgenticLoopService.listHarnesses());
}));
export default router;
//# sourceMappingURL=SettingsRoutes.js.map