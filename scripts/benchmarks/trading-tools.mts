/** Offline before/after tool execution benchmark. All tool HTTP is intercepted.
 * Invokes each revision's real MCP handler, router, cache and guard.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve(process.env.TOOL_BENCH_ROOT || process.cwd());
const arm = process.env.TOOL_BENCH_ARM || "after";
process.env.TRADING_TOOL_CONTEXT_KEY = "offline-benchmark-only";
const { default: McpAdapter } = await import(pathToFileURL(path.join(root, "src/services/McpAdapter.ts")).href);
const contextModule = arm === "after" ? await import(pathToFileURL(path.join(root, "src/services/TradingToolContext.ts")).href) : null;
const { resetGuard } = await import(pathToFileURL(path.join(root, "src/services/ToolCallGuard.ts")).href);
const adapter = new McpAdapter();
const server = (adapter as any).createMcpServer();
const handler = (server as any)._requestHandlers.get("tools/call");
if (!handler) throw new Error("MCP handler unavailable");
const originalFetch = globalThis.fetch;
let activeCycle = "", requests = 0;
const boards = new Map<string, Record<string, unknown>>();
const failures = new Set<string>();
function board(cycle: string) { let b = boards.get(cycle); if (!b) boards.set(cycle, b = {}); return b; }
globalThis.fetch = async (url: any, options: any) => {
  if (!String(url).endsWith("/api/v1/agent-tools/execute")) throw new Error("Benchmark blocks non-fixture HTTP");
  requests++;
  const payload = JSON.parse(options.body), args = payload.arguments;
  const cycle = payload.cycle_id || activeCycle;
  const key = `${cycle}:${args.ticker}`;
  await new Promise(resolve => setTimeout(resolve, 3));
  let result: any;
  if (payload.tool_name === "whiteboard_write") { board(key)[args.section] = args.content; result = { success: true, cycle_id: cycle }; }
  else if (payload.tool_name === "whiteboard_read") result = { sections: { ...board(key) }, cycle_id: cycle };
  else if (payload.tool_name === "get_market_data" && failures.has(args.ticker)) { failures.delete(args.ticker); result = JSON.stringify({ error: "synthetic transient outage" }); }
  else result = { success: true, ticker: args.ticker, price: 100 };
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};
const capabilities = new Map<string, string>();
async function call(name: string, args: any, cycle: string, allowed = ["whiteboard_read", "whiteboard_write", "get_market_data"]) {
  activeCycle = cycle;
  if (contextModule) {
    const identity = JSON.stringify([cycle, allowed]);
    let capability = capabilities.get(identity);
    if (!capability) {
      capability = contextModule.signToolContext({ project: "vllm-trading-bot", agentName: "v3_junior_analyst", cycleId: cycle, ticker: args.ticker || "TEST", conversationId: cycle + ":junior", allowedTools: allowed, expiresAt: Date.now() + 60000 });
      capabilities.set(identity, capability);
    }
    args = { ...args, [contextModule.TOOL_CONTEXT_ARG]: capability };
  }
  const result = await handler({ method: "tools/call", params: { name, arguments: args } }, {});
  return { envelope: result, value: JSON.parse(result.content[0].text) };
}
const rows: any[] = [];
try {
  for (let repeat = 0; repeat < 30; repeat++) {
    resetGuard();
    for (const scenario of ["healthy_read_burst", "cross_cycle_write", "whiteboard_handoff", "transient_read_failure", "unauthorized_write"]) {
      const ticker = `${scenario}_${repeat}`, cycle = `cycle-v3-bench-${ticker}`;
      let success = false, firstErrorFlag: boolean | null = null;
      const before = requests, start = performance.now();
      if (scenario === "healthy_read_burst") {
        const values = await Promise.all(Array.from({ length: 40 }, () => call("get_market_data", { ticker }, cycle)));
        success = values.every(r => r.value.price === 100);
      } else if (scenario === "cross_cycle_write") {
        const args = { ticker, section: "market_context", content: "synthetic note" };
        await call("whiteboard_write", args, cycle + "-a");
        await call("whiteboard_write", args, cycle + "-b");
        success = board(`${cycle}-b:${ticker}`).market_context === "synthetic note";
      } else if (scenario === "whiteboard_handoff") {
        await call("whiteboard_read", { ticker }, cycle);
        await call("whiteboard_write", { ticker, section: "market_context", content: "synthetic note" }, cycle);
        const read = await call("whiteboard_read", { ticker }, cycle);
        success = read.value.sections?.market_context === "synthetic note";
      } else if (scenario === "transient_read_failure") {
        failures.add(ticker);
        const first = await call("get_market_data", { ticker }, cycle);
        firstErrorFlag = first.envelope.isError === true;
        const second = await call("get_market_data", { ticker }, cycle);
        success = second.value.price === 100;
      } else {
        await call("whiteboard_write", { ticker, section: "forbidden", content: "should not write" }, cycle, ["whiteboard_read"]);
        success = !board(`${cycle}:${ticker}`).forbidden;
      }
      rows.push({ arm, scenario, repeat, elapsed_ms: performance.now() - start, backend_requests: requests - before, success, first_error_flag: firstErrorFlag });
    }
  }
} finally { globalThis.fetch = originalFetch; await server.close(); }
const output = { arm, backend_latency_ms: 3, repetitions: 30, rows };
fs.writeFileSync(process.env.TOOL_BENCH_OUTPUT || `/tmp/trading-tools-${arm}.json`, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ arm, attempts: rows.length, succeeded: rows.filter(r => r.success).length }));
