/** Keep reasoning acknowledgements from masquerading as research execution.
 * Applied only after the shim verifies a signed trading identity. Never promote
 * quoted/embedded tool text into an executable call or change role permissions.
 */
import fs from "node:fs";
import path from "node:path";
import logger from "../logger.ts";
import { modelFamilyOf } from "../platform/models/ModelProfiles.ts";
import { stripMcpPrefix } from "./McpPrefix.ts";
import { PromotionController } from "./PromotionController.ts";

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

export const NATIVE_EXHAUSTION_PREFIX = "Time, budget or step limit reached. Do not call tools.";
export const INTERLOCK_MARKER = "[TRADING INTERLOCK v1]";

/**
 * Promoted per-(agentRole, modelFamily) execution & completion interlock (arXiv:2611.18856 §F.2 / Table 8).
 * Governed by `PromotionController`: inactive (`null`) until a candidate config reaches `active`.
 */
export interface TradingShimInterlockConfig {
  version: string;
  /** Also direct native CoreLoop final-pass wall messages (`CoreLoop.ts` `FINAL_PASS_INSTRUCTION`) to emit the JSON artifact. */
  matchNativeExhaustionNotice?: boolean;
  /** Max consecutive failed results from the same tool before injecting a single-shot bounded-stop notice. */
  maxConsecutiveToolErrors?: number;
  /** Assistant tool-call turn threshold after which a single-shot convergence notice fires (once reads succeeded). */
  turnWarnThreshold?: number;
  /** Optional concise tool-contract repair hint appended when `maxConsecutiveToolErrors` triggers. */
  toolErrorHint?: string;
}

const shimInterlockRegistry = new Map<string, TradingShimInterlockConfig>();
let shimInterlockLoadedPath: string | null = null;
let shimInterlockLoadError: string | null = null;

function shimInterlockStorePath(): string {
  return process.env.PROMOTION_INTERLOCK_STORE_PATH || path.resolve(process.cwd(), "runtime-data", "shim_interlocks.json");
}

function ensureShimInterlocksLoaded(): void {
  const storePath = shimInterlockStorePath();
  if (shimInterlockLoadedPath === storePath) return;
  shimInterlockRegistry.clear();
  shimInterlockLoadedPath = storePath;
  shimInterlockLoadError = null;
  try {
    if (fs.existsSync(storePath)) {
      const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, TradingShimInterlockConfig>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("interlock store root must be a JSON object");
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.version === "string") shimInterlockRegistry.set(k, v);
      }
    }
  } catch (error) {
    shimInterlockLoadError = error instanceof Error ? error.message : String(error);
    logger.error(`[TradingToolProtocol] Failed parsing shim interlock store ${storePath}: ${shimInterlockLoadError}`);
  }
}

export function tradingShimProfileId(agentName: string, modelFamily: string): string {
  return `trading-shim:${agentName.toLowerCase()}:${modelFamily.toLowerCase()}`;
}

function canonicalInterlockJson(cfg: TradingShimInterlockConfig): string {
  return JSON.stringify({
    version: cfg.version,
    matchNativeExhaustionNotice: Boolean(cfg.matchNativeExhaustionNotice),
    maxConsecutiveToolErrors: cfg.maxConsecutiveToolErrors ?? null,
    turnWarnThreshold: cfg.turnWarnThreshold ?? null,
    toolErrorHint: cfg.toolErrorHint ?? null,
  });
}

export function registerShimInterlockConfig(
  profileId: string,
  config: TradingShimInterlockConfig,
): void {
  ensureShimInterlocksLoaded();
  const storePath = shimInterlockStorePath();
  if (shimInterlockLoadError) {
    throw new Error(`Refusing to overwrite corrupt shim interlock store ${storePath}: ${shimInterlockLoadError}`);
  }
  const key = `${profileId}@${config.version}`;
  const existing = shimInterlockRegistry.get(key);
  if (existing) {
    if (canonicalInterlockJson(existing) === canonicalInterlockJson(config)) return;
    throw new Error(`Refusing to overwrite immutable shim interlock config for ${key}`);
  }
  const promo = PromotionController.get(profileId, config.version);
  if (promo && promo.channel !== "offline_candidate") {
    throw new Error(`Refusing to register new config onto already-promoted ${key} (${promo.channel})`);
  }
  shimInterlockRegistry.set(key, { ...config });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(Object.fromEntries(shimInterlockRegistry), null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, storePath);
}

export function resolveActiveShimInterlock(
  agentName: string | undefined,
  modelId: string | undefined,
): TradingShimInterlockConfig | null {
  if (!agentName || (process.env.TRADING_SHIM_INTERLOCK || "true").toLowerCase() === "false") return null;
  ensureShimInterlocksLoaded();
  const family = modelId ? modelFamilyOf(modelId) : "unknown";
  const candidates = [
    ...(family !== "unknown" ? [tradingShimProfileId(agentName, family)] : []),
    tradingShimProfileId(agentName, "*"),
  ];
  for (const profileId of candidates) {
    const active = PromotionController.getActive(profileId);
    if (!active) continue;
    const cfg = shimInterlockRegistry.get(`${profileId}@${active.version}`);
    if (cfg) return cfg;
  }
  return null;
}

function isForcedFinalTurn(
  messages: any[],
  tools: unknown,
  toolChoice: unknown,
  matchNativeExhaustion = false,
): boolean {
  const last = messages[messages.length - 1];
  const callable = Array.isArray(tools) && tools.length > 0 && toolChoice !== "none";
  if (callable || (last?.role !== "user" && last?.role !== "system") || typeof last.content !== "string") {
    return false;
  }
  if (last.content.includes(FINAL_TURN_DIRECTIVE)) return false;
  return (
    last.content.includes("<iteration-limit>") ||
    (matchNativeExhaustion && last.content.includes(NATIVE_EXHAUSTION_PREFIX))
  );
}

/** The role's learned opening stack (TradingToolStacks.openingStack). The replayed wording said
 * "They take only the ticker"; "keyed by" stays true for stackable reads with optional extras. */
export const openingStackLine = (stack: string[]) => "Usual opening bundle for this role (learned from past runs): " +
  stack.join(", ") + ". They are keyed by the ticker; when you need them, call them together in your first response.";

interface TradingToolsSelection {
  tools: any;
  removedTools: number;
  deniedTools: string[];
}

function buildTradingTools(
  body: Record<string, any>,
  allowed: Set<string> | null,
): TradingToolsSelection {
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
  return { tools, removedTools, deniedTools };
}

function buildTradingHint(
  hintEnabled: boolean,
  callable: Set<string>,
  stack: string[],
): string {
  const lines = [hintEnabled && callable.size > 1 ? PARALLEL_TOOL_HINT : "", stack.length > 1 ? openingStackLine(stack) : ""]
    .filter(Boolean);
  return lines.length ? "\n\n" + lines.join("\n") : "";
}

function rewriteTradingMessages(
  messages: any[],
  protocolText: string,
  hint: string,
): { messages: any[]; correctedAcknowledgements: number } {
  const thinkIds = new Set<string>();
  let correctedAcknowledgements = 0;
  let injected = false;

  const rewrittenMessages = messages.map((m: any) => {
    if (m.role === "assistant") for (const call of m.tool_calls || []) {
      if (isThink(call.function?.name) && typeof call.id === "string") thinkIds.add(call.id);
    }
    if (m.role === "tool" && thinkIds.has(m.tool_call_id)) {
      correctedAcknowledgements++;
      return { ...m, content: acknowledgement };
    }
    if (!injected && m.role === "system" && typeof m.content === "string") {
      injected = true;
      return { ...m, content: protocolText + "\n\n" + m.content + hint };
    }
    return m;
  });
  if (!injected) rewrittenMessages.unshift({ role: "system", content: protocolText + hint });

  return { messages: rewrittenMessages, correctedAcknowledgements };
}

function normalizeTradingToolChoice(
  body: Record<string, any>,
  result: Record<string, any>,
  tools: any,
  removedTools: number,
  deniedTools: string[],
): void {
  if (isThink(body.tool_choice?.function?.name) || deniedTools.includes(body.tool_choice?.function?.name)) result.tool_choice = tools?.length ? "auto" : "none";
  if (removedTools && !tools.length && body.tool_choice === "required") result.tool_choice = "none";
  // OpenAI-compatible providers reject tools:[] before inference. A tool-less
  // repair must omit the catalog and choice, not advertise an empty catalog.
  if (Array.isArray(tools) && tools.length === 0) {
    delete result.tools;
    delete result.tool_choice;
  }
}

const STRICT_TOOL_ERROR_RE =
  /^(?:Error:|Tool error:|Equation execution failed:|Execution failed:|Traceback \(most recent call last\):)|(?:^|\n)\s*(?:TypeError|ValueError|KeyError|ZeroDivisionError|RuntimeError|SyntaxError|NameError|AttributeError|IndexError):/;

function isJsonErrorEnvelope(trimmed: string): boolean | null {
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    if (parsed.is_error === true) return true;
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) return true;
    if (parsed.error !== null && typeof parsed.error === "object") return true;
    if (typeof parsed.status === "string" && /^(?:error|failed)$/i.test(parsed.status.trim())) return true;
    return false;
  } catch {
    return null;
  }
}

/** Shared failure-envelope classifier for live shim interlocks and offline CRSI trace replay. */
export function isTradingToolErrorContent(content: unknown): boolean {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  const jsonVerdict = isJsonErrorEnvelope(trimmed);
  if (jsonVerdict !== null) return jsonVerdict;
  return STRICT_TOOL_ERROR_RE.test(trimmed);
}

function alreadyHasInterlockMarker(messages: any[], tag: string): boolean {
  return messages.some((m) => typeof m?.content === "string" && m.content.includes(tag));
}

function recordAssistantCalls(callNameById: Map<string, string>, toolCalls: unknown): void {
  if (!Array.isArray(toolCalls)) return;
  for (const c of toolCalls) {
    if (typeof c?.id === "string" && typeof c?.function?.name === "string") {
      callNameById.set(c.id, stripMcpPrefix(c.function.name));
    }
  }
}

function collectToolOutcomes(messages: any[]): { outcomes: Array<{ name: string; failed: boolean }>; hasSuccessRead: boolean } {
  const callNameById = new Map<string, string>();
  const outcomes: Array<{ name: string; failed: boolean }> = [];
  let hasSuccessRead = false;
  for (const m of messages) {
    if (m?.role === "assistant") {
      recordAssistantCalls(callNameById, m.tool_calls);
    } else if (m?.role === "tool" && typeof m.tool_call_id === "string") {
      const name = callNameById.get(m.tool_call_id) || "unknown";
      const failed = isTradingToolErrorContent(m.content);
      if (!failed) hasSuccessRead = true;
      outcomes.push({ name, failed });
    }
  }
  return { outcomes, hasSuccessRead };
}

function countTrailingSameToolErrors(messages: any[]): { toolName: string; count: number; hasSuccessRead: boolean } {
  const { outcomes, hasSuccessRead } = collectToolOutcomes(messages);
  const last = outcomes[outcomes.length - 1];
  if (!last || !last.failed) return { toolName: "", count: 0, hasSuccessRead };
  let count = 0;
  for (let i = outcomes.length - 1; i >= 0; i--) {
    if (outcomes[i].name === last.name && outcomes[i].failed) count++;
    else break;
  }
  return { toolName: last.name, count, hasSuccessRead };
}

function findLastAssistantToolTurnIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant" && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length > 0) {
      return i;
    }
  }
  return -1;
}

function crossedToolErrorCapOnLatestTurn(messages: any[], toolName: string, count: number, errCap: number): boolean {
  if (errCap <= 0 || count < errCap) return false;
  const lastAsstIdx = findLastAssistantToolTurnIndex(messages);
  if (lastAsstIdx <= 0) return true;
  const beforeTurn = countTrailingSameToolErrors(messages.slice(0, lastAsstIdx));
  const prevSameCount = beforeTurn.toolName === toolName ? beforeTurn.count : 0;
  return prevSameCount < errCap;
}

function applyTailInterlockNotice(
  messages: any[],
  interlock: TradingShimInterlockConfig | null | undefined,
): string | null {
  if (!interlock || messages.length === 0) return null;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  if (last?.role !== "tool" || typeof last.content !== "string") return null;

  const { toolName, count, hasSuccessRead } = countTrailingSameToolErrors(messages);
  const errCap = interlock.maxConsecutiveToolErrors ?? 0;
  // Fire once when the latest assistant turn crosses `errCap` (handling both single calls and
  // parallel failing batches that jump from < errCap to >= errCap without repeating on later turns).
  if (
    crossedToolErrorCapOnLatestTurn(messages, toolName, count, errCap) &&
    !alreadyHasInterlockMarker(messages, `${INTERLOCK_MARKER} [tool-retry]`)
  ) {
    const extra = interlock.toolErrorHint ? ` ${interlock.toolErrorHint}` : "";
    const note = `\n\n${INTERLOCK_MARKER} [tool-retry]: '${toolName}' failed ${count} consecutive times.${extra} Do not repeat the same failing call; either make one corrected scalar call or synthesize the required JSON artifact now from verified evidence, recording any unresolved calculation as a gap.`;
    messages[lastIdx] = { ...last, content: last.content + note };
    return "tool-retry";
  }

  const assistantTurns = messages.filter((m) => m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0).length;
  const warnAt = interlock.turnWarnThreshold ?? 0;
  if (warnAt > 0 && hasSuccessRead && assistantTurns === warnAt && !alreadyHasInterlockMarker(messages, `${INTERLOCK_MARKER} [turn-budget]`)) {
    const note = `\n\n${INTERLOCK_MARKER} [turn-budget]: Turn ${assistantTurns} reached with primary data reads already gathered. Avoid redundant tool loops; finish any single essential check or emit the complete required JSON artifact now.`;
    messages[lastIdx] = { ...last, content: last.content + note };
    return "turn-budget";
  }
  return null;
}

export function applyTradingToolProtocol(
  body: Record<string, any>,
  allowedTools?: string[],
  openingStack: string[] = [],
  interlock?: TradingShimInterlockConfig | null,
): {
  body: Record<string, any>;
  removedTools: number;
  correctedAcknowledgements: number;
  deniedTools: string[];
  finalTurnDirected: boolean;
  interlockFired: string | null;
  interlockVersion: string | null;
} {
  const allowed = allowedTools ? new Set(allowedTools.map(stripMcpPrefix)) : null;
  const { tools, removedTools, deniedTools } = buildTradingTools(body, allowed);
  const hintEnabled = (process.env.TRADING_PARALLEL_TOOL_HINT || "true").toLowerCase() !== "false";
  const callable = new Set(Array.isArray(tools)
    ? tools.map((t: { function?: { name?: unknown } }) => stripMcpPrefix(String(t.function?.name))) : []);
  const stack = openingStack.filter((t) => callable.has(stripMcpPrefix(t)));
  const hint = buildTradingHint(hintEnabled, callable, stack);
  const { messages, correctedAcknowledgements } = rewriteTradingMessages(body.messages || [], protocol, hint);
  const finalTurnDirected = isForcedFinalTurn(messages, tools, body.tool_choice, Boolean(interlock?.matchNativeExhaustionNotice));
  if (finalTurnDirected) {
    const last = messages[messages.length - 1];
    messages[messages.length - 1] = { ...last, content: last.content + "\n" + FINAL_TURN_DIRECTIVE };
  }
  const interlockFired = finalTurnDirected ? "final-turn" : applyTailInterlockNotice(messages, interlock);
  const result: Record<string, any> = { ...body, messages, ...(Array.isArray(tools) ? { tools } : {}) };
  normalizeTradingToolChoice(body, result, tools, removedTools, deniedTools);
  return {
    body: result,
    removedTools,
    correctedAcknowledgements,
    deniedTools,
    finalTurnDirected,
    interlockFired: interlock ? interlockFired : null,
    interlockVersion: interlock?.version ?? null,
  };
}
