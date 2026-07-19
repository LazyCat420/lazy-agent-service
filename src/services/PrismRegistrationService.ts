// ============================================================
// PrismRegistrationService
//
// This service owns lazy-tool-service's own presence in Prism.
//
// Previously trading-service registered us: it wrote straight into Prism's
// `mcp_servers` Mongo collection on ITS boot, for three scopes — one of which
// was html-notes-client. That made every consumer's tool set depend on the
// trading bot booting, and nothing re-established the SSE link when THIS
// service redeployed (the connection dies with us; only we come back after).
//
// So registration lives here now, and goes through Prism's REST API rather
// than its database:
//
//   GET    /mcp-servers            (scoped by x-project / x-username headers)
//   POST   /mcp-servers            create
//   PUT    /mcp-servers/:id        update
//   POST   /mcp-servers/:id/connect
//   GET|POST|PUT /custom-agents    persona upsert
//
// Everything is idempotent — safe to run on every boot.
// ============================================================
import type { Persona } from "./personas/types.ts";
import logger from "../utils/logger.ts";

// Personas are resolved LAZILY via AgentPersonaRegistry, not by importing
// BUILT_IN_PERSONAS from personas/index at the top of this module.
//
// There is a pre-existing import cycle:
//   personas/index → personas/utils → ToolOrchestratorService
//                  → AgentPersonaRegistry → personas/index
// AgentPersonaRegistry builds its map at MODULE TOP LEVEL
// (`new Map(BUILT_IN_PERSONAS)`), so whichever of the two loads FIRST decides
// whether this works. Enter via AgentPersonaRegistry and the cycle resolves;
// enter via personas/index and you hit BUILT_IN_PERSONAS in its TDZ. So we go
// through the registry — which is the intended public accessor anyway, and has
// the bonus of seeing custom personas registered at runtime.
async function loadPersona(id: string): Promise<Persona | null> {
  const mod = await import("./AgentPersonaRegistry.ts");
  const registry = mod.default;
  return registry.has(id) ? registry.get(id) : null;
}

/** How this server identifies itself over MCP (see McpAdapter.ts). */
export const MCP_SERVER_NAME = "lazy-tool-service";
const MCP_DISPLAY_NAME = "Lazy Tool Service";

export interface PrismConsumer {
  /** Prism scope — matches the x-project header. */
  project: string;
  /** Prism scope — matches the x-username header. */
  username: string;
  /**
   * Optional persona id from BUILT_IN_PERSONAS (e.g. "HTML_NOTES"). When set,
   * the persona is upserted into Prism as a custom agent so the consumer's
   * runs are TOOL-SCOPED. Without it Prism hands the model its full agentic
   * tool set (~79 tools) and the agent wanders.
   */
  persona?: string;
}

interface McpServerDoc {
  id?: string;
  _id?: string;
  name?: string;
  url?: string;
  enabled?: boolean;
  connected?: boolean;
  toolCount?: number;
}

interface CustomAgentDoc {
  id?: string;
  _id?: string;
  agentId?: string;
  name?: string;
  availableTools?: string[];
}

function scopeHeaders(c: PrismConsumer): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-project": c.project,
    "x-username": c.username,
  };
}

function docId(doc: McpServerDoc | CustomAgentDoc): string | undefined {
  return doc.id || doc._id;
}

function scopeLabel(c: PrismConsumer): string {
  return `${c.project}/${c.username}`;
}

async function callPrism(
  base: string,
  path: string,
  init: RequestInit,
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${base}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The scopes we announce ourselves under when nothing overrides us.
 *
 * These live in CODE, not in projects.json — projects.json is gitignored
 * (it carries secrets), so anything declared only there never reaches the
 * container. A consumer that loses its tool set because its scope sat in an
 * unversioned file is exactly the class of failure this whole change exists
 * to remove. projects.json / PRISM_CONSUMERS can still override for local or
 * one-off setups.
 */
const DEFAULT_CONSUMERS: PrismConsumer[] = [
  { project: "coding", username: "admin" },
  { project: "vllm-trading-bot", username: "lazy-trader" },
  // username MUST match what html-notes actually sends as x-username
  // (AGENT_USERNAME, default "admin"). It was "lazycat" — inherited verbatim
  // from trading-service's old config — so the MCP row landed in a scope the
  // caller never looks at. Tools still resolved (Prism serves them globally
  // once connected) but html-notes' own scope showed zero MCP servers, which
  // is what its health check reported.
  { project: "html-notes-client", username: "admin", persona: "HTML_NOTES" },
];

/**
 * Read the consumer scopes we register for. Declared data, not hardcoded
 * control flow — adding a consuming app is a one-line list edit.
 */
export function loadConsumers(): PrismConsumer[] {
  const raw = process.env.PRISM_CONSUMERS;
  if (!raw) return DEFAULT_CONSUMERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_CONSUMERS;
    return parsed.filter(
      (c: PrismConsumer) => c && typeof c.project === "string" && typeof c.username === "string",
    );
  } catch (err) {
    logger.warn(
      `[Prism-Reg] PRISM_CONSUMERS is not valid JSON, using defaults: ${String(err)}`,
    );
    return DEFAULT_CONSUMERS;
  }
}

/**
 * Ensure the MCP server row exists for this scope and is pointed at our
 * current URL, then connect it.
 */
async function registerMcpServer(
  base: string,
  consumer: PrismConsumer,
  mcpUrl: string,
): Promise<void> {
  const headers = scopeHeaders(consumer);
  const label = scopeLabel(consumer);

  const listRes = await callPrism(base, "/mcp-servers", { method: "GET", headers });
  if (!listRes.ok) {
    throw new Error(`GET /mcp-servers → HTTP ${listRes.status}`);
  }
  const body = (await listRes.json()) as McpServerDoc[] | { servers?: McpServerDoc[] };
  const servers: McpServerDoc[] = Array.isArray(body) ? body : (body?.servers ?? []);
  const existing = servers.find((s) => s.name === MCP_SERVER_NAME);

  const payload = {
    name: MCP_SERVER_NAME,
    displayName: MCP_DISPLAY_NAME,
    transport: "sse",
    url: mcpUrl,
    enabled: true,
  };

  let id = existing ? docId(existing) : undefined;

  if (!existing) {
    const res = await callPrism(base, "/mcp-servers", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`POST /mcp-servers → HTTP ${res.status} ${await res.text()}`);
    }
    id = docId((await res.json()) as McpServerDoc);
    logger.info(`[Prism-Reg] [${label}] created MCP registration ${id}`);
  } else if (existing.url !== mcpUrl || existing.enabled !== true) {
    // Our host/port moved, or somebody disabled us. Repair in place — a new
    // row under the same name would shadow this one.
    const res = await callPrism(base, `/mcp-servers/${id}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`PUT /mcp-servers/${id} → HTTP ${res.status} ${await res.text()}`);
    }
    logger.info(`[Prism-Reg] [${label}] updated MCP registration ${id} → ${mcpUrl}`);
  }

  if (!id) throw new Error("no MCP server id after upsert");

  // Always reconnect, even when the row was already correct: on a redeploy the
  // row survives but the SSE connection does not. This is the whole reason
  // registration belongs to us rather than to a consumer.
  const conn = await callPrism(base, `/mcp-servers/${id}/connect`, { method: "POST", headers });
  if (!conn.ok) {
    throw new Error(`POST /mcp-servers/${id}/connect → HTTP ${conn.status} ${await conn.text()}`);
  }
  logger.success(`[Prism-Reg] [${label}] MCP connected`);
}

/**
 * Upsert a persona into Prism as a custom agent, then READ IT BACK.
 *
 * Prism silently drops `enabledTools` / `thinkingDefault` / `coreToolsLocked`
 * on write, keeping only `availableTools` + `identity` — so a 2xx does not
 * mean the scope we asked for is the scope we got. Verify, don't trust.
 *
 * Note also that Prism derives `agentId` from the NAME: "HTML-Notes Canvas"
 * becomes CUSTOM_HTML_NOTES_CANVAS. Consumers reference that derived id, so
 * the persona's `name` is load-bearing — renaming it breaks the caller.
 */
async function upsertPersona(
  base: string,
  consumer: PrismConsumer,
  persona: Persona,
): Promise<void> {
  const headers = scopeHeaders(consumer);
  const label = scopeLabel(consumer);

  // Client personas take no context (their caller sends the live prompt), but
  // the signature requires one — pass an empty context rather than assume.
  let identity = "";
  try {
    identity =
      typeof persona.identity === "function"
        ? persona.identity({} as Parameters<Persona["identity"]>[0])
        : String(persona.identity ?? "");
  } catch (err) {
    logger.warn(`[Prism-Reg] [${label}] persona identity() threw: ${String(err)}`);
  }
  const payload = {
    name: persona.name,
    description: persona.description ?? "",
    identity: identity ?? "",
    availableTools: persona.availableTools ?? [],
  };

  const listRes = await callPrism(base, "/custom-agents", { method: "GET", headers });
  if (!listRes.ok) {
    throw new Error(`GET /custom-agents → HTTP ${listRes.status}`);
  }
  const body = (await listRes.json()) as CustomAgentDoc[] | { agents?: CustomAgentDoc[] };
  const agents: CustomAgentDoc[] = Array.isArray(body) ? body : (body?.agents ?? []);
  const existing = agents.find((a) => a.name === persona.name);

  let saved: CustomAgentDoc;
  if (existing) {
    const res = await callPrism(base, `/custom-agents/${docId(existing)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`PUT /custom-agents → HTTP ${res.status} ${await res.text()}`);
    }
    saved = (await res.json()) as CustomAgentDoc;
  } else {
    const res = await callPrism(base, "/custom-agents", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`POST /custom-agents → HTTP ${res.status} ${await res.text()}`);
    }
    saved = (await res.json()) as CustomAgentDoc;
    logger.info(`[Prism-Reg] [${label}] created persona ${saved.agentId}`);
  }

  const got = new Set(saved.availableTools ?? []);
  const missing = (persona.availableTools ?? []).filter((t) => !got.has(t));
  if (missing.length) {
    logger.warn(
      `[Prism-Reg] [${label}] persona ${saved.agentId} is missing ${missing.length} ` +
        `tool(s) after write — the agent will run under-scoped: ${missing.join(", ")}`,
    );
  } else {
    logger.success(
      `[Prism-Reg] [${label}] persona ${saved.agentId} verified (${got.size} tools)`,
    );
  }
}

/**
 * Announce this service to Prism for every declared consumer scope.
 *
 * Never throws: a Prism outage must not stop the tool server from booting.
 * Failures are logged per-scope so one bad scope can't take out the others.
 */
export async function registerWithPrism(): Promise<void> {
  if (process.env.PRISM_ENABLED === "false") {
    logger.info("[Prism-Reg] PRISM_ENABLED=false — skipping registration.");
    return;
  }

  const base = (process.env.PRISM_URL || "").replace(/\/$/, "");
  if (!base) {
    logger.warn("[Prism-Reg] PRISM_URL is not set — skipping registration.");
    return;
  }

  const consumers = loadConsumers();
  if (!consumers.length) {
    logger.warn("[Prism-Reg] No PRISM_CONSUMERS declared — nothing to register.");
    return;
  }

  // The URL Prism must dial to reach us. This is our EXTERNAL (host-mapped)
  // port, not the in-container bind port — Prism connects from outside.
  const host = process.env.PRISM_ADVERTISE_HOST || process.env.DEFAULT_HOST || "10.0.0.16";
  const port = process.env.LAZY_TOOL_SERVICE_PORT || "5591";
  const mcpUrl = process.env.MCP_ADVERTISE_URL || `http://${host}:${port}/mcp/sse`;

  logger.info(`[Prism-Reg] Announcing ${MCP_SERVER_NAME} at ${mcpUrl} to ${base}`);

  for (const consumer of consumers) {
    const label = scopeLabel(consumer);
    try {
      await registerMcpServer(base, consumer, mcpUrl);
    } catch (err) {
      logger.warn(`[Prism-Reg] [${label}] MCP registration failed: ${String(err)}`);
      // The persona is useless without tools to scope, so skip it.
      continue;
    }

    if (!consumer.persona) continue;
    try {
      const persona = await loadPersona(consumer.persona);
      if (!persona) {
        logger.warn(`[Prism-Reg] [${label}] unknown persona "${consumer.persona}" — skipped.`);
        continue;
      }
      await upsertPersona(base, consumer, persona);
    } catch (err) {
      logger.warn(`[Prism-Reg] [${label}] persona upsert failed: ${String(err)}`);
    }
  }
}
