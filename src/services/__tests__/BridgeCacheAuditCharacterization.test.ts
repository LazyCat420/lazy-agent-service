// Regression tests: all HTTP responses are synthetic.
import { afterEach, expect, it, vi } from "vitest";
import { executeToolViaTradingService } from "../LocalToolRouter.ts";
afterEach(() => vi.unstubAllGlobals());
it("executes a write independently in each cycle", async () => {
  const fetchMock = vi.fn().mockImplementation(async (_url, options) => ({ ok: true, json: async () => ({ entry_id: "offline-first", cycle_id: JSON.parse(options.body).cycle_id }) }));
  vi.stubGlobal("fetch", fetchMock);
  const args = { ticker: "AUDIT_ONLY", section: "audit", content: "synthetic", author: "offline" };
  const first = await executeToolViaTradingService("whiteboard_write", args, { cycleId: "cycle-v3-offline-a" });
  const second = await executeToolViaTradingService("whiteboard_write", args, { cycleId: "cycle-v3-offline-b" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(second).not.toEqual(first);
  expect((second as any).cycle_id).toBe("cycle-v3-offline-b");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).cycle_id).toBe("cycle-v3-offline-a");
});
it("reads newly written board state immediately", async () => {
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
  expect(await executeToolViaTradingService("whiteboard_read", args, ctx)).toEqual({ entries: ["new"] });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("does not coalesce simultaneous writes but retains reusable-read stampede protection", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ ok: true }) }));
  vi.stubGlobal("fetch", fetchMock);
  await Promise.all(Array.from({ length: 4 }, () => executeToolViaTradingService("whiteboard_write", { ticker: "AUDIT_CONCURRENT" })));
  expect(fetchMock).toHaveBeenCalledTimes(4);
  fetchMock.mockClear();
  await Promise.all(Array.from({ length: 40 }, () => executeToolViaTradingService("get_market_data", { ticker: "AUDIT_BURST" })));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("does not cache JSON-string failures from Python tools", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => '{"error":"offline outage"}' });
  vi.stubGlobal("fetch", fetchMock);
  const args = { ticker: "AUDIT_ERROR" };
  await executeToolViaTradingService("get_market_data", args);
  await executeToolViaTradingService("get_market_data", args);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it("separates reads whose missing ticker will be repaired from different caller contexts", async () => {
  const fetchMock = vi.fn().mockImplementation(async (_url, options) => ({ ok: true, json: async () => ({ ticker: JSON.parse(options.body).ticker }) }));
  vi.stubGlobal("fetch", fetchMock);
  const a = await executeToolViaTradingService("get_sec_filings", {}, { ticker: "AUDIT_A" });
  const b = await executeToolViaTradingService("get_sec_filings", {}, { ticker: "AUDIT_B" });
  expect(a).toEqual({ ticker: "AUDIT_A" }); expect(b).toEqual({ ticker: "AUDIT_B" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
