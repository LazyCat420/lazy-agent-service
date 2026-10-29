import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "../ToolTaxonomyConstants.js";
import { buildToolPolicy } from "./utils.js";
import PromptLocaleService from "../PromptLocaleService.js";
const IMAGE_TOOL_POLICY_SECTIONS = [
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.image.toolPolicyGenerateImage"),
        requires: [TOOL_NAMES.GENERATE_IMAGE],
    },
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.image.toolPolicySearchWeb"),
        requires: [TOOL_NAMES.SEARCH_WEB],
    },
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.image.toolPolicyAscii"),
        requires: [TOOL_NAMES.CONVERT_IMAGE_TO_ASCII],
    },
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.image.toolPolicySaveMemory"),
        requires: [TOOL_NAMES.SAVE_MEMORY],
    },
];
const IMAGE_AVAILABLE_TOOLS = [
    TOOL_NAMES.GENERATE_IMAGE,
    DOMAIN_KEY_TAGS.CREATIVE,
    DOMAIN_KEY_TAGS.WEB,
    DOMAIN_KEY_TAGS.MOVIES,
    DOMAIN_KEY_TAGS.GAMING,
    TOOL_NAMES.SAVE_MEMORY,
];
export const ImagePersona = {
    id: AGENT_IDS.IMAGE,
    name: "Image",
    type: "creative",
    project: "prism-chat",
    displayOrder: 3,
    description: PromptLocaleService.get("en", "personas.image.description"),
    icon: "Palette",
    color: "#ec4899",
    identity: (context) => {
        const activeLocale = context.locale || "en";
        const sections = [
            PromptLocaleService.get(activeLocale, "personas.image.coreIdentity"),
            PromptLocaleService.get(activeLocale, "personas.image.capabilities"),
            PromptLocaleService.get(activeLocale, "personas.image.responseGuidelines"),
        ];
        return sections.join("\n\n");
    },
    guidelines: "",
    interactionRules: "",
    toolPolicy: (context) => buildToolPolicy(IMAGE_TOOL_POLICY_SECTIONS, context),
    availableTools: IMAGE_AVAILABLE_TOOLS,
    capabilities: "",
    usesDirectoryTree: false,
    usesCodingGuidelines: false,
};
//# sourceMappingURL=ImagePersona.js.map