import { Persona } from "../types.ts";

/**
 * Tailor-made agent for the HTML-Notes live dashboard canvas (:8035).
 *
 * HTML-Notes is a widget router: classify the request, call the matching data
 * tool, spawn the widget. It sends its own routing prompt (with live canvas
 * state) on every message, so the identity here stays to one paragraph — the
 * persona's job is the tool scope and the lean defaults, not the instructions.
 *
 * Before this persona existed the request ran in direct mode as the generic
 * "Omni Agent": 30 CORE_AGENTIC_TOOLS (execute_python, create_skill,
 * enter_worktree, ...) plus 5 orchestrator tools were force-documented into
 * the system prompt alongside the 18 widget tools, and the blanket
 * thinkingEnabled=true default made Qwen3.6 stream ~180 <think> chunks before
 * its first tool call. None of that has anything to do with putting a stock
 * card on a dashboard.
 */
const HTML_NOTES_TOOLS = [
  "mcp__lazy-tool-service__html_notes_create_note",
  "mcp__lazy-tool-service__html_notes_update_note",
  "mcp__lazy-tool-service__html_notes_get_note",
  "mcp__lazy-tool-service__html_notes_search_notes",
  "mcp__lazy-tool-service__html_notes_link_notes",
  "mcp__lazy-tool-service__canvas_read_dom",
  "mcp__lazy-tool-service__canvas_add_widget",
  "mcp__lazy-tool-service__canvas_modify_dom",
  "mcp__lazy-tool-service__html_notes_youtube_search",
  "mcp__lazy-tool-service__create_widget",
  "mcp__lazy-tool-service__update_widget",
  "mcp__lazy-tool-service__validate_widget_html",
  "mcp__lazy-tool-service__list_widget_types",
  "mcp__lazy-tool-service__plan_widget",
  "mcp__lazy-tool-service__html_notes_web_search",
  "mcp__lazy-tool-service__html_notes_read_page",
  "mcp__lazy-tool-service__html_notes_stock_history",
  "mcp__lazy-tool-service__html_notes_sports_scores",
  // Added when this file became the source of truth for the Prism-side agent
  // (PrismRegistrationService). The hand-registered CUSTOM_HTML_NOTES_CANVAS
  // had drifted to 21 tools while this list still said 18 — upserting from
  // here without these would have silently un-scoped news/weather on a live
  // agent. That drift is exactly what generating from one source prevents.
  "mcp__lazy-tool-service__html_notes_news",
  "mcp__lazy-tool-service__html_notes_get_weather",
  "mcp__lazy-tool-service__html_notes_stock_news",
];

export const HtmlNotesPersona: Persona = {
  id: "HTML_NOTES",
  name: "HTML-Notes Canvas",
  type: "client",
  description:
    "Widget router for the HTML-Notes live dashboard. Scoped to the canvas/widget tool set; no core-tool injection, no thinking.",
  project: "html-notes-client",
  identity: () =>
    "You drive a live dashboard canvas by calling tools. The caller's system message carries the routing rules and current canvas state; follow it exactly.",
  guidelines: "",
  interactionRules: "",
  toolPolicy: "",
  availableTools: HTML_NOTES_TOOLS,
  capabilities: "",
  // The whole point: no forced core/orchestrator tools in prompt or schema,
  // full parameter docs for the widget tools it does have, and no <think>
  // preamble — a router's latency budget is the user staring at a spinner.
  coreToolsLocked: false,
  compactToolDocs: false,
  thinkingDefault: false,
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};
