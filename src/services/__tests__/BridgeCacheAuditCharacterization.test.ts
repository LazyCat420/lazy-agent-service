// No HTTP: all bridge responses are synthetic. Passing tests characterize defects.
import { afterEach, expect, it, vi } from "vitest";
import { executeToolViaTradingService } from "../LocalToolRouter.ts";
afterEach(() => vi.unstubAllGlobals());
it("characterizes a write in another cycle served from the first cycle cache", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entry_id: "offline-first", cycle_id: "cycle-v3-offline-a" }) });
  vi.stubGlobal("fetch", fetchMock);
  const args = { ticker: "AUDIT_ONLY", section: "audit", content: "synthetic", author: "offline" };
  const first = await executeToolViaTradingService("whiteboard_write", args, { cycleId: "cycle-v3-offline-a" });
  const second = await executeToolViaTradingService("whiteboard_write", args, { cycleId: "cycle-v3-offline-b" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(second).toEqual(first);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).cycle_id).toBe("cycle-v3-offline-a");
});
it("characterizes a cached empty board surviving a successful write", async () => {
  let written = false;
  const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.tool_name === "whiteboard_write") written = true;
    return { ok: true, json: async () => body.tool_name === "whiteboard_read" ? { entries: written ? ["new"] : [] } : { ok: true } };
  });
  vi.stubGlobal("fetch", fetchMock);
  const ctx = { cycleId: "cycle-v3-offline-c" };
  const args = { ticker: "AUDIT_READ_ONLY" };
  expect(await executeToolViaTradingService("whiteboard_read", args, ctx)).toEqual({ entries: [] });
  await executeToolViaTradingService("whiteboard_write", { ...args, section: "audit", content: "synthetic" }, ctx);
  expect(await executeToolViaTradingService("whiteboard_read", args, ctx)).toEqual({ entries: [] });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
