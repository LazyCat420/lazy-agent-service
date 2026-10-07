import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import PromptLocaleService from "../PromptLocaleService.js";
export const MeepoPersona = {
    id: AGENT_IDS.MEEPO,
    name: "Meepo",
    type: "conversational",
    description: PromptLocaleService.get("en", "personas.meepo.description"),
    project: "prism-chat",
    identity: (context) => {
        const activeLocale = context.locale || "en";
        const sections = [
            PromptLocaleService.get(activeLocale, "personas.meepo.corePersonality"),
            PromptLocaleService.get(activeLocale, "personas.meepo.responseGuidelines"),
            PromptLocaleService.get(activeLocale, "personas.meepo.interactionRules"),
        ];
        return sections.join("\n\n");
    },
    guidelines: "",
    interactionRules: "",
    toolPolicy: "",
    availableTools: [],
    capabilities: "",
    usesDirectoryTree: false,
    usesCodingGuidelines: false,
};
//# sourceMappingURL=MeepoPersona.js.map