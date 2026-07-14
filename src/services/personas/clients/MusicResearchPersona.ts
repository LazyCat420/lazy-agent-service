import { Persona } from "../types.ts";

/**
 * Tailor-made agent for music-player's research mode (artist/genre
 * verification sweeps, apps/api/app/services/llm.py). The caller sends the
 * task prompt per-request; this persona pins the tool scope and the lean
 * defaults so the run doesn't carry the Omni identity, the 30 forced core
 * tools, or a <think> stream through up to 15 iterations.
 *
 * Tool list mirrors the caller's RESEARCH_TOOLS with one deliberate omission:
 * mcp__lazy-tool-service__lazy_web_search only resolves when the loop runs on
 * real prism (:7777); on this gateway it resolves to nothing (the caller's own
 * comment says so), so listing it here would be a phantom tool for the model
 * to fail against.
 *
 * thinkingDefault is false to kill the reasoning-event flood fleet-wide; if
 * artist-verification quality measurably drops, the caller can send
 * thinkingEnabled: true on just the research calls — the request always wins.
 */
const MUSIC_RESEARCH_TOOLS = [
  "emit_structured_output",
  "get_music",
  "search_web",
  "read_url",
  "read_web_page",
  "search_news",
  "create_subagents",
  "get_subagent_output",
];

export const MusicResearchPersona: Persona = {
  id: "MUSIC_RESEARCH",
  name: "Music Research",
  type: "client",
  description:
    "Batch research agent for music-player: verifies artists/genres exist via MusicBrainz and web search, finishes with emit_structured_output.",
  project: "music-player",
  identity: () =>
    "You are a music research agent. The caller's system message carries the task and output contract; follow it exactly and finish by calling emit_structured_output.",
  guidelines: "",
  interactionRules: "",
  toolPolicy: "",
  availableTools: MUSIC_RESEARCH_TOOLS,
  capabilities: "",
  coreToolsLocked: false,
  compactToolDocs: false,
  thinkingDefault: false,
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};
