import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OffloadRecordTooLargeError,
  OffloadStore,
  deriveOffloadId,
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
    expect(fs.existsSync(path.join(dir, "offload_store.json"))).toBe(true);
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
