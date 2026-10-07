import { Router } from "express";
import { TOPOLOGY_DEFINITIONS, getTopologyById, } from "../services/orchestrator/TopologyRegistry.js";
const router = Router();
router.get("/", (_request, response) => {
    response.json(TOPOLOGY_DEFINITIONS);
});
router.get("/:topologyId", (request, response) => {
    const topologyId = request.params.topologyId;
    if (typeof topologyId !== "string" || !topologyId) {
        return response.status(400).json({ error: "topologyId is required" });
    }
    const topologyDefinition = getTopologyById(topologyId);
    if (!topologyDefinition) {
        return response.status(404).json({ error: `Topology "${topologyId}" not found` });
    }
    response.json(topologyDefinition);
});
export default router;
//# sourceMappingURL=TopologyRoutes.js.map