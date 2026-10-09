import type { OffloadStore } from "./OffloadStore.ts";

// ─────────────────────────────────────────────────────────────
//  retrieve_offloaded_content — the recovery half of offloading
//
//  Prism pattern: eviction is recoverable instead of destructive.
//  The model reads the offload_id out of a pointer stub (written
//  by OffloadPolicy) and calls this internal tool to pull back the
//  verbatim payload — whole, or a character range of it. A single
//  response is capped so a retrieval cannot re-flood the context
//  the offload just relieved.
// ─────────────────────────────────────────────────────────────

/** Cap on one retrieval response, prism-compatible (keeps re-flood bounded). */
export const RETRIEVAL_MAX_CHARS = 24_000;

export interface RetrieveOffloadedContentArgs {
  offload_id?: unknown;
  byte_range?: {
    start?: unknown;
    end?: unknown;
  };
}

export interface RetrieveOffloadedContentTool {
  /** Tool definition in the repo's internal-tool shape ({ name, description, parameters }). */
  definition: {
    name: "retrieve_offloaded_content";
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
  /** Executor: resolves the offload_id against the store and returns model-readable text. */
  execute: (args: RetrieveOffloadedContentArgs) => Promise<string>;
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

export function retrieveOffloadedContentTool(store: OffloadStore): RetrieveOffloadedContentTool {
  return {
    definition: {
      name: "retrieve_offloaded_content",
      description:
        "Retrieve a tool result that was too large for context and was offloaded. " +
        "Pass the offload_id named in the truncation note; optionally a byte_range " +
        "(0-based character offsets, end exclusive) to read part of a very large payload.",
      parameters: {
        type: "object",
        properties: {
          offload_id: {
            type: "string",
            description: "The offload_id from the truncation note (e.g. tr_…).",
          },
          byte_range: {
            type: "object",
            description:
              "Optional character range to read (0-based, end exclusive). Omit for the whole payload.",
            properties: {
              start: { type: "number", description: "First character offset (default 0)." },
              end: { type: "number", description: "Offset one past the last character (default end of payload)." },
            },
          },
        },
        required: ["offload_id"],
      },
    },
    async execute(args) {
      const offloadId = typeof args?.offload_id === "string" ? args.offload_id.trim() : "";
      if (!offloadId) {
        return "retrieve_offloaded_content failed: offload_id is required and must be the id from the truncation note.";
      }
      const record = await store.get(offloadId);
      if (!record) {
        return (
          `retrieve_offloaded_content failed: no offloaded result with offload_id "${offloadId}". ` +
          "The id may be mistyped, or the payload was evicted — the store keeps only the most recent entries. " +
          "Re-run the original tool if the data is gone."
        );
      }
      const content = record.full_result;
      let start = 0;
      let end = content.length;
      if (args?.byte_range) {
        const requestedStart = asInt(args.byte_range.start) ?? 0;
        const requestedEnd = asInt(args.byte_range.end) ?? content.length;
        start = Math.min(Math.max(requestedStart, 0), content.length);
        end = Math.min(Math.max(requestedEnd, start), content.length);
      }
      const remaining = content.length - end;
      const capped = end - start > RETRIEVAL_MAX_CHARS;
      const sliceEnd = capped ? start + RETRIEVAL_MAX_CHARS : end;
      const body = content.slice(start, sliceEnd);
      const header = record.run_id
        ? `[Offloaded result from ${record.tool_name} — recorded ${record.created_at}, run ${record.run_id}]`
        : `[Offloaded result from ${record.tool_name} — recorded ${record.created_at}]`;
      const rangeSuffix =
        sliceEnd < content.length
          ? ` (characters ${start}–${sliceEnd} of ${content.length})`
          : "";
      const tail =
        sliceEnd < end
          ? `\n\n[${content.length - sliceEnd} more characters follow — call again with byte_range {start: ${sliceEnd}, end: ${end}}.]`
          : remaining > 0
            ? `\n\n[${remaining} more characters remain — call again with byte_range to read them.]`
            : "";
      return `${header}${rangeSuffix}\n${body}${tail}`;
    },
  };
}
