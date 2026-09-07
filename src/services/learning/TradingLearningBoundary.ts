/** Trading's learning boundary lives in our proxy/shim, never in Prism.
 * The model input filter is fail-closed for upstream learned context; it does
 * not alter the original research evidence, role prompt, tool results or policy.
 */
import { createHash } from "node:crypto";
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
  const identity = Buffer.from(JSON.stringify({ conversationId: body.conversationId || null,
    agent: body.agent || null, project: body.project })).toString("base64url");
  const marker = `<${MARKER}>${identity}</${MARKER}>`;
  const systemPrompt = `${marker}\n${body.systemPrompt || ""}`;
  if (user) messages.push({ role: "user", content: compactQuery(user.content, String(body.agent || "trading analyst")) });
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
  return { body: { ...body, messages: filtered }, receipt: {
    id: digest(`${identity.conversationId}:${payload}`), ...identity, contract_version: 2,
    event: "provider_payload", payload_hash: digest(payload), payload_chars: payload.length,
    excluded_chars: removedChars, excluded_tags: [...new Set(removedTags)],
    upstream_workflows_delivered: 0, upstream_facts_delivered: 0,
    application_state: "unknown", created_at: new Date(),
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
