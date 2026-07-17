import { Persona } from "../types.ts";

/**
 * Universal deep-research agent — the reusable counterpart to the one-off
 * client research personas (MusicResearchPersona). ANY repo can name this agent
 * ("agent": "DEEP_RESEARCH") to run the same decompose → fan-out → synthesize
 * loop instead of re-implementing it: the caller sends the topic AND the output
 * contract (JSON shape) in its system message, and the agent finishes by calling
 * emit_structured_output with data matching that contract.
 *
 * The pattern this centralizes was previously copy-pasted per repo:
 *   - music-player/apps/api/app/services/llm.py (RESEARCH_TOOLS + SSE drain)
 *   - HTML-Notes/app/main.py (build_stock_report_config's in-process fan-out)
 * The client-side glue (POST /agent → drain SSE → pull emit_structured_output)
 * lives once in lazycat-sdk (lazycat/research.py); this is the server-side brain.
 *
 * TOOL SCOPE mirrors the PROVEN music-player research set (live-verified on this
 * gateway 2026-07-17: search_web AND the emit_structured_output finish both
 * execute and return real content), minus get_music which is music-specific:
 *   - search_web / read_url / read_web_page / search_news — web + news access.
 *     NB: despite an older HTML-Notes config comment calling search_web "dead",
 *     it executes on the gateway; lazy_web_search is deliberately omitted to keep
 *     the model from dithering between two web tools (music-player's choice too).
 *   - create_subagents / get_subagent_output — fan a broad topic into parallel
 *     sub-researchers (divide_and_conquer topology) and collect their findings.
 *   - emit_structured_output — the schema-shaped finish that survives the
 *     iteration cap and token truncation (narration text often gets cut first).
 *
 * thinkingDefault is false to keep the reasoning-event flood off fleet-wide; a
 * caller that wants deliberation sends thinkingEnabled:true on the request — the
 * request always wins.
 */
const DEEP_RESEARCH_TOOLS = [
  "emit_structured_output",
  "search_web",
  "read_url",
  "read_web_page",
  "search_news",
  "create_subagents",
  "get_subagent_output",
];

export const DeepResearchPersona: Persona = {
  id: "DEEP_RESEARCH",
  name: "Deep Research",
  type: "client",
  // Universal, not owned by one repo — kept generic so any project can call it.
  project: "shared",
  description:
    "Universal research agent: decomposes a topic, fans out parallel sub-researchers over the web/news, dedups, synthesizes, and finishes with emit_structured_output matching the caller's contract.",
  identity: () =>
    "You are a rigorous research agent. The caller's system message carries the " +
    "TASK and the exact OUTPUT CONTRACT (a JSON shape) — follow it exactly. " +
    "Method: (1) break the topic into a few concrete sub-questions; (2) for a " +
    "broad topic, spawn parallel sub-researchers with create_subagents using the " +
    "divide_and_conquer topology (e.g. one per sub-question/angle) and collect " +
    "them with get_subagent_output — for a narrow topic just research directly; " +
    "(3) gather evidence with search_web / search_news and READ the promising " +
    "pages with read_url / read_web_page — never answer from memory alone; " +
    "(4) dedup and cross-check across sources, keeping only claims the sources " +
    "support and citing concrete names, figures, and dates; (5) synthesize. " +
    "You have a limited step budget — before it runs out, STOP researching and " +
    "finish: fewer well-supported findings beat padding with fabrication. " +
    "ALWAYS finish by calling emit_structured_output with the requested JSON as " +
    "its `data` argument. If a tool errors, try a different tool rather than " +
    "giving up, and never repeat a query you already ran.",
  guidelines: "",
  interactionRules: "",
  toolPolicy: "",
  availableTools: DEEP_RESEARCH_TOOLS,
  capabilities: "",
  coreToolsLocked: false,
  compactToolDocs: false,
  thinkingDefault: false,
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};
