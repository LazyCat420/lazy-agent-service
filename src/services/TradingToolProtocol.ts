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

/** The executor already runs every tool_call of one response together (ToolExecutor
 * executeToolBatch, each call authorized by decideToolCall), but nemotron35 rarely
 * emits more than one: replaying the junior prompt and catalog on Jetson, 0 of 6 first
 * responses carried 2+ calls without this text and 4 of 6 with it (3-5 calls each;
 * .agents/AUDIT-tool-routing-2026-10-16.md §B). Junior runs a median 11 model turns at
 * ~9.8 s each for ~10 tool calls, so each bundled lookup saves a turn. Appended to the
 * end of the system message, which is identical on every turn of a run, so the cached
 * prefix stays byte-stable. TRADING_PARALLEL_TOOL_HINT=false turns it off; requests
 * without a signed trading context never reach this code.
 */
export const PARALLEL_TOOL_HINT = "Independent lookups go in ONE response: when you need several tools whose arguments do not depend on each " +
  "other's results, emit all of those tool_calls together; they run in parallel. Only wait for a result when the " +
  "next call needs it.";

/** What the forced last turn is for. prism's exhaustion pass (its maxIterations
 * ceiling) turns the tools off and appends an <iteration-limit> user turn asking for
 * a prose progress summary; a trading agent's contract is its JSON artifact.
 * nemotron35 answers that turn with one more tool call, which a tool-less request
 * returns as an EMPTY reply: 169 of 170 bull and 166 of 168 bear runs that reached
 * the wall (09-13..09-27) came back empty and needed a second, tool-less repair
 * call. The sentence is appended to that turn only, so every earlier turn keeps
 * its cached prefix. Text is the one replayed on stored wall turns
 * (trading-service scripts/benchmarks/turn_wall_replay.py, arm `wallmsg`).
 */
export const FINAL_TURN_DIRECTIVE = "When an <iteration-limit> message arrives, your tools are gone for this task: do not " +
  "call a tool and do not summarize progress. Reply at once with the complete required " +
  "JSON artifact, built from the evidence you already have, with anything you could not " +
  "verify stated as a gap.";

/** prism's forced final turn: the last message is its <iteration-limit> notice and no tool can be
 * called. prism builds up to 2026-09-27 removed the catalog on that turn; the build deployed that
 * evening keeps the catalog byte-stable (for the prompt cache) and sends tool_choice "none"
 * instead, and it sends the notice as a SYSTEM message — rewriteMessages demotes it to user only
 * after this protocol has run, so the stored payload shows "user". Keyed on a missing catalog and
 * a user notice, the directive fired on 0 of 5 wall turns on 2026-09-28 (and on none of the first
 * verification run of 004e23b, which fixed only the catalog half).
 */
function isForcedFinalTurn(messages: any[], tools: unknown, toolChoice: unknown): boolean {
  const last = messages[messages.length - 1];
  const callable = Array.isArray(tools) && tools.length > 0 && toolChoice !== "none";
  return !callable
    && (last?.role === "user" || last?.role === "system") && typeof last.content === "string"
    && last.content.includes("<iteration-limit>") && !last.content.includes(FINAL_TURN_DIRECTIVE);
}

/** The role's learned opening stack (TradingToolStacks.openingStack). The replayed wording said
 * "They take only the ticker"; "keyed by" stays true for stackable reads with optional extras. */
export const openingStackLine = (stack: string[]) => "Usual opening bundle for this role (learned from past runs): " +
  stack.join(", ") + ". They are keyed by the ticker; when you need them, call them together in your first response.";

export function applyTradingToolProtocol(body: Record<string, any>, allowedTools?: string[], openingStack: string[] = []): {
  body: Record<string, any>; removedTools: number; correctedAcknowledgements: number; deniedTools: string[];
  finalTurnDirected: boolean;
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
  const hintEnabled = (process.env.TRADING_PARALLEL_TOOL_HINT || "true").toLowerCase() !== "false";
  const callable = new Set(Array.isArray(tools)
    ? tools.map((t: { function?: { name?: unknown } }) => stripMcpPrefix(String(t.function?.name))) : []);
  const stack = openingStack.filter((t) => callable.has(stripMcpPrefix(t)));
  const lines = [hintEnabled && callable.size > 1 ? PARALLEL_TOOL_HINT : "", stack.length > 1 ? openingStackLine(stack) : ""]
    .filter(Boolean);
  const hint = lines.length ? "\n\n" + lines.join("\n") : "";
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
      return { ...m, content: protocol + "\n\n" + m.content + hint };
    }
    return m;
  });
  if (!injected) messages.unshift({ role: "system", content: protocol + hint });
  const finalTurnDirected = isForcedFinalTurn(messages, tools, body.tool_choice);
  if (finalTurnDirected) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, content: last.content + "\n" + FINAL_TURN_DIRECTIVE };
  }
  const result: Record<string, any> = { ...body, messages, ...(Array.isArray(tools) ? { tools } : {}) };
  if (isThink(body.tool_choice?.function?.name) || deniedTools.includes(body.tool_choice?.function?.name)) result.tool_choice = tools?.length ? "auto" : "none";
  if (removedTools && !tools.length && body.tool_choice === "required") result.tool_choice = "none";
  // OpenAI-compatible providers reject tools:[] before inference. A tool-less
  // repair must omit the catalog and choice, not advertise an empty catalog.
  if (Array.isArray(tools) && tools.length === 0) {
    delete result.tools;
    delete result.tool_choice;
  }
  return { body: result, removedTools, correctedAcknowledgements, deniedTools, finalTurnDirected };
}
