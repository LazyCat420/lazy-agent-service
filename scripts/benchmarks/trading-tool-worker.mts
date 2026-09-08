/** JSON-lines offline fixture worker; all tool HTTP is intercepted. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
const root = path.resolve(process.env.TOOL_BENCH_ROOT || process.cwd());
const fixed = process.env.TOOL_BENCH_ARM === "after";
process.env.TRADING_TOOL_CONTEXT_KEY = "offline-workflow-benchmark";
const { default: McpAdapter } = await import(pathToFileURL(path.join(root, "src/services/McpAdapter.ts")).href);
const binding = fixed ? await import("../../src/services/TradingToolContext.ts") : null;
const { bindToolResponse } = await import("../../src/services/TradingToolStream.ts");
const server = (new McpAdapter() as any).createMcpServer();
const handler = server._requestHandlers.get("tools/call");
let activeCycle = "cycle-v3-bench-current", role = "v3_junior_analyst", ticker = "LULU", failNext = false;
let backend = 0, writes = 0, reads = 0;
const boards = new Map<string, Record<string, string>>();
function board(id: string) { let b = boards.get(id); if (!b) boards.set(id, b = {}); return b; }
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url: any, options: any) => {
  if (!String(url).endsWith("/api/v1/agent-tools/execute")) throw new Error("Fixture blocks non-tool HTTP");
  backend++;
  const p = JSON.parse(options.body), args = p.arguments, scope = p.cycle_id || activeCycle;
  await new Promise(r => setTimeout(r, 3));
  let value: any;
  if (args.ticker !== ticker) value = { error: "TICKER_MISMATCH", is_error: true };
  else if (p.tool_name === "get_market_data") {
    if (failNext) { failNext = false; value = JSON.stringify({ error: "TEMPORARY_PROVIDER_FAILURE: provider has recovered; retry this read once" }); }
    else value = { ticker, price: 100.61, as_of: "2026-09-03T20:00:00Z", evidence: "frozen benchmark observation" };
  } else if (p.tool_name === "whiteboard_write") { writes++; board(scope)[args.section] = args.content; value = { success: true, cycle_id: scope, section: args.section }; }
  else if (p.tool_name === "whiteboard_read") { reads++; value = { ticker, cycle_id: scope, sections: { ...board(scope) } }; }
  else value = { error: "UNSUPPORTED_FIXTURE_TOOL", is_error: true };
  return new Response(JSON.stringify(value));
};
try {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const input = JSON.parse(line);
    let output: any;
    try {
      activeCycle = input.cycle || activeCycle;
      role = input.role || role; ticker = input.ticker || ticker;
      if (input.op === "state") {
        if (input.section) board(activeCycle)[input.section] = input.content;
        if (input.failNext !== undefined) failNext = input.failNext;
        output = { backend, writes, reads, board: { ...board(activeCycle) } };
      } else {
        const before = backend;
        let call = { id: "offline-call", function: { name: input.name, arguments: JSON.stringify(input.args) } };
        if (binding) {
          const token = binding.signToolContext({ project: "vllm-trading-bot", agentName: role, cycleId: activeCycle, ticker, conversationId: activeCycle + ":" + role, allowedTools: ["get_market_data", "whiteboard_read", "whiteboard_write"], expiresAt: Date.now() + 3600000 });
          call = bindToolResponse({ choices: [{ message: { tool_calls: [call] } }] }, token).choices[0].message.tool_calls[0];
        }
        const result = await handler({ method: "tools/call", params: { name: input.name, arguments: JSON.parse(call.function.arguments) } }, {});
        output = { result, backend_delta: backend - before };
      }
    } catch (error) { output = { error: String(error) }; }
    process.stdout.write("BENCH_RPC " + JSON.stringify(output) + "\n");
  }
} finally { globalThis.fetch = nativeFetch; await server.close(); }
