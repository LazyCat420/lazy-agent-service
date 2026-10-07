import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { buildToolPolicy } from "./utils.js";
import PromptLocaleService from "../PromptLocaleService.js";
export const OmniPersona = {
    id: AGENT_IDS.OMNI,
    name: "Omni",
    type: "universal",
    description: PromptLocaleService.get("en", "personas.omni.description"),
    project: "prism-chat",
    displayOrder: 1,
    identity: (context) => {
        const activeLocale = context.locale || "en";
        const sections = [
            PromptLocaleService.get(activeLocale, "personas.omni.coreIdentity"),
            PromptLocaleService.get(activeLocale, "personas.omni.responseGuidelines"),
        ];
        return sections.join("\n\n");
    },
    guidelines: "",
    interactionRules: "",
    toolPolicy: (context) => buildToolPolicy([], context),
    availableTools: ["*"],
    enabledByDefaultTools: [],
    capabilities: "",
    usesDirectoryTree: true,
    usesCodingGuidelines: true,
};
//# sourceMappingURL=OmniPersona.js.map