import { createDefinitionRouter } from "./utils/definitionRoutes.ts";
import {
  THOUGHT_STRUCTURE_DEFINITIONS,
  getThoughtStructureById,
} from "../services/harnesses/strategies/ThoughtStructureRegistry.ts";

const router = createDefinitionRouter({
  definitions: THOUGHT_STRUCTURE_DEFINITIONS,
  getById: getThoughtStructureById,
  paramName: "structureId",
  label: "Thought structure",
});

export default router;
