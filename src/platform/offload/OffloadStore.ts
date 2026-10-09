import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────
//  OffloadStore — lossless tool-result offload (prism pattern)
//
//  When a tool result is too large for the model's context, the
//  full payload is stored here under a stable offload_id and the
//  model gets a pointer stub instead (OffloadPolicy). The model
//  can later recover the payload — whole or by byte range — via
//  retrieve_offloaded_content, so the cut is recoverable instead
//  of destructive.
//
//  Storage: a single JSON file under `data/offload_store/`
//  (configurable), fronted by an in-memory LRU map so retrieval
//  is immediate and the store stays bounded (max 200 entries,
//  max 5 MB per payload).
// ─────────────────────────────────────────────────────────────

/** Default cap on stored entries before the least-recently-used one is evicted. */
export const DEFAULT_MAX_ENTRIES = 200;
/** Default cap on a single stored payload, in UTF-8 bytes. */
export const DEFAULT_MAX_ENTRY_BYTES = 5 * 1024 * 1024;
/** File the store persists to inside its directory. */
export const OFFLOAD_STORE_FILENAME = "offload_store.json";

/** Thrown when a payload exceeds the store's per-entry byte cap. */
export class OffloadRecordTooLargeError extends Error {}

export interface OffloadRecord {
  offload_id: string;
  tool_name: string;
  /** Short human-readable summary of the call arguments (for the offload index). */
  args_summary: string;
  /** The verbatim serialized tool result. */
  full_result: string;
  created_at: string;
  run_id: string | null;
}

export interface OffloadPutInput {
  tool_name: string;
  args_summary?: string;
  full_result: string;
  run_id?: string | null;
}

export interface OffloadStoreOptions {
  /** Store directory override (default: `<repoRoot>/data/offload_store`). */
  dir?: string;
  /** Workspace root used to derive the default directory (default: cwd). */
  repoRoot?: string;
  /** LRU capacity (default: 200). */
  maxEntries?: number;
  /** Per-entry payload cap in bytes (default: 5 MB). */
  maxEntryBytes?: number;
}

/**
 * Derive the offload_id from the tool name and payload, prism-style: the
 * same result always yields the same id, so re-offloading the identical
 * output keeps the model-visible stub byte-identical (prompt-prefix
 * stability) instead of leaking a fresh id into the context every turn.
 */
export function deriveOffloadId(toolName: string, content: string): string {
  return `tr_${crypto
    .createHash("sha256")
    .update(`${toolName}\0${content}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export class OffloadStore {
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  /** Insertion order is recency order: least-recently-used first. */
  private entries = new Map<string, OffloadRecord>();
  private loaded = false;

  constructor(options: OffloadStoreOptions = {}) {
    this.dir =
      options.dir ?? path.join(options.repoRoot ?? process.cwd(), "data", "offload_store");
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  }

  /** Absolute path of the backing file (exposed for tests and diagnostics). */
  get file(): string {
    return path.join(this.dir, OFFLOAD_STORE_FILENAME);
  }

  /** Store a payload under its content-derived id; evicts LRU entries past the cap. */
  async put(input: OffloadPutInput): Promise<OffloadRecord> {
    await this.ensureLoaded();
    const bytes = Buffer.byteLength(input.full_result, "utf8");
    if (bytes > this.maxEntryBytes) {
      throw new OffloadRecordTooLargeError(
        `Refusing to offload ${bytes} bytes (cap ${this.maxEntryBytes}): payload for ${input.tool_name} exceeds the per-entry limit.`,
      );
    }
    const record: OffloadRecord = {
      offload_id: deriveOffloadId(input.tool_name, input.full_result),
      tool_name: input.tool_name,
      args_summary: input.args_summary ?? "",
      full_result: input.full_result,
      created_at: new Date().toISOString(),
      run_id: input.run_id ?? null,
    };
    // Re-inserting moves the id to the most-recently-used position.
    this.entries.delete(record.offload_id);
    this.entries.set(record.offload_id, record);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    await this.persist();
    return record;
  }

  /** Fetch a stored payload; refreshes its recency. Returns undefined for unknown ids. */
  async get(offloadId: string): Promise<OffloadRecord | undefined> {
    await this.ensureLoaded();
    const record = this.entries.get(offloadId);
    if (!record) return undefined;
    this.entries.delete(offloadId);
    this.entries.set(offloadId, record);
    return record;
  }

  /** Number of currently stored entries. */
  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.entries.size;
  }

  /** Drop every entry and the backing file. */
  async clear(): Promise<void> {
    this.entries.clear();
    this.loaded = true;
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fsp.readFile(this.file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        const record = entry as Partial<OffloadRecord> | null;
        if (
          record &&
          typeof record.offload_id === "string" &&
          typeof record.full_result === "string"
        ) {
          this.entries.set(record.offload_id, record as OffloadRecord);
        }
      }
    } catch {
      // Missing or corrupt file → start empty; the next persist rewrites it.
    }
  }

  private async persist(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify([...this.entries.values()]), "utf8");
    await fsp.rename(tmp, this.file);
  }
}
