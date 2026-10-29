import { Router } from "express";
import { THOUGHT_STRUCTURE_DEFINITIONS, getThoughtStructureById, } from "../services/harnesses/strategies/ThoughtStructureRegistry.js";
const router = Router();
router.get("/", (_request, response) => {
    response.json(THOUGHT_STRUCTURE_DEFINITIONS);
});
router.get("/:structureId", (request, response) => {
    const structureId = request.params.structureId;
    if (typeof structureId !== "string" || !structureId) {
        return response.status(400).json({ error: "structureId is required" });
    }
    const structureDefinition = getThoughtStructureById(structureId);
    if (!structureDefinition) {
        return response.status(404).json({ error: `Thought structure "${structureId}" not found` });
    }
    response.json(structureDefinition);
});
export default router;
//# sourceMappingURL=ThoughtStructureRoutes.js.map