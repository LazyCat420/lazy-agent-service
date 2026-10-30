import { createDefinitionRouter } from "./utils/definitionRoutes.ts";
import {
  TOPOLOGY_DEFINITIONS,
  getTopologyById,
} from "../services/orchestrator/TopologyRegistry.ts";

const router = createDefinitionRouter({
  definitions: TOPOLOGY_DEFINITIONS,
  getById: getTopologyById,
  paramName: "topologyId",
  label: "Topology",
});

export default router;
