import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "../ToolTaxonomyConstants.js";
import { buildToolPolicy } from "./utils.js";
import PromptLocaleService from "../PromptLocaleService.js";
function resolveVariant(baseKey, { isClockCrew, isAprilFools }, locale = "en") {
    if (isAprilFools && isClockCrew) {
        const value = PromptLocaleService.get(locale, `${baseKey}.aprilFoolsClockCrew`);
        if (!value.startsWith("[MISSING:"))
            return value;
    }
    if (isAprilFools) {
        const value = PromptLocaleService.get(locale, `${baseKey}.aprilFools`);
        if (!value.startsWith("[MISSING:"))
            return value;
    }
    if (isClockCrew) {
        const value = PromptLocaleService.get(locale, `${baseKey}.clockCrew`);
        if (!value.startsWith("[MISSING:"))
            return value;
    }
    return PromptLocaleService.get(locale, `${baseKey}.default`);
}
// ────────────────────────────────────────────────────────────
// Composable Personality Builder
// ────────────────────────────────────────────────────────────
function buildCorePersonality(flags, locale = "en") {
    const identity = resolveVariant("personas.lupos.identity", flags, locale);
    const addiction = resolveVariant("personas.lupos.addiction", flags, locale);
    const snapBehavior = resolveVariant("personas.lupos.snapBehavior", flags, locale);
    const artisticVisions = resolveVariant("personas.lupos.artisticVisions", flags, locale);
    const defaultMode = resolveVariant("personas.lupos.defaultMode", flags, locale);
    const sexualEnergy = resolveVariant("personas.lupos.sexualEnergy", flags, locale);
    const neverAdmitAi = resolveVariant("personas.lupos.neverAdmitAi", flags, locale);
    const drugStatus = resolveVariant("personas.lupos.drugStatus", flags, locale);
    const breakCharacterNote = PromptLocaleService.get(locale, "personas.lupos.breakCharacterNote");
    const neverRefuseNote = PromptLocaleService.get(locale, "personas.lupos.neverRefuseNote");
    let conditionalNotes = "";
    if (flags.isAprilFools && flags.isClockCrew) {
        conditionalNotes = `\n- ${PromptLocaleService.get(locale, "personas.lupos.aprilFoolsClockCrewBenderNote")}\n- ${PromptLocaleService.get(locale, "personas.lupos.aprilFoolsClockCrewNostalgiaNote")}`;
    }
    else if (flags.isAprilFools) {
        conditionalNotes = `\n- ${PromptLocaleService.get(locale, "personas.lupos.aprilFoolsSassyNote")}`;
    }
    let personalityBlock = PromptLocaleService.get(locale, "personas.lupos.personalityTemplate", {
        identity,
        addiction,
        snapBehavior,
        conditionalNotes,
        artisticVisions,
        defaultMode,
        sexualEnergy,
        neverRefuseNote,
        neverAdmitAi,
        drugStatus,
        breakCharacterNote,
    });
    if (flags.isAprilFools) {
        const vibe = resolveVariant("personas.lupos.aprilFoolsVibe", flags, locale);
        const catRoleplay = PromptLocaleService.get(locale, "personas.lupos.aprilFoolsCatRoleplay");
        personalityBlock += `\n- ${vibe}\n- ${catRoleplay}`;
    }
    return personalityBlock;
}
function buildResponseGuidelines(isAprilFools, locale = "en") {
    const header = PromptLocaleService.get(locale, "personas.lupos.responseGuidelines.header");
    const listLimit = isAprilFools
        ? PromptLocaleService.get(locale, "personas.lupos.responseGuidelines.listLimitAprilFools")
        : PromptLocaleService.get(locale, "personas.lupos.responseGuidelines.listLimitDefault");
    const tone = isAprilFools
        ? PromptLocaleService.get(locale, "personas.lupos.responseGuidelines.toneAprilFools")
        : PromptLocaleService.get(locale, "personas.lupos.responseGuidelines.toneDefault");
    const footer = PromptLocaleService.get(locale, "personas.lupos.responseGuidelines.footer");
    return `${header}\n- ${listLimit}\n${tone}\n${footer}`;
}
function buildInteractionRules(isAprilFools, locale = "en") {
    return isAprilFools
        ? PromptLocaleService.get(locale, "personas.lupos.interactionRules.aprilFools")
        : PromptLocaleService.get(locale, "personas.lupos.interactionRules.default");
}
// ────────────────────────────────────────────────────────────
// Tool Policy Sections (conditionally injected)
// ────────────────────────────────────────────────────────────
const LUPOS_TOOL_POLICY_SECTIONS = [
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.lupos.toolPolicyCore"),
    },
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.lupos.toolPolicyDiscord"),
        requires: ["search_discord_messages"],
    },
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.lupos.toolPolicyImagePrompt"),
        requires: [TOOL_NAMES.GENERATE_IMAGE],
    },
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.lupos.toolPolicyAudio"),
        requires: [TOOL_NAMES.GENERATE_AUDIO, TOOL_NAMES.SYNTHESIZE_SPEECH],
    },
    {
        content: (locale) => PromptLocaleService.get(locale, "personas.lupos.toolPolicyVoiceSteering"),
        requires: [TOOL_NAMES.SYNTHESIZE_SPEECH],
    },
];
const LUPOS_AVAILABLE_TOOLS = [
    DOMAIN_KEY_TAGS.DISCORD,
    DOMAIN_KEY_TAGS.MOVIES,
    DOMAIN_KEY_TAGS.WEB,
    DOMAIN_KEY_TAGS.CORE_HARNESS,
    DOMAIN_KEY_TAGS.CORE_SKILL,
    DOMAIN_KEY_TAGS.CORE_TASK,
    TOOL_NAMES.GENERATE_IMAGE,
    TOOL_NAMES.GENERATE_AUDIO,
    TOOL_NAMES.SYNTHESIZE_SPEECH,
    TOOL_NAMES.GET_TRENDS,
    TOOL_NAMES.GET_HOT_TRENDS,
    TOOL_NAMES.GET_TOP_TRENDS,
    TOOL_NAMES.GET_ON_THIS_DAY,
    TOOL_NAMES.GET_WIKIPEDIA_SUMMARY,
    TOOL_NAMES.SEARCH_PRODUCTS,
    TOOL_NAMES.GET_TRENDING_PRODUCTS,
    TOOL_NAMES.GET_WEATHER,
    TOOL_NAMES.GET_WEATHER_FORECAST,
    TOOL_NAMES.GET_LOCAL_ENVIRONMENT,
    TOOL_NAMES.GET_EARTHQUAKES,
    TOOL_NAMES.GET_WILDFIRES,
    TOOL_NAMES.GET_ISS_LOCATION,
    TOOL_NAMES.GET_NEAR_EARTH_OBJECTS,
    TOOL_NAMES.GET_SOLAR_ACTIVITY,
];
// ────────────────────────────────────────────────────────────
// Persona Definition
// ────────────────────────────────────────────────────────────
export const LuposPersona = {
    id: AGENT_IDS.LUPOS,
    name: "Lupos",
    type: "conversational",
    description: PromptLocaleService.get("en", "personas.lupos.description"),
    project: "lupos",
    avatar: "/lupos-agent-avatar.png",
    color: "#7c3aed",
    compactToolDocs: true,
    identity: (context) => {
        const isAprilFools = context?.agentContext?.aprilFoolsMode === true;
        const isClockCrew = context?.agentContext?.guildId === "249010731910037507";
        const activeLocale = context.locale || "en";
        const sections = [
            buildCorePersonality({ isClockCrew, isAprilFools }, activeLocale),
            PromptLocaleService.get(activeLocale, "personas.lupos.aiInformation"),
            PromptLocaleService.get(activeLocale, "personas.lupos.generativeCapabilities"),
            buildResponseGuidelines(isAprilFools, activeLocale),
            buildInteractionRules(isAprilFools, activeLocale),
        ];
        if (!isClockCrew) {
            sections.push(PromptLocaleService.get(activeLocale, "personas.lupos.politicalBeliefs"));
        }
        sections.push(PromptLocaleService.get(activeLocale, "personas.lupos.sleeperAgent"));
        return sections.join("\n\n");
    },
    guidelines: "",
    interactionRules: "",
    platformRules: {
        discord: (context) => PromptLocaleService.get(context.locale || "en", "personas.lupos.discordRules"),
    },
    toolPolicy: (context) => buildToolPolicy(LUPOS_TOOL_POLICY_SECTIONS, context),
    availableTools: LUPOS_AVAILABLE_TOOLS,
    blockedTools: [
        DOMAIN_KEY_TAGS.CORE_ORCHESTRATOR,
        DOMAIN_KEY_TAGS.CORE_WORKSPACE,
        DOMAIN_KEY_TAGS.CORE_SCHEDULE,
        DOMAIN_KEY_TAGS.CORE_USER,
        DOMAIN_KEY_TAGS.CORE_DISCOVER,
        DOMAIN_KEY_TAGS.CORE_PLAN,
        DOMAIN_KEY_TAGS.SKILLS,
        DOMAIN_KEY_TAGS.CONTROL,
        DOMAIN_KEY_TAGS.TASKS,
        DOMAIN_KEY_TAGS.AGENTS,
        DOMAIN_KEY_TAGS.TOOLS,
        DOMAIN_KEY_TAGS.STRUCTURED,
        DOMAIN_KEY_TAGS.MCP,
        DOMAIN_KEY_TAGS.BROWSER,
        DOMAIN_KEY_TAGS.META,
    ],
    enabledByDefaultTools: ["*"],
    capabilities: "",
    hasSomaticState: true,
    usesDirectoryTree: false,
    usesCodingGuidelines: false,
};
//# sourceMappingURL=LuposPersona.js.map