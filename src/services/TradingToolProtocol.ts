/** Keep reasoning acknowledgements from masquerading as research execution.
 * Applied only after the shim verifies a signed trading identity. Never promote
 * quoted/embedded tool text into an executable call or change role permissions.
 */
import { stripMcpPrefix } from "./McpPrefix.ts";

const protocol = "[TRADING TOOL EXECUTION CONTRACT v1]\n" +
  "Use native tool_calls for research and calculation. Text or XML naming a tool inside another tool's arguments does not execute it. " +
  "The think acknowledgement is not research evidence and think is not available for this task. " +
  "Use only the listed tools with their declared argument schemas. If research did not execute, report that gap; do not describe an acknowledgement as a provider result. " +
  "Return the required artifact when finished.";
const acknowledgement = JSON.stringify({
  status: "reasoning_acknowledgement_only",
  research_executed: false,
  message: "This think call executed no research or calculation. Embedded tool-call text was not dispatched. Issue a native call to a listed tool if evidence is needed; otherwise retain the data gap.",
});
const isThink = (name: unknown) => typeof name === "string" && stripMcpPrefix(name) === "think";

export function applyTradingToolProtocol(body: Record<string, any>, allowedTools?: string[]): {
  body: Record<string, any>; removedTools: number; correctedAcknowledgements: number; deniedTools: string[];
} {
  const allowed = allowedTools ? new Set(allowedTools.map(stripMcpPrefix)) : null;
  const deniedTools: string[] = [];
  const tools = Array.isArray(body.tools) ? body.tools.filter((t: any) => {
    const name = t.function?.name;
    if (isThink(name)) return false;
    // Built-in tools bypass /execute authorization. Enforce the signed role catalog here too.
    if (allowed && (typeof name !== "string" || !allowed.has(stripMcpPrefix(name)))) {
      deniedTools.push(String(name || "unknown"));
      return false;
    }
    return true;
  }) : body.tools;
  const removedTools = Array.isArray(body.tools) ? body.tools.length - tools.length : 0;
  const thinkIds = new Set<string>();
  let correctedAcknowledgements = 0;
  let injected = false;
  const messages = (body.messages || []).map((m: any) => {
    if (m.role === "assistant") for (const call of m.tool_calls || []) {
      if (isThink(call.function?.name) && typeof call.id === "string") thinkIds.add(call.id);
    }
    if (m.role === "tool" && thinkIds.has(m.tool_call_id)) {
      correctedAcknowledgements++;
      return { ...m, content: acknowledgement };
    }
    if (!injected && m.role === "system" && typeof m.content === "string") {
      injected = true;
      return { ...m, content: protocol + "\n\n" + m.content };
    }
    return m;
  });
  if (!injected) messages.unshift({ role: "system", content: protocol });
  const result: Record<string, any> = { ...body, messages, ...(Array.isArray(tools) ? { tools } : {}) };
  if (isThink(body.tool_choice?.function?.name) || deniedTools.includes(body.tool_choice?.function?.name)) result.tool_choice = tools?.length ? "auto" : "none";
  if (removedTools && !tools.length && body.tool_choice === "required") result.tool_choice = "none";
  return { body: result, removedTools, correctedAcknowledgements, deniedTools };
}
