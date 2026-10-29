import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
import { BUILT_IN_PERSONAS, buildToolPolicy, } from "./personas/index.js";
const PERSONAS = new Map(BUILT_IN_PERSONAS);
// ── Registry API ─────────────────────────────────────────────────
const AgentPersonaRegistry = {
    get(agentId) {
        if (!agentId)
            return null;
        const persona = PERSONAS.get(agentId.toUpperCase());
        if (!persona) {
            logger.warn(`[AgentPersonaRegistry] Unknown agent: "${agentId}"`);
            return null;
        }
        return persona;
    },
    list() {
        return [...PERSONAS.values()]
            .sort((firstPersona, secondPersona) => (firstPersona.displayOrder ?? 100) -
            (secondPersona.displayOrder ?? 100))
            .map((persona) => ({
            id: persona.id,
            name: persona.name,
            type: persona.type || "",
            ...(persona.custom ? { custom: true } : {}),
        }));
    },
    has(agentId) {
        return PERSONAS.has((agentId || "").toUpperCase());
    },
    isAgentProject(project) {
        if (!project)
            return false;
        for (const persona of PERSONAS.values()) {
            if (persona.project === project)
                return true;
        }
        return false;
    },
    /**
     * Register a custom (user-defined) agent persona at runtime.
     * Converts a MongoDB document into a persona object compatible
     * with the built-in format, then inserts into the PERSONAS map.
     */
    registerCustom(doc) {
        if (!doc?.agentId || typeof doc.agentId !== "string")
            return;
        // Reconstruct PolicyRules from serialized format
        const rawPolicies = Array.isArray(doc.policies)
            ? doc.policies
            : [];
        const policies = rawPolicies.map((serializedPolicy) => {
            const rule = {
                tool: serializedPolicy.tool || "*",
                decision: serializedPolicy.decision || "ASK_USER",
                name: serializedPolicy.name ||
                    `${serializedPolicy.decision}(${serializedPolicy.tool})`,
            };
            // Reconstruct `when` predicate from pattern string
            if (serializedPolicy.pattern &&
                typeof serializedPolicy.pattern === "string") {
                try {
                    const regex = new RegExp(serializedPolicy.pattern);
                    const field = serializedPolicy.field || "command";
                    rule.when = (args) => regex.test(String(args[field] ?? ""));
                }
                catch {
                    logger.warn(`[AgentPersonaRegistry] Invalid regex pattern "${serializedPolicy.pattern}" in policy for agent ${doc.agentId}`);
                }
            }
            return rule;
        });
        const persona = {
            id: doc.agentId,
            name: doc.name || doc.agentId,
            type: doc.type || "",
            description: doc.description || "",
            project: doc.project || "prism-chat",
            custom: true,
            icon: doc.icon || "",
            avatar: doc.avatar || "",
            color: doc.color || "",
            backgroundImage: doc.backgroundImage || "",
            identity: () => doc.identity || "",
            guidelines: doc.guidelines || "",
            interactionRules: "",
            toolPolicy: (personaContext) => {
                // Support structured ToolPolicySection[] stored in MongoDB,
                // or fall back to wrapping a plain string as a single section.
                const raw = doc.toolPolicy;
                let sections;
                if (Array.isArray(raw)) {
                    sections = raw.map((section) => ({
                        content: section.content || "",
                        ...(Array.isArray(section.requires)
                            ? { requires: section.requires }
                            : {}),
                    }));
                }
                else {
                    const text = raw || "";
                    sections = text ? [{ content: text }] : [];
                }
                return buildToolPolicy(sections, personaContext);
            },
            availableTools: Array.isArray(doc.availableTools)
                ? doc.availableTools
                : Array.isArray(doc.enabledTools)
                    ? doc.enabledTools
                    : [],
            enabledByDefaultTools: Array.isArray(doc.enabledByDefaultTools)
                ? doc.enabledByDefaultTools
                : undefined,
            // Lean-agent fields. These were silently dropped before, which meant a
            // custom agent could never opt out of the 30 force-included core tools
            // or the always-on thinking default — only built-in personas could.
            blockedTools: Array.isArray(doc.blockedTools)
                ? doc.blockedTools
                : undefined,
            coreToolsLocked: typeof doc.coreToolsLocked === "boolean"
                ? doc.coreToolsLocked
                : undefined,
            compactToolDocs: typeof doc.compactToolDocs === "boolean"
                ? doc.compactToolDocs
                : undefined,
            thinkingDefault: typeof doc.thinkingDefault === "boolean"
                ? doc.thinkingDefault
                : undefined,
            policies: policies.length > 0 ? policies : undefined,
            capabilities: "",
            platformRules: typeof doc.platformRules === "object" &&
                doc.platformRules !== null &&
                Object.keys(doc.platformRules).length > 0
                ? doc.platformRules
                : undefined,
            hasSomaticState: doc.hasSomaticState || false,
            usesDirectoryTree: doc.usesDirectoryTree || false,
            usesCodingGuidelines: doc.usesCodingGuidelines || false,
        };
        PERSONAS.set(doc.agentId, persona);
        logger.info(`[AgentPersonaRegistry] Registered custom agent: "${doc.name}" (${doc.agentId}) with ${persona.availableTools.length} tools, ${policies.length} policies`);
    },
    unregister(agentId) {
        if (!agentId)
            return;
        const key = agentId.toUpperCase();
        const persona = PERSONAS.get(key);
        if (persona?.custom) {
            PERSONAS.delete(key);
            logger.info(`[AgentPersonaRegistry] Unregistered custom agent: "${key}"`);
        }
    },
    /**
     * Load all custom agents from the database and register them.
     * Called at startup and can be called to refresh after mutations.
     */
    async loadCustomAgents() {
        try {
            const { default: CustomAgentService } = await import("./CustomAgentService.js");
            const agents = await CustomAgentService.list();
            // Clear existing custom agents first
            for (const [key, persona] of PERSONAS) {
                if (persona.custom)
                    PERSONAS.delete(key);
            }
            for (const document of agents) {
                this.registerCustom(document);
            }
            logger.info(`[AgentPersonaRegistry] Loaded ${agents.length} custom agent(s) from database`);
        }
        catch (error) {
            logger.warn(`[AgentPersonaRegistry] Failed to load custom agents: ${getErrorMessage(error)}`);
        }
    },
};
export default AgentPersonaRegistry;
//# sourceMappingURL=AgentPersonaRegistry.js.map