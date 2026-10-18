import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../RunStore.ts";
import type { RunRecord, RunEvent } from "../../types/run.ts";
import logger from "../../utils/logger.ts";

let tempFile: string;

function makeRun(id: string): RunRecord {
  return {
    run_id: id,
    status: "admitted",
    profile_id: "test-profile",
    profile_version: "1",
    created_at: new Date().toISOString(),
    current_turn: 0,
    input: {},
    messages: [],
    usage: {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      tool_calls_count: 0,
      retry_count: 0,
    },
    evidence_records: [],
    events: [],
  };
}

function makeEvent(id: string, runId: string): RunEvent {
  return {
    id,
    run_id: runId,
    type: "run.created",
    data: {},
    timestamp: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  tempFile = path.join(os.tmpdir(), `runstore-flush-${process.pid}-${Date.now()}-${Math.random()}.json`);
  RunStore.setPersistenceFile(tempFile);
  RunStore.clearAll();
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const f of [tempFile, `${tempFile}.tmp`]) {
    try { fs.unlinkSync(f); } catch { /* not present */ }
  }
});

describe("RunStore event flush coalescing", () => {
  it("T1: coalesces 100 event appends into a single flush", async () => {
    const id = "run-t1";
    await RunStore.createRun(makeRun(id));
    const spy = vi.spyOn(fs, "writeFileSync");
    spy.mockClear();

    for (let i = 0; i < 100; i++) {
      await RunStore.appendEvent(makeEvent(`evt-${i}`, id));
    }
    expect(spy).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);

    const run = await RunStore.getRun(id);
    expect(run?.events?.length).toBe(100);
  });

  it("T2: state updates flush immediately and cancel a pending event flush", async () => {
    const id = "run-t2";
    await RunStore.createRun(makeRun(id));
    const spy = vi.spyOn(fs, "writeFileSync");
    spy.mockClear();

    await RunStore.appendEvent(makeEvent("evt-1", id));
    await RunStore.updateState(id, "running");
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);

    const callsAfterState = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy.mock.calls.length).toBe(callsAfterState);
  });

  it("T3: flushed file on disk matches in-memory events", async () => {
    const id = "run-t3";
    await RunStore.createRun(makeRun(id));
    const spy = vi.spyOn(fs, "writeFileSync");
    spy.mockClear();

    for (let i = 0; i < 10; i++) {
      await RunStore.appendEvent(makeEvent(`evt-${i}`, id));
    }
    await vi.advanceTimersByTimeAsync(1000);

    const data = JSON.parse(fs.readFileSync(tempFile, "utf-8")) as { runs: RunRecord[] };
    const flushed = data.runs.find((r) => r.run_id === id);
    expect(flushed?.events?.length).toBe(10);

    const run = await RunStore.getRun(id);
    expect(run?.events?.length).toBe(flushed?.events?.length);
  });
});
