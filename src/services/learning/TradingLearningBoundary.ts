/** Trading's learning boundary lives in our proxy/shim, never in Prism.
 * The model input filter is fail-closed for upstream learned context; it does
 * not alter the original research evidence, role prompt, tool results or policy.
 */
import { createHash, randomUUID } from "node:crypto";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { TRADING_MONGO_DB } from "../../../config.ts";
import logger from "../../logger.ts";

const MARKER = "TRADING_LEARNING_BOUNDARY_V2";
const blockedTags = ["agent-memory", "past-workflows", "project-skills"];
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const enabled = () => process.env.TRADING_LEARNING_BOUNDARY_ENABLED !== "false";

export function compactQuery(text: string, agent: string): string {
  const ticker = text.match(/^## Ticker:\s*([A-Z][A-Z0-9.-]{0,12})/m)?.[1] || "";
  const role = agent.replace(/^CUSTOM_V3_/, "").replaceAll("_", " ").toLowerCase();
  const question = text.match(/## CLAIMED RESEARCH QUESTIONS[^\n]*\n([^\n]+)/)?.[1]?.slice(0, 500) || "";
  return `Retrieval index: ${ticker} ${role} ${question}. Complete the original task from the full evidence above; return its required artifact.`.slice(0, 1000);
}

export function prepareTradingRequest(body: Record<string, any>): Record<string, any> {
  if (!enabled() || body.project !== "vllm-trading-bot") return body;
  // /agent must traverse our model shim: upstream cloud routes have no final
  // payload filtering seam that we own. Do not silently admit legacy memory.
  if (typeof body.provider !== "string" || !/^vllm(?:-\d+)?$/.test(body.provider)) {
    throw new Error("Trading learning boundary requires a configured vLLM shim provider");
  }
  const messages = Array.isArray(body.messages) ? body.messages.map((m: any) => ({ ...m })) : [];
  const user = [...messages].reverse().find((m: any) => m.role === "user" && typeof m.content === "string");
  // /agent rebuilds the turn from the LAST user message. Appending a retrieval
  // index replaced the brief with "CRWV board of directors", causing the Board
  // to research corporate directors instead of making a trading decision.
  const task = user?.content || "";
  const identity = Buffer.from(JSON.stringify({ conversationId: body.conversationId || null,
    agent: body.agent || null, project: body.project,
    cycle_id: task.match(/^## Cycle:[ \t]*([^\r\n]+)/m)?.[1] || null,
    ticker: task.match(/^## Ticker:[ \t]*([^\r\n]+)/m)?.[1] || null,
    parent_span_id: task.match(/^## Trace Parent:[ \t]*([a-f0-9]{16})/m)?.[1] || null,
    expected_user_hash: user ? digest(task) : null, expected_user_chars: task.length,
  })).toString("base64url");
  const marker = `<${MARKER}>${identity}</${MARKER}>`;
  const systemPrompt = `${marker}\n${body.systemPrompt || ""}`;
  return { ...body, systemPrompt, messages };
}

export function filterTradingPayload(body: Record<string, any>): { body: Record<string, any>; receipt: Record<string, any> | null } {
  const messages = body.messages;
  if (!Array.isArray(messages)) return { body, receipt: null };
  const markerRe = new RegExp(`<${MARKER}>([A-Za-z0-9_-]+)</${MARKER}>`);
  const marker = messages.find((m: any) => m.role === "system" && typeof m.content === "string" && markerRe.test(m.content));
  if (!marker) return { body, receipt: null };
  let identity: Record<string, any>;
  try { identity = JSON.parse(Buffer.from(marker.content.match(markerRe)[1], "base64url").toString()); }
  catch { throw new Error("Malformed trading learning boundary identity"); }
  let removedChars = 0;
  const removedTags: string[] = [];
  const filtered = messages.map((message: any) => {
    // Upstream context is emitted as system messages. Preserve user quotes and
    // tool results even when their evidence contains markup with these names.
    if (message.role !== "system" || typeof message.content !== "string") return message;
    let content = message.content;
    for (const tag of blockedTags) {
      const pair = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "gi");
      content = content.replace(pair, (block: string) => { removedChars += block.length; removedTags.push(tag); return ""; });
      if (new RegExp(`<\\/?${tag}(?:\\s|>)`, "i").test(content)) {
        throw new Error(`Malformed upstream learned-context tag: ${tag}`);
      }
    }
    content = content.replace(new RegExp(`<${MARKER}>[A-Za-z0-9_-]+</${MARKER}>`, "g"), "");
    return { ...message, content };
  });
  const payload = JSON.stringify(filtered);
  const taskDelivered = identity.expected_user_hash
    ? filtered.some((m: any) => m.role === "user" && typeof m.content === "string" && digest(m.content) === identity.expected_user_hash)
    : null;
  if (taskDelivered === false) {
    throw new Error("Trading task delivery failed: original user brief is missing or changed in provider payload");
  }
  return { body: { ...body, messages: filtered }, receipt: {
    id: digest(`${identity.conversationId}:${payload}`), ...identity, contract_version: 2,
    event: "provider_payload", payload_hash: digest(payload), payload_chars: payload.length,
    excluded_chars: removedChars, excluded_tags: [...new Set(removedTags)],
    upstream_workflows_delivered: 0, upstream_facts_delivered: 0,
    application_state: "unknown", created_at: new Date(),
    task_delivery: taskDelivered === null ? "legacy_unknown" : "exact",
  } };
}

export async function recordPayload(receipt: Record<string, any> | null): Promise<void> {
  if (!receipt) return;
  try {
    const db = MongoWrapper.getDb(TRADING_MONGO_DB);
    if (!db) throw new Error("Trading receipt database unavailable");
    await db.collection("learning_gateway_receipts").updateOne({ _id: receipt.id } as any,
      { $setOnInsert: receipt }, { upsert: true });
  } catch (error) {
    logger.error(`[TradingLearning] payload receipt failed: ${String(error)}`);
  }
}


function traceSafe(value: any): any {
  if (Array.isArray(value)) return value.map(traceSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["reasoning_content", "thinking"].includes(key))
    .map(([key, val]) => [key, /authorization|api[_-]?key|password|secret|_lazy_trading_context/i.test(key) ? "[redacted]" : traceSafe(val)]));
  return typeof value === "string" ? value.replace(/<(think|thought_process|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, "[private reasoning omitted]") : value;
}
/** Exact outgoing provider messages after owned filters/rewrites, bounded and sanitized. */
export async function recordProviderSnapshot(receipt: Record<string, any> | null, payload: any): Promise<void> {
  if (!receipt?.cycle_id) return;
  try {
    const db = MongoWrapper.getDb(TRADING_MONGO_DB);
    if (!db) throw new Error("Trading trace database unavailable");
    const raw = Buffer.from(JSON.stringify(traceSafe(payload)));
    const hash = digest(raw.toString());
    const truncated = raw.length > 256 * 1024;
    const created_at = new Date();
    const snapshot = { hash, bytes: raw.length, truncated, encoding: truncated ? "utf8-json-prefix" : "json" };
    await db.collection("pipeline_trace_blobs").updateOne({ _id:hash } as any,
      { $setOnInsert:{ ...snapshot, content:raw.subarray(0,256*1024).toString(), created_at } }, { upsert:true });
    await db.collection("pipeline_trace_events").insertOne({
      id:randomUUID(), trace_id:digest(receipt.cycle_id).slice(0,32), span_id:randomUUID().replaceAll("-", "").slice(0,16),
      parent_span_id:receipt.parent_span_id || null, cycle_id:receipt.cycle_id, ticker:receipt.ticker,
      agent:String(receipt.agent || "").toLowerCase().replace(/^custom_/, ""),
      stage:"provider.payload", created_at, schema_version:1, snapshot,
      attributes:{conversation_id:receipt.conversationId, task_delivery:receipt.task_delivery,
        payload_hash:receipt.payload_hash, model:payload.model,
        excluded_tags:receipt.excluded_tags, unpermitted_tools_removed:receipt.unpermitted_tools_removed},
    });
  } catch (error) {
    logger.error(`[TradingTrace] provider snapshot failed: ${String(error)}`);
  }
}
