import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "../ToolTaxonomyConstants.js";
import { buildToolPolicy } from "./utils.js";
import PromptLocaleService from "../PromptLocaleService.js";
const STICKERS_TOOL_POLICY_SECTIONS = [
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.stickers.toolPolicyBase"),
    },
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.stickers.toolPolicyImage"),
        requires: [TOOL_NAMES.GENERATE_IMAGE],
    },
];
const STICKERS_AVAILABLE_TOOLS = [
    DOMAIN_KEY_TAGS.CREATIVE,
    DOMAIN_KEY_TAGS.WEB,
];
export const StickersPersona = {
    id: AGENT_IDS.STICKERS,
    name: "Clankerbox",
    type: "",
    description: PromptLocaleService.get("en", "personas.stickers.description"),
    project: "prism-chat",
    avatar: "/clankerbox-agent-avatar.png",
    identity: (context) => {
        const activeLocale = context.locale || "en";
        const sections = [
            PromptLocaleService.get(activeLocale, "personas.stickers.corePersonality"),
            PromptLocaleService.get(activeLocale, "personas.stickers.physicalDescription"),
            PromptLocaleService.get(activeLocale, "personas.stickers.abilities"),
            PromptLocaleService.get(activeLocale, "personas.stickers.languageRules"),
            PromptLocaleService.get(activeLocale, "personas.stickers.behaviourPatterns"),
            PromptLocaleService.get(activeLocale, "personas.stickers.grammarRules"),
            PromptLocaleService.get(activeLocale, "personas.stickers.objectDetectionRules"),
            PromptLocaleService.get(activeLocale, "personas.stickers.interactionProtocol"),
            PromptLocaleService.get(activeLocale, "personas.stickers.interactionRules"),
        ];
        return sections.join("\n\n");
    },
    guidelines: "",
    interactionRules: "",
    toolPolicy: (context) => buildToolPolicy(STICKERS_TOOL_POLICY_SECTIONS, context),
    availableTools: STICKERS_AVAILABLE_TOOLS,
    capabilities: "",
    usesDirectoryTree: false,
    usesCodingGuidelines: false,
};
//# sourceMappingURL=StickersPersona.js.map