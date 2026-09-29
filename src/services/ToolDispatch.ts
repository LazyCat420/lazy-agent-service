/** Shared REST/MCP execution boundary. Transport sessions are not agent roles. */
import { routeLocalTool, type LocalToolContext } from "./LocalToolRouter.ts";
import { authorizeTradingTool, TOOL_CONTEXT_ARG } from "./TradingToolContext.ts";
import { getToolSchemas } from "./ToolSchemaService.ts";
import { stripMcpPrefix } from "./McpPrefix.ts";
import { probeFault, probeToolStallMs } from "./ProbeFault.ts";
import logger from "../logger.js";
const tradingTools = new Set(getToolSchemas().filter((s: any) => s.owner_app === "trading").map(s => s.name));
export async function dispatchTool(name: string, args: Record<string, unknown>,
  caller: LocalToolContext & { project?: string; transport?: "rest" | "mcp"; authenticatedProject?: string } = {}) {
  const signed = Object.hasOwn(args, TOOL_CONTEXT_ARG);
  const trading = signed || caller.project === "vllm-trading-bot" || caller.authenticatedProject === "vllm-trading-bot" || /^(?:custom_)?v3_/i.test(caller.agentName || "");
  if (trading) {
    let authorized: ReturnType<typeof authorizeTradingTool>;
    try {
      authorized = authorizeTradingTool(name, args);
    } catch (error) {
      return { error: "PERMISSION_DENIED", message: (error as Error).message, is_error: true };
    }
    if (probeFault(authorized.context.cycleId) === "toolstall") {
      // The boundary probe's hung tool (see ProbeFault.ts): trading's watchdog must end it.
      logger.warn(`[ProbeFault] probe fault injected: toolstall for ${stripMcpPrefix(name)} (cycle ${authorized.context.cycleId})`);
      await new Promise((resolve) => setTimeout(resolve, probeToolStallMs()));
      return { error: "PROBE_TOOL_STALL", message: "boundary probe: this tool call hung on purpose", is_error: true };
    }
    return routeLocalTool(name, authorized.arguments, authorized.context);
  }
  if (caller.transport === "mcp" && tradingTools.has(stripMcpPrefix(name)) && !caller.authenticatedProject) {
    return { error: "PERMISSION_DENIED", message: "Trading tools require signed execution context or an authenticated non-trading MCP connection", is_error: true };
  }
  return routeLocalTool(name, args, caller);
}
