import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { buildToolPolicy } from "./utils.js";
import PromptLocaleService from "../PromptLocaleService.js";
const CODING_AVAILABLE_TOOLS = ["*"];
export const CodingPersona = {
    id: AGENT_IDS.CODING,
    name: "Coding",
    type: "coding",
    description: PromptLocaleService.get("en", "personas.coding.description"),
    project: "prism-chat",
    displayOrder: 2,
    identity: (context) => PromptLocaleService.get(context.locale || "en", "system-prompt.codingFallbackIdentity"),
    guidelines: "",
    interactionRules: "",
    toolPolicy: (context) => buildToolPolicy([], context),
    availableTools: CODING_AVAILABLE_TOOLS,
    capabilities: "",
    usesDirectoryTree: true,
    usesCodingGuidelines: true,
};
//# sourceMappingURL=CodingPersona.js.map