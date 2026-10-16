// ported from prism-service src/services/mcp/McpToolFingerprint.ts
import crypto from "crypto";

/**
 * Tool pinning — the defense against MCP "rug-pulls".
 *
 * A server can change a tool's description or schema after the owner has
 * looked at it; the changed text then reaches the model with the trust the
 * original earned. Poisoned descriptions succeed 69.5% of the time
 * (arXiv 2608.23763), and fragmenting the payload across description,
 * schema and annotations beats single-channel checks (arXiv 2609.18217), so
 * the fingerprint covers all of them at once.
 *
 * When the owner approves a server, each tool's fingerprint is pinned. A
 * tool whose fingerprint later differs, or that did not exist at approval,
 * is quarantined: hidden from the model and refused if called, until the
 * owner approves it again.
 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
}

export interface McpToolPin {
  hash: string;
  approvedAt: string;
}

export type McpToolPins = Record<string, McpToolPin>;

export type McpQuarantineReason = "changed" | "new" | "duplicate";

export interface McpQuarantinedTool {
  /** The server's own tool name. */
  name: string;
  reason: McpQuarantineReason;
  hash: string;
  /** The pinned fingerprint a `changed` tool no longer matches. */
  pinnedHash?: string;
  /** What the server says now — for the owner to review before approving. */
  description: string;
}

/** Key-sorted JSON, so two equal schemas always hash the same. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** sha256 over (name, description, inputSchema, annotations). */
export function fingerprintMcpTool(tool: McpToolDefinition): string {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? null,
        annotations: tool.annotations ?? null,
      }),
    )
    .digest("hex");
}

export interface McpToolReview<T extends McpToolDefinition> {
  approved: T[];
  quarantined: McpQuarantinedTool[];
  /**
   * The pins to persist when this review approved something new — the
   * first approval of a server. Null when nothing changed.
   */
  pins: McpToolPins | null;
}

/**
 * Sort a server's tools into approved and quarantined.
 *
 * `pins === null` means the server has never been approved: its owner
 * enabled and connected it, which approves the tools it offers at that
 * moment (trust on first use). From then on only `approveMcpTools` adds pins.
 * The caller persists `pins` when it is non-null.
 *
 * `rejected` names are refused outright (duplicates after namespacing) and
 * are never pinned, whatever the pins say.
 */
export function reviewMcpTools<T extends McpToolDefinition>(
  tools: readonly T[],
  pins: McpToolPins | null,
  rejected: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): McpToolReview<T> {
  const approved: T[] = [];
  const quarantined: McpQuarantinedTool[] = [];
  const firstApproval = pins === null;
  const nextPins: McpToolPins = { ...(pins ?? {}) };

  for (const tool of tools) {
    const hash = fingerprintMcpTool(tool);
    const description = tool.description ?? "";
    if (rejected.has(tool.name)) {
      quarantined.push({ name: tool.name, reason: "duplicate", hash, description });
      continue;
    }
    if (firstApproval) {
      nextPins[tool.name] = { hash, approvedAt: now.toISOString() };
      approved.push(tool);
      continue;
    }
    const pin = nextPins[tool.name];
    if (!pin) {
      quarantined.push({ name: tool.name, reason: "new", hash, description });
    } else if (pin.hash !== hash) {
      quarantined.push({ name: tool.name, reason: "changed", hash, pinnedHash: pin.hash, description });
    } else {
      approved.push(tool);
    }
  }

  // An empty first listing (a failed or slow `tools/list`) pins nothing:
  // pinning `{}` would quarantine every tool the server offers afterwards.
  return {
    approved,
    quarantined,
    pins: firstApproval && approved.length > 0 ? nextPins : null,
  };
}

/**
 * Re-pin the named tools at the fingerprints they have now. Names that are
 * not currently offered, or were rejected as duplicates, are skipped and
 * returned so the caller can report them.
 */
export function approveMcpTools(
  tools: readonly McpToolDefinition[],
  pins: McpToolPins | null,
  names: readonly string[] | null,
  rejected: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): { pins: McpToolPins; approved: string[]; skipped: string[] } {
  const offered = new Map(tools.map((tool) => [tool.name, tool]));
  const wanted = names ?? tools.map((tool) => tool.name);
  const nextPins: McpToolPins = { ...(pins ?? {}) };
  const approved: string[] = [];
  const skipped: string[] = [];
  for (const name of wanted) {
    const tool = offered.get(name);
    if (!tool || rejected.has(name)) {
      skipped.push(name);
      continue;
    }
    const hash = fingerprintMcpTool(tool);
    if (nextPins[name]?.hash !== hash) {
      nextPins[name] = { hash, approvedAt: now.toISOString() };
      approved.push(name);
    }
  }
  return { pins: nextPins, approved, skipped };
}
