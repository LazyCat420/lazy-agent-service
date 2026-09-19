import { afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../src/services/RunStore.ts";
const directory = mkdtempSync(join(tmpdir(), "runtime-test-"));
RunStore.setPersistenceFile(join(directory, "runs.json"));
vi.stubGlobal("fetch", async () => { throw new Error("External fetch disabled in tests; supply a fixture"); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
