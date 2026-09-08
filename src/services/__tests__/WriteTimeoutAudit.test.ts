/** Characterizations, not cancellation guarantees. Real loopback HTTP, no DB.
 * The delayed server-side write models a backend operation after acceptance.
 */
import http from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import CONFIG from "../../../config.ts";
import { raceToolDeadline } from "../McpAdapter.ts";
import { executeToolViaTradingService } from "../LocalToolRouter.ts";
let server: http.Server;
let committed: boolean, closedBeforeCommit: boolean, finishWrite: Promise<void>;
let resolveWrite: () => void;
let earlyHeaders: boolean;
const original = { url: CONFIG.TRADING_SERVICE_URL, timeout: CONFIG.EXECUTION_TIMEOUT_MS };
beforeEach(async () => {
  committed = false; closedBeforeCommit = false; earlyHeaders = false;
  finishWrite = new Promise(resolve => { resolveWrite = resolve; });
  server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* accept the complete write request */ }
    res.on("close", () => { if (!committed) closedBeforeCommit = true; });
    if (earlyHeaders) { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); }
    await new Promise(resolve => setTimeout(resolve, 250));
    committed = true;
    if (!res.destroyed) res.end('{"status":"success"}');
    resolveWrite();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  CONFIG.TRADING_SERVICE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  CONFIG.EXECUTION_TIMEOUT_MS = 1000;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  CONFIG.TRADING_SERVICE_URL = original.url;
  CONFIG.EXECUTION_TIMEOUT_MS = original.timeout;
});
function write() {
  return executeToolViaTradingService("whiteboard_write", { ticker: "OFFLINE_TIMEOUT", section: "audit", content: "synthetic" }, { cycleId: "cycle-v3-offline-timeout" });
}
function envelope(p: Promise<unknown>) { return p.then(result => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }] })); }
it("adapter timeout returns first while the accepted underlying write still commits", async () => {
  const pending = write();
  const result = await raceToolDeadline("whiteboard_write", envelope(pending), 60);
  expect(result.isError).toBe(true);
  expect(JSON.parse(result.content[0].text).error).toContain("TOOL_TIMEOUT");
  expect(committed).toBe(false);
  expect(closedBeforeCommit).toBe(false);
  await finishWrite;
  expect(committed).toBe(true);
  expect(await pending).toEqual({ status: "success" });
});
it("bridge fetch abort closes transport but does not cancel an accepted backend write", async () => {
  CONFIG.EXECUTION_TIMEOUT_MS = 60;
  const result: any = await write();
  expect(result.is_error).toBe(true);
  expect(result.error).toContain("bridge timeout");
  expect(committed).toBe(false);
  await finishWrite;
  expect(closedBeforeCommit).toBe(true);
  expect(committed).toBe(true);
});
it("headers arriving early clear the bridge timer; the adapter can expire while the response body and write remain pending", async () => {
  earlyHeaders = true;
  CONFIG.EXECUTION_TIMEOUT_MS = 60;
  const pending = write();
  const result = await raceToolDeadline("whiteboard_write", envelope(pending), 120);
  expect(result.isError).toBe(true);
  expect(committed).toBe(false);
  expect(closedBeforeCommit).toBe(false);
  await finishWrite;
  expect(await pending).toEqual({ status: "success" });
});
