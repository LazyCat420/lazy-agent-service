import type { ToolDefinition } from "./types.ts";

export const DEFAULT_MAX_SPILL_BYTES = 4 * 1024 * 1024; // 4 MiB per run
export const READ_TOOL_SPILL_NAME = "read_tool_spill";
export const MAX_SPILL_READ_CHARS = 16_000;
export const DEFAULT_SPILL_READ_CHARS = 8_000;

export const READ_TOOL_SPILL_SCHEMA: ToolDefinition = {
  name: READ_TOOL_SPILL_NAME,
  description:
    "Read a character slice from a large tool output that was truncated and stored in the run-scoped SpillBuffer.",
  parameters: {
    type: "object",
    properties: {
      spill_id: {
        type: "string",
        description: 'Spill identifier from the truncation notice (e.g. "spill_1").',
      },
      offset: {
        type: "integer",
        description: "0-based character offset to start reading from (default 0).",
      },
      length: {
        type: "integer",
        description: "Maximum number of characters to return (default 8000, max 16000).",
      },
    },
    required: ["spill_id"],
  },
};

export type SpillReadResult =
  | {
      ok: true;
      spill_id: string;
      content: string;
      offset: number;
      length: number;
      totalChars: number;
      hasMore: boolean;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * H5: Run-scoped in-memory two-tier tool output spill buffer.
 *
 * Holds full tool outputs when `ToolRunner` truncates an observation above
 * `toolOutputCap` (16,000 chars), bounded by `maxTotalBytes` (default 4 MiB)
 * and cleared unconditionally in `runCoreLoop`'s `finally` block so zero
 * temporary files or memory leak across runs.
 */
export class SpillBuffer {
  private readonly entries = new Map<string, { content: string; bytes: number }>();
  private totalBytes = 0;
  private nextIndex = 1;
  private readonly maxTotalBytes: number;

  constructor(maxTotalBytes: number = DEFAULT_MAX_SPILL_BYTES) {
    this.maxTotalBytes = Math.max(1024, maxTotalBytes);
  }

  /**
   * Store `content` in the spill buffer under a sequential `spill_N` id.
   * Returns `null` if the single payload exceeds `maxTotalBytes`.
   */
  store(content: string): string | null {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxTotalBytes) {
      return null;
    }

    // Evict oldest entries (FIFO) until the new entry fits within maxTotalBytes.
    while (this.totalBytes + bytes > this.maxTotalBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) {
        this.totalBytes = Math.max(0, this.totalBytes - oldest.bytes);
      }
    }

    const id = `spill_${this.nextIndex++}`;
    this.entries.set(id, { content, bytes });
    this.totalBytes += bytes;
    return id;
  }

  /**
   * Read a character range `[offset, offset + length)` from a stored spill entry.
   */
  read(
    spillId: string,
    offset: number = 0,
    length: number = DEFAULT_SPILL_READ_CHARS,
  ): SpillReadResult {
    const entry = this.entries.get(spillId);
    if (!entry) {
      const available = [...this.entries.keys()];
      return {
        ok: false,
        error: `Unknown or expired spill_id "${spillId}". Available spill_ids: ${available.length > 0 ? available.join(", ") : "none"}.`,
      };
    }

    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const requestedLength = Number.isFinite(length)
      ? Math.floor(length)
      : DEFAULT_SPILL_READ_CHARS;
    const safeLength = Math.max(1, Math.min(MAX_SPILL_READ_CHARS, requestedLength));

    const slice = entry.content.slice(safeOffset, safeOffset + safeLength);
    const nextOffset = safeOffset + slice.length;
    return {
      ok: true,
      spill_id: spillId,
      content: slice,
      offset: safeOffset,
      length: slice.length,
      totalChars: entry.content.length,
      hasMore: nextOffset < entry.content.length,
    };
  }

  has(spillId: string): boolean {
    return this.entries.has(spillId);
  }

  size(): number {
    return this.entries.size;
  }

  bytesUsed(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
