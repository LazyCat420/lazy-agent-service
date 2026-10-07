// ────────────────────────────────────────────────────────────
// resolveToolEntriesToSet — Shared DSL Expansion Utility
// ────────────────────────────────────────────────────────────
// Resolves an array of tool entry strings into a Set of concrete
// tool names by expanding prefix-based entries:
//
//   - "domainKey:workspace"     → all tools with domainKey === "workspace"
//   - "domain:Core Harness Tools"       → all tools with domain === "Core Harness Tools"
//   - "evaluate_expression"       → exact tool name passthrough
//
// Used by AgenticToolResolver, SystemPromptAssembler, and ConfigRoutes
// to avoid duplicating prefix expansion logic.
// ────────────────────────────────────────────────────────────
export function resolveToolEntriesToSet(entries, schemas) {
    const resolvedSet = new Set();
    for (const entry of entries) {
        if (entry.startsWith("domainKey:")) {
            const domainKey = entry.slice(10);
            for (const toolSchema of schemas) {
                if (toolSchema.domainKey === domainKey)
                    resolvedSet.add(toolSchema.name);
            }
        }
        else if (entry.startsWith("domain:")) {
            const domain = entry.slice(7);
            for (const toolSchema of schemas) {
                if (toolSchema.domain === domain)
                    resolvedSet.add(toolSchema.name);
            }
        }
        else {
            resolvedSet.add(entry);
        }
    }
    return resolvedSet;
}
//# sourceMappingURL=resolveToolEntriesToSet.js.map