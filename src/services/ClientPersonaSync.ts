// ============================================================
// ClientPersonaSync
//
// Boot-time upsert of the client personas our consuming apps run under,
// straight into our own custom_agents collection (Mongo) — the same
// collection prism's /custom-agents used to write through its REST API.
//
// Until 2026-10-16 this ran through PrismRegistrationService → POST
// /custom-agents on prism-service; the upsert below produces the same
// document identity: agentId is derived from the NAME (deriveAgentId), so
// "HTML-Notes Canvas" lands as CUSTOM_HTML_NOTES_CANVAS and consumers that
// reference that id keep working. project is left to CustomAgentService's
// default ("coding") — the row prism wrote carried the same default, and
// AgentPersonaRegistry keys persona resolution off it.
//
// Everything is idempotent — safe to run on every boot — and never throws:
// a Mongo outage must not stop the tool server from booting.
// ============================================================
import type { Persona } from "./personas/types.ts";
import logger from "../utils/logger.ts";
import CustomAgentService from "./CustomAgentService.ts";

interface ClientPersonaTarget {
  /** Persona id from BUILT_IN_PERSONAS (e.g. "HTML_NOTES"). */
  persona: string;
  /** The app whose requests run under this persona (for log labels). */
  consumer: string;
}

/** The client personas that must exist for our consuming apps. */
const CLIENT_PERSONAS: ClientPersonaTarget[] = [
  { persona: "HTML_NOTES", consumer: "html-notes-client" },
];

// Personas are resolved LAZILY via AgentPersonaRegistry, not by importing
// BUILT_IN_PERSONAS from personas/index at the top of this module.
//
// There is a pre-existing import cycle:
//   personas/index → personas/utils → ToolOrchestratorService
//                  → AgentPersonaRegistry → personas/index
// AgentPersonaRegistry builds its map at MODULE TOP LEVEL
// (`new Map(BUILT_IN_PERSONAS)`), so whichever of the two loads FIRST decides
// whether this works. Enter via AgentPersonaRegistry and the cycle resolves;
// enter via personas/index and you hit BUILT_IN_PERSONAS in its TDZ.
async function loadPersona(id: string): Promise<Persona | null> {
  const mod = await import("./AgentPersonaRegistry.ts");
  const registry = mod.default;
  return registry.has(id) ? registry.get(id) : null;
}

/** Upsert one persona as a custom agent and verify its tool scope survived. */
async function upsertPersona(target: ClientPersonaTarget): Promise<void> {
  const label = target.consumer;
  const persona = await loadPersona(target.persona);
  if (!persona) {
    logger.warn(`[Persona-Sync] [${label}] unknown persona "${target.persona}" — skipped.`);
    return;
  }

  // Client personas take no context (their caller sends the live prompt), but
  // the signature requires one — pass an empty context rather than assume.
  let identity = "";
  try {
    identity =
      typeof persona.identity === "function"
        ? persona.identity({} as Parameters<Persona["identity"]>[0])
        : String(persona.identity ?? "");
  } catch (err) {
    logger.warn(`[Persona-Sync] [${label}] persona identity() threw: ${String(err)}`);
  }
  const payload = {
    name: persona.name,
    description: persona.description ?? "",
    identity: identity ?? "",
    availableTools: persona.availableTools ?? [],
  };

  const existing = (await CustomAgentService.list()).find(
    (agent: Record<string, unknown>) => agent.name === persona.name,
  );

  let saved: Record<string, unknown>;
  if (existing) {
    saved = (await CustomAgentService.update(
      String(existing._id),
      payload,
    )) as Record<string, unknown>;
    logger.info(`[Persona-Sync] [${label}] updated persona ${String(saved.agentId)}`);
  } else {
    saved = (await CustomAgentService.create(
      payload,
    )) as Record<string, unknown>;
    logger.info(`[Persona-Sync] [${label}] created persona ${String(saved.agentId)}`);
    // A fresh row is invisible to the live registry until the next boot's
    // loadCustomAgents — register it now, exactly as the old REST upsert's
    // server-side handler did.
    const mod = await import("./AgentPersonaRegistry.ts");
    mod.default.registerCustom(saved);
  }

  // Prism silently dropped fields on write; verify, don't trust.
  const got = new Set(
    Array.isArray(saved.availableTools) ? (saved.availableTools as string[]) : [],
  );
  const missing = (persona.availableTools ?? []).filter((tool) => !got.has(tool));
  if (missing.length) {
    logger.warn(
      `[Persona-Sync] [${label}] persona ${String(saved.agentId)} is missing ${missing.length} ` +
        `tool(s) after write — the agent will run under-scoped: ${missing.join(", ")}`,
    );
  } else {
    logger.success(
      `[Persona-Sync] [${label}] persona ${String(saved.agentId)} verified (${got.size} tools)`,
    );
  }
}

/**
 * Ensure every client persona exists for our consuming apps.
 * Never throws; failures are logged per persona.
 */
export async function syncClientPersonas(): Promise<void> {
  for (const target of CLIENT_PERSONAS) {
    try {
      await upsertPersona(target);
    } catch (err) {
      logger.warn(
        `[Persona-Sync] [${target.consumer}] persona sync failed: ${String(err)}`,
      );
    }
  }
}
