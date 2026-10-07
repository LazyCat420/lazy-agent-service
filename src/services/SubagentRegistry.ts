import fs from "node:fs";
import path from "node:path";
import logger from "../utils/logger.ts";

// ────────────────────────────────────────────────────────────
// SubagentRegistry — markdown-defined subagents (Claude Code
// sub-agents pattern, PLAN_claude_code.md §3).
//
// Each subagent is `<repoRoot>/subagents/<name>.md` with YAML-ish
// frontmatter:
//
//   ---
//   name: explore
//   description: Read-only codebase researcher for quick lookups.
//   tools: read, grep, glob
//   model: glm-5
//   permissionMode: default
//   ---
//
//   System prompt body...
//
// `list()` returns name+description only (for the delegator's prompt —
// descriptions must stay small); `get(name)` returns the full definition.
// ────────────────────────────────────────────────────────────

/** Claude Code warns when the total subagent description payload exceeds this. */
export const MAX_TOTAL_DESCRIPTION_CHARS = 15000;

export interface SubagentDefinition {
  name: string;
  description: string;
  /** Tool allowlist; "all" means unrestricted. */
  tools: string[] | "all";
  model?: string;
  permissionMode?: string;
  /** Body of the markdown file — the subagent's system prompt. */
  systemPrompt: string;
}

export interface SubagentSummary {
  name: string;
  description: string;
}

interface RegistryCache {
  definitions: Map<string, SubagentDefinition>;
  dir: string;
}

let cache: RegistryCache | null = null;

/** Parse `tools:` frontmatter — comma-separated list or the literal "all". */
function parseTools(raw: string | undefined): string[] | "all" {
  const value = (raw || "").trim();
  if (!value || value === "all" || value === "*") return "all";
  const list = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : "all";
}

/** Minimal frontmatter parser — `key: value` lines between --- fences. */
export function parseSubagentMarkdown(source: string, fallbackName: string): SubagentDefinition | null {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatterBlock, body] = match;

  const fields = new Map<string, string>();
  for (const line of frontmatterBlock.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) fields.set(key, value);
  }

  const name = fields.get("name") || fallbackName;
  const description = fields.get("description") || "";
  if (!description) return null;

  const definition: SubagentDefinition = {
    name,
    description,
    tools: parseTools(fields.get("tools")),
    systemPrompt: body.trim(),
  };
  const model = fields.get("model");
  if (model) definition.model = model;
  const permissionMode = fields.get("permissionMode");
  if (permissionMode) definition.permissionMode = permissionMode;
  return definition;
}

function loadDefinitions(dir: string): Map<string, SubagentDefinition> {
  const definitions = new Map<string, SubagentDefinition>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".md"));
  } catch {
    return definitions;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const source = fs.readFileSync(file, "utf-8");
      const definition = parseSubagentMarkdown(source, path.basename(entry, ".md"));
      if (definition) definitions.set(definition.name, definition);
    } catch (error) {
      logger.warn(
        `[SubagentRegistry] Failed to parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return definitions;
}

export const SubagentRegistry = {
  // Default location: `<repoRoot>/subagents`. Repo root = process cwd;
  // SUBAGENTS_DIR overrides (tests, alternate installs).
  reload(dir?: string): void {
    const resolved = dir || process.env.SUBAGENTS_DIR || path.resolve(process.cwd(), "subagents");
    cache = { definitions: loadDefinitions(resolved), dir: resolved };
  },

  /** name + description only — the delegator's dispatch payload. */
  list(): SubagentSummary[] {
    if (!cache) SubagentRegistry.reload();
    return [...cache!.definitions.values()]
      .map(({ name, description }) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  /** Full definition, or null when unknown. */
  get(name: string): SubagentDefinition | null {
    if (!cache) SubagentRegistry.reload();
    return cache!.definitions.get(name) || null;
  },

  /** Delegation is available only when at least one definition exists. */
  isEnabled(): boolean {
    if (!cache) SubagentRegistry.reload();
    return cache!.definitions.size > 0;
  },

  totalDescriptionChars(): number {
    return SubagentRegistry.list().reduce(
      (total, entry) => total + entry.description.length,
      0,
    );
  },

  /**
   * Warn when the total description payload exceeds Claude Code's 15k
   * threshold (prompt-bloat signal). Returns whether the threshold was hit.
   */
  warnIfDescriptionsTooLarge(): boolean {
    const total = SubagentRegistry.totalDescriptionChars();
    if (total <= MAX_TOTAL_DESCRIPTION_CHARS) return false;
    logger.warn(
      `[SubagentRegistry] Total subagent description size ${total} chars exceeds ${MAX_TOTAL_DESCRIPTION_CHARS} — trim descriptions to keep the delegator's prompt small.`,
    );
    return true;
  },
};

export default SubagentRegistry;
