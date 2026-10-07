import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import ToolOrchestratorService from "../ToolOrchestratorService.js";
import PromptLocaleService from "../PromptLocaleService.js";
// ────────────────────────────────────────────────────────────
// Tool Catalog Introspection Helpers
// ────────────────────────────────────────────────────────────
// Derive domain lists, representative keywords, and trigger examples
// from the live tool catalog at runtime. Used by the persona system
// prompt and the discover_and_enable_tools schema to stay in sync
// with the actual tools-service catalog — no hardcoded lists.
/**
 * Whether a domain represents always-on system tooling (not discoverable).
 * Core domains are excluded from discovery prompts since they're always enabled.
 */
function isDiscoverableDomain(domain) {
    return !domain.startsWith("Core ");
}
/**
 * Extract unique discoverable domain names from the tool catalog.
 * Filters out always-on system domains (Core Workspace, Core Harness, etc.)
 * Returns a sorted array of domain display names.
 */
export function extractDiscoverableDomains() {
    const schemas = ToolOrchestratorService.getClientToolSchemas();
    const domainSet = new Set();
    for (const schema of schemas) {
        const domain = schema.domain;
        if (domain && isDiscoverableDomain(domain)) {
            domainSet.add(domain);
        }
    }
    return [...domainSet].sort();
}
/**
 * Build a map of domain → representative humanized tool keywords.
 * Takes up to `maxPerDomain` keywords per domain for concise display.
 * Keywords are derived from tool names with verb prefixes stripped.
 */
export function extractDomainKeywords(maxPerDomain = 4) {
    const schemas = ToolOrchestratorService.getClientToolSchemas();
    const domainToolKeywords = new Map();
    for (const schema of schemas) {
        const domain = schema.domain;
        const toolName = schema.name;
        if (domain && isDiscoverableDomain(domain) && toolName) {
            if (!domainToolKeywords.has(domain)) {
                domainToolKeywords.set(domain, []);
            }
            const keywords = domainToolKeywords.get(domain);
            if (keywords.length < maxPerDomain) {
                keywords.push(toolName.replace(/_/g, " "));
            }
        }
    }
    return domainToolKeywords;
}
// ────────────────────────────────────────────────────────────
// Tool Discovery System Prompt Section
// ────────────────────────────────────────────────────────────
/**
 * Build the tool discovery system prompt section at runtime.
 * Domain list, tool count, and trigger examples are all derived
 * from the live catalog — nothing is hardcoded.
 */
function buildToolDiscoveryContent(locale) {
    const totalToolCount = ToolOrchestratorService.getClientToolSchemas().length;
    const discoverableDomains = extractDiscoverableDomains();
    const domainList = discoverableDomains.join(", ");
    const domainKeywords = extractDomainKeywords(4);
    const triggerExampleLines = [...domainKeywords.entries()]
        .map(([domain, keywords]) => {
        const quotedKeywords = keywords
            .map((keyword) => `"${keyword}"`)
            .join(", ");
        return PromptLocaleService.get(locale, "tool-policy.toolDiscovery.triggerLineTemplate", {
            keywords: quotedKeywords,
            domain,
        });
    })
        .join("\n");
    const headerLine = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.header");
    const introLine = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.intro", { totalToolCount: String(totalToolCount) });
    const domainsHeader = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.domainsHeader");
    const searchRule = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.searchRule");
    const searchSteps = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.searchSteps");
    const noFallback = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.noFallback");
    const intentHeader = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.intentMatchingHeader");
    const intentRules = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.intentMatchingRules");
    const triggerHeader = PromptLocaleService.get(locale, "tool-policy.toolDiscovery.triggerHeader");
    return `${headerLine}\n${introLine}\n\n${domainsHeader}\n${domainList}\n\n${searchRule}\n${searchSteps}\n\n${noFallback}\n\n${intentHeader}\n${intentRules}\n\n${triggerHeader}\n${triggerExampleLines}`;
}
const TOOL_DISCOVERY_POLICY_SECTION = {
    content: "",
    dynamicContent: buildToolDiscoveryContent,
    requires: [TOOL_NAMES.SEARCH_TOOLS, TOOL_NAMES.DISCOVER_AND_ENABLE_TOOLS],
};
// ────────────────────────────────────────────────────────────
// Shared Tool Policy Sections (auto-injected for all personas)
// ────────────────────────────────────────────────────────────
const GENERAL_TOOL_PRINCIPLES_SECTION = {
    content: (locale) => PromptLocaleService.get(locale, "tool-policy.generalPrinciples"),
};
const TASK_MANAGEMENT_POLICY_SECTION = {
    content: (locale) => PromptLocaleService.get(locale, "tool-policy.taskManagement"),
    requires: [
        TOOL_NAMES.CREATE_TASK,
        TOOL_NAMES.LIST_TASKS,
        TOOL_NAMES.UPDATE_TASK,
    ],
};
const PROACTIVE_MEMORY_POLICY_SECTION = {
    content: (locale) => PromptLocaleService.get(locale, "tool-policy.proactiveMemory"),
    requires: [TOOL_NAMES.SAVE_MEMORY],
};
const AUDIO_TRACKER_POLICY_SECTION = {
    content: (locale) => PromptLocaleService.get(locale, "tool-policy.audioTracker"),
    requires: [TOOL_NAMES.GENERATE_AUDIO],
};
// ────────────────────────────────────────────────────────────
// Shared Tool Policy Builder
// ────────────────────────────────────────────────────────────
/**
 * Shared conditional tool policy builder used by all agent personas.
 *
 * Iterates over a declarative section list and only includes sections
 * whose `requires` tools are present in the resolved `enabledTools`.
 * This ensures the system prompt never references tools the model
 * cannot actually call, saving tokens and preventing hallucinated
 * tool calls.
 *
 * Automatically prepends shared innate sections so every agent gets
 * them without per-persona opt-in:
 * - Tool Discovery (how to search for and enable tools)
 * - Task Management (proactive task tracking)
 * - Proactive Memory (auto-save user preferences)
 * - Audio Tracker (incremental multi-track composition workflow)
 */
export function buildToolPolicy(sections, context) {
    const locale = context.locale || "en";
    const allSections = [
        GENERAL_TOOL_PRINCIPLES_SECTION,
        TOOL_DISCOVERY_POLICY_SECTION,
        TASK_MANAGEMENT_POLICY_SECTION,
        PROACTIVE_MEMORY_POLICY_SECTION,
        AUDIO_TRACKER_POLICY_SECTION,
        ...sections,
    ];
    const enabled = new Set(context.enabledTools || []);
    const enabledArray = [...enabled];
    const filtered = allSections.filter((section) => {
        if (!section.requires || section.requires.length === 0)
            return true;
        return section.requires.some((requirement) => {
            if (requirement.endsWith("*")) {
                const prefix = requirement.slice(0, -1);
                return enabledArray.some((toolName) => toolName.startsWith(prefix));
            }
            return enabled.has(requirement);
        });
    });
    return filtered
        .map((section) => {
        const dynamicSection = section;
        if (dynamicSection.dynamicContent)
            return dynamicSection.dynamicContent(locale);
        if (typeof section.content === "function")
            return section.content(locale);
        return section.content;
    })
        .join("\n\n");
}
/**
 * Returns tool policy guidance for dynamically-discovered tools.
 *
 * When tools are enabled mid-conversation via discover_and_enable_tools,
 * the system prompt has already been assembled without their policy
 * sections. This function evaluates the shared innate policy sections
 * against the newly-enabled tool names and returns any applicable
 * guidance text for injection into the <tool-update> addendum.
 */
export function getToolPolicyAddendum(newlyEnabledToolNames, locale = "en") {
    const policyOnlySections = [
        TASK_MANAGEMENT_POLICY_SECTION,
        PROACTIVE_MEMORY_POLICY_SECTION,
        AUDIO_TRACKER_POLICY_SECTION,
    ];
    const newToolSet = new Set(newlyEnabledToolNames);
    const matchingSections = policyOnlySections.filter((section) => {
        if (!section.requires || section.requires.length === 0)
            return false;
        return section.requires.some((requirement) => {
            if (requirement.endsWith("*")) {
                const prefix = requirement.slice(0, -1);
                return newlyEnabledToolNames.some((toolName) => toolName.startsWith(prefix));
            }
            return newToolSet.has(requirement);
        });
    });
    if (matchingSections.length === 0)
        return "";
    return matchingSections
        .map((section) => {
        if (typeof section.content === "function") {
            return section.content(locale);
        }
        return section.content;
    })
        .join("\n\n");
}
//# sourceMappingURL=utils.js.map