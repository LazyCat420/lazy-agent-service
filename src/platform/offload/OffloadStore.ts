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
//  Storage: one JSON file per offload_id under
//  `data/offload_store/` (configurable), fronted by an in-memory
//  LRU map (max 200 entries, max 5 MB per payload). A put writes
//  only its own file; a get that misses memory reads the id's
//  file, so ids written by another instance or process are found.
//  Use getSharedOffloadStore() — the offload policy, the loop's
//  retrieve tool and the executor must see the same store.
// ─────────────────────────────────────────────────────────────

/** Default cap on stored entries before the least-recently-used one is evicted. */
export const DEFAULT_MAX_ENTRIES = 200;
/** Default cap on a single stored payload, in UTF-8 bytes. */
export const DEFAULT_MAX_ENTRY_BYTES = 5 * 1024 * 1024;
/** Legacy single-file store (pre 2026-10-11), migrated on first load. */
export const OFFLOAD_STORE_FILENAME = "offload_store.json";
const ID_PATTERN = /^tr_[0-9a-f]{24}$/;

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

  /** Absolute path of the file holding one record (exposed for tests and diagnostics). */
  fileFor(offloadId: string): string {
    return path.join(this.dir, `${offloadId}.json`);
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
    await this.writeRecord(record);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      await fsp.rm(this.fileFor(oldest), { force: true });
    }
    return record;
  }

  /** Fetch a stored payload; refreshes its recency. Returns undefined for unknown ids. */
  async get(offloadId: string): Promise<OffloadRecord | undefined> {
    await this.ensureLoaded();
    let record = this.entries.get(offloadId);
    if (!record) {
      // Miss: another instance/process may have written it since we loaded.
      record = ID_PATTERN.test(offloadId) ? await this.readRecord(this.fileFor(offloadId)) : undefined;
      if (!record) return undefined;
    }
    this.entries.delete(offloadId);
    this.entries.set(offloadId, record);
    return record;
  }

  /** Number of currently stored entries. */
  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.entries.size;
  }

  /** Drop every entry and its file. */
  async clear(): Promise<void> {
    await this.ensureLoaded();
    for (const id of this.entries.keys()) await fsp.rm(this.fileFor(id), { force: true });
    this.entries.clear();
  }

  private async readRecord(file: string): Promise<OffloadRecord | undefined> {
    try {
      const record = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<OffloadRecord> | null;
      if (record && typeof record.offload_id === "string" && typeof record.full_result === "string") {
        return record as OffloadRecord;
      }
    } catch {
      // Missing or corrupt → treat as absent.
    }
    return undefined;
  }

  private async writeRecord(record: OffloadRecord): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const target = this.fileFor(record.offload_id);
    const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(record), "utf8");
    await fsp.rename(tmp, target);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return; // no directory yet
    }
    const found: Array<{ record: OffloadRecord; mtime: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !ID_PATTERN.test(name.slice(0, -5))) continue;
      const file = path.join(this.dir, name);
      const record = await this.readRecord(file);
      if (record) found.push({ record, mtime: (await fsp.stat(file)).mtimeMs });
    }
    found.sort((x, y) => x.mtime - y.mtime);
    for (const { record } of found) this.entries.set(record.offload_id, record);
    if (names.includes(OFFLOAD_STORE_FILENAME)) {
      const legacy = path.join(this.dir, OFFLOAD_STORE_FILENAME);
      try {
        const parsed: unknown = JSON.parse(await fsp.readFile(legacy, "utf8"));
        for (const entry of Array.isArray(parsed) ? parsed : []) {
          const record = entry as Partial<OffloadRecord> | null;
          if (record && typeof record.offload_id === "string" && typeof record.full_result === "string" && !this.entries.has(record.offload_id)) {
            this.entries.set(record.offload_id, record as OffloadRecord);
            await this.writeRecord(record as OffloadRecord);
          }
        }
      } catch {
        // corrupt legacy file: nothing to migrate
      }
      await fsp.rm(legacy, { force: true });
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
      await fsp.rm(this.fileFor(oldest), { force: true });
    }
  }
}

let sharedStore: OffloadStore | null = null;

/** The process-wide store (data/offload_store/). Every offload writer and reader must use this one. */
export function getSharedOffloadStore(): OffloadStore {
  sharedStore ??= new OffloadStore();
  return sharedStore;
}
