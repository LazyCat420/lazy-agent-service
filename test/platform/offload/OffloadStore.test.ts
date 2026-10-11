import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OffloadRecordTooLargeError,
  OffloadStore,
  deriveOffloadId,
  getSharedOffloadStore,
} from "../../../src/platform/offload/OffloadStore.ts";

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "offload-store-"));

afterAll(() => fs.rmSync(rootDir, { recursive: true, force: true }));

function tempStore(options: { maxEntries?: number; maxEntryBytes?: number } = {}): OffloadStore {
  return new OffloadStore({ dir: path.join(rootDir, crypto.randomUUID()), ...options });
}

describe("OffloadStore", () => {
  it("round-trips a record through memory and the JSON file", async () => {
    const dir = path.join(rootDir, crypto.randomUUID());
    const store = new OffloadStore({ dir });
    const payload = JSON.stringify({ rows: Array.from({ length: 50 }, (_, i) => i) }, null, 2);
    const record = await store.put({
      tool_name: "query_database",
      args_summary: "SELECT * FROM trades LIMIT 50",
      full_result: payload,
      run_id: "run-42",
    });

    expect(record.offload_id).toBe(deriveOffloadId("query_database", payload));
    expect(record.full_result).toBe(payload);
    expect(record.created_at).toBeTruthy();
    expect(record.run_id).toBe("run-42");

    const fetched = await store.get(record.offload_id);
    expect(fetched?.tool_name).toBe("query_database");
    expect(fetched?.args_summary).toBe("SELECT * FROM trades LIMIT 50");
    expect(fetched?.full_result).toBe(payload);

    // A fresh instance over the same directory reads the same record back.
    const reopened = new OffloadStore({ dir });
    const persisted = await reopened.get(record.offload_id);
    expect(persisted?.full_result).toBe(payload);
    expect(fs.existsSync(store.fileFor(record.offload_id))).toBe(true);
  });

  it("finds an id written by another instance after this one loaded (audit D2)", async () => {
    const dir = path.join(rootDir, crypto.randomUUID());
    const writer = new OffloadStore({ dir });
    const reader = new OffloadStore({ dir });
    const a = await writer.put({ tool_name: "t", full_result: "A" });
    expect((await reader.get(a.offload_id))?.full_result).toBe("A");
    const b = await writer.put({ tool_name: "t", full_result: "B" });
    expect((await reader.get(b.offload_id))?.full_result).toBe("B");
  });

  it("writes only the new record's file on put", async () => {
    const dir = path.join(rootDir, crypto.randomUUID());
    const store = new OffloadStore({ dir });
    const a = await store.put({ tool_name: "t", full_result: "A" });
    const before = fs.statSync(store.fileFor(a.offload_id)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.put({ tool_name: "t", full_result: "B" });
    expect(fs.statSync(store.fileFor(a.offload_id)).mtimeMs).toBe(before);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("survives concurrent puts with no tmp-file collision", async () => {
    const store = tempStore();
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.put({ tool_name: "t", full_result: `p${i}` })),
    );
    for (const r of records) expect((await store.get(r.offload_id))?.full_result).toBe(r.full_result);
  });

  it("migrates the legacy single-file store", async () => {
    const dir = path.join(rootDir, crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    const id = deriveOffloadId("legacy", "old");
    fs.writeFileSync(
      path.join(dir, "offload_store.json"),
      JSON.stringify([{ offload_id: id, tool_name: "legacy", args_summary: "", full_result: "old", created_at: "x", run_id: null }]),
    );
    const store = new OffloadStore({ dir });
    expect((await store.get(id))?.full_result).toBe("old");
    expect(fs.existsSync(path.join(dir, "offload_store.json"))).toBe(false);
  });

  it("shares one process-wide store", () => {
    expect(getSharedOffloadStore()).toBe(getSharedOffloadStore());
  });

  it("returns undefined for unknown ids", async () => {
    const store = tempStore();
    expect(await store.get(crypto.randomUUID())).toBeUndefined();
  });

  it("evicts the least-recently-used entry past maxEntries", async () => {
    const store = tempStore({ maxEntries: 3 });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const record = await store.put({ tool_name: `tool_${i}`, full_result: `payload-${i}` });
      ids.push(record.offload_id);
    }
    expect(await store.size()).toBe(3);
    expect(await store.get(ids[0])).toBeUndefined();
    expect((await store.get(ids[3]))?.full_result).toBe("payload-3");
  });

  it("counts reads toward recency, so touched entries survive", async () => {
    const small = tempStore({ maxEntries: 3 });
    const [a, b, c] = [
      await small.put({ tool_name: "a", full_result: "A" }),
      await small.put({ tool_name: "b", full_result: "B" }),
      await small.put({ tool_name: "c", full_result: "C" }),
    ];
    // Reading `a` makes it more recent than `b`; the next put must evict `b`.
    expect((await small.get(a.offload_id))?.full_result).toBe("A");
    await small.put({ tool_name: "d", full_result: "D" });
    expect(await small.get(b.offload_id)).toBeUndefined();
    expect((await small.get(a.offload_id))?.full_result).toBe("A");
    expect((await small.get(c.offload_id))?.full_result).toBe("C");
  });

  it("refuses payloads over the per-entry byte cap", async () => {
    const store = tempStore({ maxEntryBytes: 64 });
    await expect(
      store.put({ tool_name: "huge_tool", full_result: "z".repeat(65) }),
    ).rejects.toBeInstanceOf(OffloadRecordTooLargeError);
  });

  it("stores the same payload under the same id without duplicating entries", async () => {
    const store = tempStore();
    const payload = "identical output";
    const first = await store.put({ tool_name: "t", full_result: payload });
    const second = await store.put({ tool_name: "t", full_result: payload });
    expect(second.offload_id).toBe(first.offload_id);
    expect(await store.size()).toBe(1);
  });
});
