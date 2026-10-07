import { describe, it, expect } from "vitest";
import {
  createSessionState,
  applyObservation,
  serializeSessionState,
  sessionStateContextBlock,
  sessionStateHash,
} from "../SessionState.ts";
import AgentHooks from "../AgentHooks.ts";

describe("SessionState", () => {
  it("starts empty with a startedAt timestamp", () => {
    const state = createSessionState("2026-10-07T00:00:00.000Z");
    expect(state).toEqual({
      openFiles: [],
      lastTool: "",
      lastError: null,
      toolCallCount: 0,
      startedAt: "2026-10-07T00:00:00.000Z",
    });
  });

  it("updates lastTool and toolCallCount from observations", () => {
    let state = createSessionState("2026-10-07T00:00:00.000Z");
    state = applyObservation(state, "read_file", { path: "/a.ts", content: "..." });
    state = applyObservation(state, "write_file", { path: "/a.ts", ok: true });
    expect(state.lastTool).toBe("write_file");
    expect(state.toolCallCount).toBe(2);
  });

  it("records lastError from error observations and clears it on success", () => {
    let state = createSessionState("2026-10-07T00:00:00.000Z");
    state = applyObservation(state, "run_command", { error: "exit code 1", is_error: true });
    expect(state.lastError).toBe("exit code 1");
    state = applyObservation(state, "read_file", { path: "/a.ts" });
    expect(state.lastError).toBeNull();
  });

  it("tracks openFiles in MRU order from observation path fields", () => {
    let state = createSessionState("2026-10-07T00:00:00.000Z");
    state = applyObservation(state, "read_file", { path: "/a.ts" });
    state = applyObservation(state, "read_file", { path: "/b.ts", filePath: undefined });
    state = applyObservation(state, "read_file", { file: "/a.ts" });
    expect(state.openFiles).toEqual(["/b.ts", "/a.ts"]);
    expect(state.toolCallCount).toBe(3);
  });

  it("records a write-rejection observation as lastError", () => {
    let state = createSessionState("2026-10-07T00:00:00.000Z");
    state = applyObservation(
      state,
      "write_file",
      "Write rejected: /a.json does not parse (Unexpected end of JSON input). Fix the syntax and retry.",
    );
    expect(state.lastError).toContain("Write rejected: /a.json does not parse");
  });

  it("never observes paths from non-object observations", () => {
    let state = createSessionState("2026-10-07T00:00:00.000Z");
    state = applyObservation(state, "web_search", "plain text result");
    expect(state.openFiles).toEqual([]);
    expect(state.lastError).toBeNull();
  });

  it("serializes compactly and deterministically", () => {
    const state = applyObservation(
      createSessionState("2026-10-07T00:00:00.000Z"),
      "write_file",
      { path: "/a.json", error: "boom", is_error: true },
    );
    const serialized = serializeSessionState(state);
    expect(serialized).toBe(
      '{"openFiles":["/a.json"],"lastTool":"write_file","lastError":"boom","toolCallCount":1,"startedAt":"2026-10-07T00:00:00.000Z"}',
    );
    // Deterministic: identical state → identical string.
    expect(serializeSessionState(applyObservation(
      createSessionState("2026-10-07T00:00:00.000Z"),
      "write_file",
      { path: "/a.json", error: "boom", is_error: true },
    ))).toBe(serialized);
    expect(serializeSessionState(state)).not.toMatch(/\s/);
    expect(JSON.parse(serialized)).toEqual(state);
  });

  it("caps openFiles and keeps the most recent", () => {
    let state = createSessionState("2026-10-07T00:00:00.000Z");
    for (let i = 0; i < 25; i++) {
      state = applyObservation(state, "read_file", { path: `/f${i}.ts` });
    }
    expect(state.openFiles).toHaveLength(20);
    expect(state.openFiles[0]).toBe("/f5.ts");
    expect(state.openFiles[19]).toBe("/f24.ts");
  });

  it("derives a stable hash that changes with state", () => {
    const state = createSessionState("2026-10-07T00:00:00.000Z");
    const updated = applyObservation(state, "read_file", { path: "/a.ts" });
    expect(sessionStateHash(state)).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionStateHash(state)).toBe(sessionStateHash(createSessionState("2026-10-07T00:00:00.000Z")));
    expect(sessionStateHash(updated)).not.toBe(sessionStateHash(state));
  });

  it("wraps the serialized state in a session_state context block", () => {
    const state = applyObservation(createSessionState("2026-10-07T00:00:00.000Z"), "t", { path: "/x.ts" });
    const block = sessionStateContextBlock(state);
    expect(block.startsWith("<session_state>\n")).toBe(true);
    expect(block.endsWith("\n</session_state>")).toBe(true);
    expect(JSON.parse(block.slice("<session_state>\n".length, -"\n</session_state>".length))).toEqual(state);
  });
});

describe("Claude Code lifecycle hook events", () => {
  it("registers and fires sessionStart/sessionEnd/preCompact/postCompact", async () => {
    const hooks = new AgentHooks();
    const fired: string[] = [];
    for (const event of ["sessionStart", "sessionEnd", "preCompact", "postCompact"] as const) {
      hooks.register(event, () => {
        fired.push(event);
      }, `${event}-probe`);
    }
    await hooks.run("sessionStart", {}, { runId: "r1" });
    await hooks.run("preCompact", {});
    await hooks.run("postCompact", {});
    await hooks.run("sessionEnd", {}, { runId: "r1" });
    expect(fired).toEqual(["sessionStart", "preCompact", "postCompact", "sessionEnd"]);
  });
});
