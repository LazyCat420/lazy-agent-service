import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "../ToolTaxonomyConstants.js";
import { buildToolPolicy } from "./utils.js";
import PromptLocaleService from "../PromptLocaleService.js";
const DIGEST_TOOL_POLICY_SECTIONS = [
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.digest.toolPolicy"),
        requires: [TOOL_NAMES.CALCULATE_CALORIC_NEEDS, TOOL_NAMES.BUILD_MEAL_PLAN],
    },
];
const DIGEST_AVAILABLE_TOOLS = [
    DOMAIN_KEY_TAGS.HEALTH,
    DOMAIN_KEY_TAGS.WEB,
    TOOL_NAMES.CALCULATE_PRECISE,
    TOOL_NAMES.EXECUTE_JAVASCRIPT,
    TOOL_NAMES.GET_WEATHER,
    TOOL_NAMES.SAVE_MEMORY,
];
export const DigestPersona = {
    id: AGENT_IDS.DIGEST,
    name: "Digest",
    type: "",
    description: PromptLocaleService.get("en", "personas.digest.description"),
    project: "prism-chat",
    identity: (context) => {
        const activeLocale = context.locale || "en";
        const sections = [
            PromptLocaleService.get(activeLocale, "personas.digest.corePersonality"),
            PromptLocaleService.get(activeLocale, "personas.digest.capabilities"),
            PromptLocaleService.get(activeLocale, "personas.digest.responseGuidelines"),
            PromptLocaleService.get(activeLocale, "personas.digest.interactionRules"),
        ];
        return sections.join("\n\n");
    },
    guidelines: "",
    interactionRules: "",
    toolPolicy: (context) => buildToolPolicy(DIGEST_TOOL_POLICY_SECTIONS, context),
    availableTools: DIGEST_AVAILABLE_TOOLS,
    capabilities: "",
    usesDirectoryTree: false,
    usesCodingGuidelines: false,
};
//# sourceMappingURL=DigestPersona.js.map