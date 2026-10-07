// Fetches from the outside world, changes nothing.
const READS_THE_WEB = { readOnlyHint: true, openWorldHint: true };
// Reads this service's own stores and never leaves the desk.
const READS_OWN_STORE = { readOnlyHint: true, openWorldHint: false };
// Appends versioned rows to this service's own Mongo; never deletes or overwrites.
const APPENDS_TO_OWN_STORE = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
};
export const MCP_TOOL_ANNOTATIONS = {
    // Stage 1 (2026-09-28)
    scrape_url: READS_THE_WEB,
    whiteboard_write: APPENDS_TO_OWN_STORE,
    whiteboard_annotate: APPENDS_TO_OWN_STORE,
    // Stage 2 (2026-09-28): free-text queries that repeat a headline or an equation name
    lazy_web_search: READS_THE_WEB,
    search_equations: READS_OWN_STORE,
    // Stage 4 (2026-09-29): an industry or sector name copied from an earlier result into a
    // screener filter (11 of the 39 calls the gate still denied over 30 days of production)
    screener_query: READS_OWN_STORE,
};
export function annotationsFor(toolName) {
    const found = MCP_TOOL_ANNOTATIONS[toolName];
    return found ? { ...found } : undefined;
}
// The exact object the ListTools handler returns for one catalog entry.
export function toMcpTool(t) {
    const annotations = annotationsFor(t.name);
    return {
        name: t.name,
        description: t.description || "",
        inputSchema: t.parameters || { type: "object", properties: {} },
        ...(annotations ? { annotations } : {}),
    };
}
//# sourceMappingURL=McpToolAnnotations.js.map