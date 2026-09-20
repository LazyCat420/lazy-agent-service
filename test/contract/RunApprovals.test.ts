import crypto from "node:crypto";
import { it, expect, beforeEach, vi } from "vitest";
import { RunApprovals } from "../../src/services/RunApprovals.ts";
import { RunStore } from "../../src/services/RunStore.ts";
beforeEach(() => RunStore.clearAll());
it("waits for an explicit scope-bound decision and rejects changed arguments", async () => {
  const id = crypto.randomUUID();
  await RunStore.createRun({ run_id: id, status: "running", profile_id: "fixture", profile_version: "1.0.0", created_at: new Date().toISOString(), current_turn: 0, input: "", messages: [], usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, tool_calls_count: 0, retry_count: 0, duration_ms: 0 }, evidence_records: [] });
  let approvalId = ""; const call = { id: "call", name: "obsidian.delete_note", args: { note_path: "fixture.md" } };
  const promise = RunApprovals.wait(id, call, "obsidian", "vault", new AbortController().signal, event => { approvalId = event.data.id; });
  await vi.waitFor(() => expect(approvalId).not.toBe(""));
  expect(await RunApprovals.permits(id, approvalId, call, "obsidian", "vault")).toBe(false);
  expect(await RunApprovals.resolve(id, approvalId, true)).toEqual({ duplicate: false });
  expect(await promise).toBe(approvalId);
  expect(await RunApprovals.permits(id, approvalId, call, "obsidian", "vault")).toBe(true);
  expect(await RunApprovals.permits(id, approvalId, { ...call, args: { note_path: "other.md" } }, "obsidian", "vault")).toBe(false);
  expect(await RunApprovals.resolve(id, approvalId, true)).toEqual({ duplicate: true });
  await expect(RunApprovals.resolve(id, approvalId, false)).rejects.toThrow("Conflicting");
});
