/** Shared REST/MCP execution boundary. Transport sessions are not agent roles. */
import { routeLocalTool } from "./LocalToolRouter.js";
import { authorizeTradingTool, TOOL_CONTEXT_ARG } from "./TradingToolContext.js";
import { getToolSchemas } from "./ToolSchemaService.js";
import { stripMcpPrefix } from "./McpPrefix.js";
import { probeFault, probeToolStallMs } from "./ProbeFault.js";
import logger from "../logger.js";
const tradingTools = new Set(getToolSchemas().filter((s) => s.owner_app === "trading").map(s => s.name));
export async function dispatchTool(name, args, caller = {}) {
    const signed = Object.hasOwn(args, TOOL_CONTEXT_ARG);
    const trading = signed || caller.project === "vllm-trading-bot" || caller.authenticatedProject === "vllm-trading-bot" || /^(?:custom_)?v3_/i.test(caller.agentName || "");
    if (trading) {
        let authorized;
        try {
            authorized = authorizeTradingTool(name, args);
        }
        catch (error) {
            return { error: "PERMISSION_DENIED", message: error.message, is_error: true };
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
//# sourceMappingURL=ToolDispatch.js.map