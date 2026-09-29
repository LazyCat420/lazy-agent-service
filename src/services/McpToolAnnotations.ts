// MCP tool annotations, in the vocabulary prism's approval gate reads.
// Prism denies an unannotated MCP tool (network + side effect) whenever its
// arguments repeat 24+ characters of an earlier tool result. A tool listed here
// says what it really does, so the gate no longer treats it as the dangerous kind.
// Tools NOT listed keep a byte-identical listing (same pin, no re-approval).
// Rationale and rollout: trading-client documentation, chapter 07-agent-tools.
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Fetches from the outside world, changes nothing.
const READS_THE_WEB: McpToolAnnotations = { readOnlyHint: true, openWorldHint: true };

// Reads this service's own stores and never leaves the desk.
const READS_OWN_STORE: McpToolAnnotations = { readOnlyHint: true, openWorldHint: false };

// Appends versioned rows to this service's own Mongo; never deletes or overwrites.
const APPENDS_TO_OWN_STORE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

export const MCP_TOOL_ANNOTATIONS: Readonly<Record<string, McpToolAnnotations>> = {
  // Stage 1 (2026-09-28)
  scrape_url: READS_THE_WEB,
  whiteboard_write: APPENDS_TO_OWN_STORE,
  whiteboard_annotate: APPENDS_TO_OWN_STORE,
  // Stage 2 (2026-09-28): free-text queries that repeat a headline or an equation name
  lazy_web_search: READS_THE_WEB,
  search_equations: READS_OWN_STORE,
};

export function annotationsFor(toolName: string): McpToolAnnotations | undefined {
  const found = MCP_TOOL_ANNOTATIONS[toolName];
  return found ? { ...found } : undefined;
}

type CatalogTool = { name: string; description?: string; parameters?: unknown };

// The exact object the ListTools handler returns for one catalog entry.
export function toMcpTool(t: CatalogTool) {
  const annotations = annotationsFor(t.name);
  return {
    name: t.name,
    description: t.description || "",
    inputSchema: t.parameters || { type: "object", properties: {} },
    ...(annotations ? { annotations } : {}),
  };
}
