// ported from prism-service src/services/mcp/McpOutputCap.ts (no offload store here: past the cap the result is truncated, with a marker)

/**
 * Per-tool output caps for MCP results.
 *
 * An MCP server decides how much text a call returns, and nothing bounded it
 * — one `browser_snapshot` can fill a context window. Past the cap the model
 * gets the head of the result plus an `outputCapped` marker and a note. Unlike
 * prism there is no offload store to page the rest from, so the tail is
 * dropped.
 */

/** Default cap, in estimated tokens (chars / 4), for one MCP tool result. */
export const MCP_OUTPUT_CAP_TOKENS = 25_000;

export interface McpOutputCapSettings {
  outputCapTokens?: number | null;
  toolOutputCapTokens?: Record<string, number> | null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/** The cap for one tool: its own setting, then the server's, then the default. */
export function resolveOutputCapTokens(
  settings: McpOutputCapSettings,
  originalToolName: string,
): number {
  return (
    positiveInteger(settings.toolOutputCapTokens?.[originalToolName]) ??
    positiveInteger(settings.outputCapTokens) ??
    MCP_OUTPUT_CAP_TOKENS
  );
}

/** Errors pass through; an over-cap result keeps its first cap×4 characters. */
export function capMcpToolResult<T extends Record<string, unknown>>(
  result: T,
  capTokens: number,
): T | Record<string, unknown> {
  if (!result || typeof result !== "object" || "error" in result) return result;

  const onlyText = Object.keys(result).length === 1 && typeof result.result === "string";
  const serialized = onlyText
    ? (result.result as string)
    : (JSON.stringify(result, null, 2) ?? "");
  const totalTokens = Math.ceil(serialized.length / 4);
  if (totalTokens <= capTokens) return result;

  return {
    result: serialized.slice(0, capTokens * 4),
    outputCapped: { capTokens, totalTokens },
    note:
      `This result was ~${totalTokens} tokens, over the ${capTokens}-token cap for this tool, ` +
      `so only the first part is shown; the rest was dropped.`,
  };
}
