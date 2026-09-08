import { attachToolContext } from "./TradingToolContext.ts";
import { getToolSchemas } from "./ToolSchemaService.ts";
import { stripMcpPrefix } from "./McpPrefix.ts";

const localTools = new Set(getToolSchemas().map(t => t.name));
function local(name: string): boolean { return typeof name === "string" && localTools.has(stripMcpPrefix(name)); }
export function bindToolResponse(response: any, token: string): any {
  return { ...response, choices: (response.choices || []).map((choice: any) => ({
    ...choice,
    ...(choice.message ? { message: { ...choice.message,
      ...(Array.isArray(choice.message.tool_calls) ? { tool_calls: choice.message.tool_calls.map((call: any) =>
        local(call.function?.name) ? { ...call, function: { ...call.function,
          arguments: attachToolContext(call.function.arguments, token) } } : call) } : {}),
    } } : {}),
  })) };
}
/** Incremental UTF-8/SSE transform. Content/reasoning/usage are forwarded;
 * only tool arguments wait for their finish event so signed context can be
 * attached deterministically, outside model generation and token accounting.
 * Nonempty argument fragments emit JSON whitespace while buffered: the provider
 * ignores empty fragments, which otherwise makes active generation look idle.
 * This is driven only by upstream argument bytes, never a timed heartbeat.
 */
export class TradingToolStream {
  private decoder = new TextDecoder();
  private pending = "";
  private calls = new Map<number, Map<number, { name: string; args: string }>>();
  constructor(private token: string) {}
  push(bytes: Uint8Array): string { return this.consume(this.decoder.decode(bytes, { stream: true })); }
  finish(): string {
    const out = this.consume(this.decoder.decode());
    if (this.pending.trim() || this.calls.size) throw new Error("Incomplete trading tool stream");
    return out;
  }
  private consume(text: string): string {
    this.pending += text;
    let output = "";
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.pending))) {
      const event = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      output += this.event(event);
    }
    if (this.pending.length > 2_000_000) throw new Error("Trading SSE event exceeds bound");
    return output;
  }
  private event(event: string): string {
    const lines = event.split(/\r?\n/);
    const data = lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") {
      if (data === "[DONE]" && this.calls.size) throw new Error("Tool stream ended without a finish event");
      return event + "\n\n";
    }
    const parsed = JSON.parse(data);
    const frames: any[] = [];
    const frame = (index: number, calls: any[]) => ({
      id: parsed.id, object: parsed.object, created: parsed.created, model: parsed.model,
      choices: [{ index, delta: { tool_calls: calls }, finish_reason: null }],
    });
    for (const choice of parsed.choices || []) {
      const ci = choice.index ?? 0;
      const chunks = choice.delta?.tool_calls;
      if (Array.isArray(chunks)) {
        let calls = this.calls.get(ci);
        if (!calls) this.calls.set(ci, calls = new Map());
        choice.delta.tool_calls = chunks.map((chunk: any) => {
          const index = chunk.index ?? 0;
          const state = calls!.get(index) || { name: "", args: "" };
          state.name += chunk.function?.name || "";
          state.args += chunk.function?.arguments || "";
          if (state.args.length > 1_000_000) throw new Error("Trading tool arguments exceed bound");
          calls!.set(index, state);
          return { ...chunk, ...(chunk.function ? { function: { ...chunk.function, arguments: chunk.function.arguments ? " " : "" } } : {}) };
        });
      }
      if (choice.finish_reason && this.calls.has(ci)) {
        const calls = this.calls.get(ci)!;
        if (choice.finish_reason !== "tool_calls" && choice.finish_reason !== "stop") throw new Error("Incomplete trading tool arguments");
        if (chunks?.length) frames.push(frame(ci, choice.delta.tool_calls));
        frames.push(frame(ci, [...calls].map(([index, state]) => ({ index,
          function: { arguments: local(state.name) ? attachToolContext(state.args, this.token) : state.args },
        }))));
        this.calls.delete(ci);
        if (choice.delta) delete choice.delta.tool_calls;
      }
    }
    return frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("") + `data: ${JSON.stringify(parsed)}\n\n`;
  }
}
