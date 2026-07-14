import logger from "../utils/logger.ts";
import type { PolicyRule, PolicyDecision } from "./PolicyEngine.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";
import {
  BUILT_IN_PERSONAS,
  Persona,
  PersonaContext,
  ToolPolicySection,
  SerializedPolicy,
  buildToolPolicy,
} from "./personas/index.ts";

const PERSONAS = new Map<string, Persona>(BUILT_IN_PERSONAS);

// ── Registry API ─────────────────────────────────────────────────

const AgentPersonaRegistry = {
  get(agentId: string): Persona | null {
    if (!agentId) return null;
    const persona = PERSONAS.get(agentId.toUpperCase());
    if (!persona) {
      logger.warn(`[AgentPersonaRegistry] Unknown agent: "${agentId}"`);
      return null;
    }
    return persona;
  },

  list() {
    return [...PERSONAS.values()]
      .sort(
        (firstPersona, secondPersona) =>
          (firstPersona.displayOrder ?? 100) -
          (secondPersona.displayOrder ?? 100),
      )
      .map((persona) => ({
        id: persona.id,
        name: persona.name,
        type: persona.type || "",
        ...(persona.custom ? { custom: true } : {}),
      }));
  },

  has(agentId: string): boolean {
    return PERSONAS.has((agentId || "").toUpperCase());
  },

  isAgentProject(project: string): boolean {
    if (!project) return false;
    for (const persona of PERSONAS.values()) {
      if (persona.project === project) return true;
    }
    return false;
  },

  /**
   * Register a custom (user-defined) agent persona at runtime.
   * Converts a MongoDB document into a persona object compatible
   * with the built-in format, then inserts into the PERSONAS map.
   */
  registerCustom(doc: Record<string, unknown>) {
    if (!doc?.agentId || typeof doc.agentId !== "string") return;

    // Reconstruct PolicyRules from serialized format
    const rawPolicies = Array.isArray(doc.policies)
      ? (doc.policies as SerializedPolicy[])
      : [];
    const policies: PolicyRule[] = rawPolicies.map((serializedPolicy) => {
      const rule: PolicyRule = {
        tool: serializedPolicy.tool || "*",
        decision: (serializedPolicy.decision as PolicyDecision) || "ASK_USER",
        name:
          serializedPolicy.name ||
          `${serializedPolicy.decision}(${serializedPolicy.tool})`,
      };
      // Reconstruct `when` predicate from pattern string
      if (
        serializedPolicy.pattern &&
        typeof serializedPolicy.pattern === "string"
      ) {
        try {
          const regex = new RegExp(serializedPolicy.pattern);
          const field = serializedPolicy.field || "command";
          rule.when = (args: Record<string, unknown>) =>
            regex.test(String(args[field] ?? ""));
        } catch {
          logger.warn(
            `[AgentPersonaRegistry] Invalid regex pattern "${serializedPolicy.pattern}" in policy for agent ${doc.agentId}`,
          );
        }
      }
      return rule;
    });

    const persona: Persona = {
      id: doc.agentId as string,
      name: (doc.name as string) || (doc.agentId as string),
      type: (doc.type as string) || "",
      description: (doc.description as string) || "",
      project: (doc.project as string) || "prism-chat",
      custom: true,
      icon: (doc.icon as string) || "",
      avatar: (doc.avatar as string) || "",
      color: (doc.color as string) || "",
      backgroundImage: (doc.backgroundImage as string) || "",
      identity: () => (doc.identity as string) || "",
      guidelines: (doc.guidelines as string) || "",
      interactionRules: "",
      toolPolicy: (personaContext: PersonaContext) => {
        // Support structured ToolPolicySection[] stored in MongoDB,
        // or fall back to wrapping a plain string as a single section.
        const raw = doc.toolPolicy;
        let sections: ToolPolicySection[];

        if (Array.isArray(raw)) {
          sections = (raw as Array<Record<string, unknown>>).map((section) => ({
            content: (section.content as string) || "",
            ...(Array.isArray(section.requires)
              ? { requires: section.requires as string[] }
              : {}),
          }));
        } else {
          const text = (raw as string) || "";
          sections = text ? [{ content: text }] : [];
        }

        return buildToolPolicy(sections, personaContext);
      },
      availableTools: Array.isArray(doc.availableTools)
        ? (doc.availableTools as string[])
        : Array.isArray(doc.enabledTools)
          ? (doc.enabledTools as string[])
          : [],
      enabledByDefaultTools: Array.isArray(doc.enabledByDefaultTools)
        ? (doc.enabledByDefaultTools as string[])
        : undefined,
      // Lean-agent fields. These were silently dropped before, which meant a
      // custom agent could never opt out of the 30 force-included core tools
      // or the always-on thinking default — only built-in personas could.
      blockedTools: Array.isArray(doc.blockedTools)
        ? (doc.blockedTools as string[])
        : undefined,
      coreToolsLocked:
        typeof doc.coreToolsLocked === "boolean"
          ? doc.coreToolsLocked
          : undefined,
      compactToolDocs:
        typeof doc.compactToolDocs === "boolean"
          ? doc.compactToolDocs
          : undefined,
      thinkingDefault:
        typeof doc.thinkingDefault === "boolean"
          ? doc.thinkingDefault
          : undefined,
      policies: policies.length > 0 ? policies : undefined,
      capabilities: "",
      platformRules:
        typeof doc.platformRules === "object" &&
        doc.platformRules !== null &&
        Object.keys(doc.platformRules as object).length > 0
          ? (doc.platformRules as Record<string, string>)
          : undefined,
      hasSomaticState: (doc.hasSomaticState as boolean) || false,
      usesDirectoryTree: (doc.usesDirectoryTree as boolean) || false,
      usesCodingGuidelines: (doc.usesCodingGuidelines as boolean) || false,
    };

    PERSONAS.set(doc.agentId as string, persona);
    logger.info(
      `[AgentPersonaRegistry] Registered custom agent: "${doc.name}" (${doc.agentId}) with ${persona.availableTools.length} tools, ${policies.length} policies`,
    );
  },

  unregister(agentId: string) {
    if (!agentId) return;
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
      const { default: CustomAgentService } =
        await import("./CustomAgentService.js");
      const agents = await CustomAgentService.list();

      // Clear existing custom agents first
      for (const [key, persona] of PERSONAS) {
        if (persona.custom) PERSONAS.delete(key);
      }

      for (const document of agents) {
        this.registerCustom(document);
      }

      logger.info(
        `[AgentPersonaRegistry] Loaded ${agents.length} custom agent(s) from database`,
      );
    } catch (error: unknown) {
      logger.warn(
        `[AgentPersonaRegistry] Failed to load custom agents: ${getErrorMessage(error)}`,
      );
    }
  },
};

export default AgentPersonaRegistry;
export type { Persona, PersonaContext, ToolPolicySection };
