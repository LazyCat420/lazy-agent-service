import type { ChatMessage, StreamChunk } from "../../types/provider.ts";
import type { CoreModel, CoreModelRequest } from "../../core/loop/types.ts";
import {
  pickPoolModel,
  recordPoolServed,
  releasePoolInFlight,
  selectPoolMember,
  type PoolMember,
} from "../vllm/VllmPool.ts";
import { VllmShimService } from "../vllm/VllmShimService.ts";

export interface PoolCallResult {
  boxName: string;
  boxIp: string;
  modelId: string;
  sameBoxFallback: boolean;
}

export interface PoolModelCallParams {
  preferredMember?: string;
  temperature: number;
  seed?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

function toOpenAiMessage(msg: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: msg.role,
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
  };
  if (typeof msg.tool_call_id === "string" && msg.tool_call_id) {
    out.tool_call_id = msg.tool_call_id;
  }
  if (typeof msg.name === "string" && msg.name) {
    out.name = msg.name;
  }
  if (msg.role === "assistant" && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
    out.tool_calls = msg.toolCalls.map((tc, idx) => ({
      id: tc.id || `call_${idx}`,
      type: "function",
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.args || {}),
      },
    }));
  }
  return out;
}

function safeParseArgs(raw: unknown): { args: Record<string, unknown>; parseError: boolean; rawText: string } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { args: raw as Record<string, unknown>, parseError: false, rawText: "" };
  }
  const text = typeof raw === "string" ? raw : "{}";
  try {
    const parsed = JSON.parse(text || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, parseError: false, rawText: text };
    }
    return { args: {}, parseError: true, rawText: text };
  } catch {
    return { args: {}, parseError: true, rawText: text };
  }
}

export async function discoverPoolModel(member: PoolMember): Promise<string> {
  const resp = await fetch(`${member.url.replace(/\/$/, "")}/v1/models`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) {
    throw new Error(`GET ${member.url}/v1/models returned HTTP ${resp.status}`);
  }
  const id = pickPoolModel(await resp.json());
  if (!id) {
    throw new Error(`No generation model reported by ${member.name} (${member.url}/v1/models)`);
  }
  return id;
}

export async function acquireLocalPoolTarget(preferredMember?: string): Promise<{
  member: PoolMember;
  modelId: string;
  sameBoxFallback: boolean;
}> {
  const selection = await selectPoolMember({
    preferredMember,
    body: {},
    headers: preferredMember ? { "x-pool-prefer-member": preferredMember } : undefined,
  });
  let released = false;
  try {
    for (const candidate of selection.candidates) {
      try {
        const modelId = await discoverPoolModel(candidate);
        if (candidate.name !== selection.member.name) {
          releasePoolInFlight(selection.member.name);
        }
        return {
          member: candidate,
          modelId,
          sameBoxFallback:
            Boolean(selection.sameBoxFallback) ||
            (Boolean(preferredMember) && candidate.name !== preferredMember),
        };
      } catch {
        // try next healthy candidate
      }
    }
    throw new Error("No healthy local DeepSeek pool box available from /v1/models");
  } catch (err) {
    if (!released) {
      releasePoolInFlight(selection.member.name);
      released = true;
    }
    throw err;
  }
}

function buildCompletionPayload(
  modelId: string,
  request: CoreModelRequest,
  params: PoolModelCallParams,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: modelId,
    messages: request.messages.map(toOpenAiMessage),
    temperature: params.temperature,
    max_tokens: params.maxTokens ?? 4096,
    stream: false,
    enable_thinking: false,
    chat_template_kwargs: { thinking: false, enable_thinking: false },
  };
  if (typeof params.seed === "number") {
    payload.seed = params.seed;
  }
  if (request.tools.length > 0 && request.toolChoice !== "none") {
    payload.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    payload.tool_choice = "auto";
  }
  return payload;
}

function toToolCallChunk(tc: any, index: number): StreamChunk {
  const fn = tc?.function || {};
  const { args, parseError, rawText } = safeParseArgs(fn.arguments);
  return {
    type: "toolCall",
    id: typeof tc?.id === "string" && tc.id ? tc.id : `call_${index}`,
    name: String(fn.name || ""),
    args,
    native: true,
    ...(parseError ? { argsParseError: true, rawArgs: rawText.slice(0, 2000) } : {}),
  };
}

function completionChunks(parsed: Record<string, any>, allowTools: boolean): StreamChunk[] {
  const out: StreamChunk[] = [];
  const choice = parsed?.choices?.[0] || {};
  const msg = choice.message || {};
  if (typeof msg.content === "string" && msg.content) out.push(msg.content);
  if (allowTools && Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((tc: unknown, idx: number) => out.push(toToolCallChunk(tc, idx)));
  }
  if (choice.finish_reason === "length") out.push({ type: "stopReason", stopReason: "length" });
  if (parsed?.usage) {
    out.push({
      type: "usage",
      usage: {
        inputTokens: Number(parsed.usage.prompt_tokens || 0),
        outputTokens: Number(parsed.usage.completion_tokens || 0),
      },
    });
  }
  return out;
}

/**
 * Create a `CoreModel` backed by a local pool member (`gold-spark` or `dell2`)
 * discovered via `/v1/models`. Releases pool in-flight accounting on every exit.
 */
export function createPoolCoreModel(
  target: { member: PoolMember; modelId: string },
  params: PoolModelCallParams,
): CoreModel {
  return (request: CoreModelRequest): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
      const url = `${target.member.url.replace(/\/$/, "")}/v1/chat/completions`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCompletionPayload(target.modelId, request, params)),
        signal: request.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`vLLM ${target.member.name} HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const rawJson = (await res.json()) as Record<string, any>;
      const allowTools = request.tools.length > 0 && request.toolChoice !== "none";
      const parsed = allowTools ? VllmShimService.normalizeToolCalls(rawJson) : rawJson;
      for (const chunk of completionChunks(parsed, allowTools)) {
        yield chunk;
      }
      recordPoolServed(target.member.name);
    },
  });
}

export function releasePoolTarget(memberName: string): void {
  releasePoolInFlight(memberName);
}
