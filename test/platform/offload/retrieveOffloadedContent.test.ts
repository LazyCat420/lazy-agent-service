import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OffloadStore } from "../../../src/platform/offload/OffloadStore.ts";
import {
  RETRIEVAL_MAX_CHARS,
  retrieveOffloadedContentTool,
} from "../../../src/platform/offload/retrieveOffloadedContent.ts";

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "offload-retrieve-"));

afterAll(() => fs.rmSync(rootDir, { recursive: true, force: true }));

function tempStore(): OffloadStore {
  return new OffloadStore({ dir: path.join(rootDir, crypto.randomUUID()) });
}

describe("retrieve_offloaded_content", () => {
  it("exposes a definition with the required offload_id schema", () => {
    const { definition } = retrieveOffloadedContentTool(tempStore());
    expect(definition.name).toBe("retrieve_offloaded_content");
    expect(definition.parameters.type).toBe("object");
    expect(definition.parameters.required).toEqual(["offload_id"]);
    expect(definition.parameters).toHaveProperty("properties.byte_range");
  });

  it("returns the stored payload for a known id", async () => {
    const store = tempStore();
    const tool = retrieveOffloadedContentTool(store);
    const payload = JSON.stringify({ ticker: "TSLA", candles: [1, 2, 3] }, null, 2);
    const record = await store.put({ tool_name: "get_candles", full_result: payload, run_id: "run-9" });

    const output = await tool.execute({ offload_id: record.offload_id });
    expect(output).toContain("[Offloaded result from get_candles");
    expect(output).toContain("run-9");
    expect(output).toContain(payload);
  });

  it("slices by byte_range and caps a single response", async () => {
    const store = tempStore();
    const tool = retrieveOffloadedContentTool(store);
    const record = await store.put({ tool_name: "big_tool", full_result: "abcdefghij" });

    const ranged = await tool.execute({
      offload_id: record.offload_id,
      byte_range: { start: 2, end: 6 },
    });
    expect(ranged).toContain("characters 2–6 of 10");
    expect(ranged).toContain("\ncdef");

    const record2 = await store.put({ tool_name: "huge_tool", full_result: "z".repeat(RETRIEVAL_MAX_CHARS + 100) });
    const capped = await tool.execute({ offload_id: record2.offload_id });
    expect(capped).toContain(`characters 0–${RETRIEVAL_MAX_CHARS} of ${RETRIEVAL_MAX_CHARS + 100}`);
    expect(capped).toContain("more characters follow");
  });

  it("reports a miss for an unknown id", async () => {
    const tool = retrieveOffloadedContentTool(tempStore());
    const output = await tool.execute({ offload_id: crypto.randomUUID() });
    expect(output).toContain("no offloaded result with offload_id");
  });

  it("rejects bad ids: empty, whitespace, and non-string values", async () => {
    const tool = retrieveOffloadedContentTool(tempStore());
    for (const bad of ["", "   ", undefined, 12345, { offload_id: "x" }]) {
      const output = await tool.execute({ offload_id: bad as never });
      expect(output).toContain("offload_id is required");
    }
  });
});
