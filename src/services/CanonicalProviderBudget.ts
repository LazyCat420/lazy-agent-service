/** One accounting boundary for every model call, including repair and compaction. */
export class CanonicalProviderBudget {
  calls = 0;
  measuredCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  chargedTokens = 0;
  constructor(readonly limit: number, readonly signal: AbortSignal) {}

  wrap(provider: any): any {
    const budget = this;
    return new Proxy(provider, {
      get(target, key) {
        const method = Reflect.get(target, key);
        if (!["generateTextStream", "generateTextStreamLive"].includes(String(key)) || typeof method !== "function") return typeof method === "function" ? method.bind(target) : method;
        return async function* (messages: unknown[], model: string, options: any = {}) {
          budget.signal.throwIfAborted();
          // Conservative reservation is separate from measured usage. Do not invent billing data.
          const inputReserve = Buffer.byteLength(JSON.stringify({ messages, tools: options.tools || [] }), "utf8") + 256;
          const available = budget.limit - budget.chargedTokens - inputReserve;
          if (available <= 0) throw Object.assign(new Error("Canonical token budget cannot cover the next prompt"), { code: "TOKEN_BUDGET_EXHAUSTED" });
          const outputReserve = Math.min(options.maxTokens ?? available, available);
          if (outputReserve <= 0) throw Object.assign(new Error("Canonical output budget exhausted"), { code: "TOKEN_BUDGET_EXHAUSTED" });
          const reservation = inputReserve + outputReserve;
          budget.chargedTokens += reservation;
          budget.calls++;
          let measuredInput: number | undefined, measuredOutput: number | undefined;
          try {
            for await (const chunk of method.call(target, messages, model, { ...options, maxTokens: outputReserve, signal: budget.signal })) {
              budget.signal.throwIfAborted();
              if (chunk?.type === "usage") {
                const u = chunk.usage || {};
                const input = u.inputTokens ?? u.promptTokens ?? u.prompt_tokens;
                const output = u.outputTokens ?? u.completionTokens ?? u.completion_tokens;
                if (Number.isFinite(input) && input >= 0) measuredInput = input;
                if (Number.isFinite(output) && output >= 0) measuredOutput = output;
              }
              yield chunk;
            }
          } finally {
            if (measuredInput !== undefined) budget.inputTokens += measuredInput;
            if (measuredOutput !== undefined) budget.outputTokens += measuredOutput;
            if (measuredInput !== undefined && measuredOutput !== undefined) {
              budget.measuredCalls++;
              budget.chargedTokens += measuredInput + measuredOutput - reservation;
            }
          }
          if (budget.chargedTokens > budget.limit) throw Object.assign(new Error("Provider reported usage beyond run budget"), { code: "TOKEN_BUDGET_EXHAUSTED" });
        };
      },
    });
  }
  usage(toolCalls: number, duration: number) {
    const complete = this.calls > 0 && this.measuredCalls === this.calls;
    return {
      prompt_tokens: complete ? this.inputTokens : null,
      completion_tokens: complete ? this.outputTokens : null,
      total_tokens: complete ? this.inputTokens + this.outputTokens : null,
      tool_calls_count: toolCalls, retry_count: 0, duration_ms: duration,
      coverage: { model_calls: this.calls, measured_calls: this.measuredCalls, state: complete ? "complete" : this.measuredCalls ? "partial" : "unknown", measured_prompt_tokens: this.inputTokens, measured_completion_tokens: this.outputTokens },
    };
  }
}
