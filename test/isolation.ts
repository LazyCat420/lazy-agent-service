import { afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/services/RunStore.ts";
const directory = mkdtempSync(join(tmpdir(), "runtime-test-"));
RunStore.setPersistenceFile(join(directory, "runs.json"));
const originalFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return originalFetch(input, init);
  throw new Error("External fetch disabled in tests; supply a fixture");
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
