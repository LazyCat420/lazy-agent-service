/** One accounting boundary for every model call, including repair and compaction. */
export class CanonicalProviderBudget {
  calls = 0;
  measuredCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  chargedTokens = 0;
  /** Set by allowFinalPass(): the next call may consume the final reserve. */
  private finalPassAllowed = false;

  allowFinalPass(): void {
    this.finalPassAllowed = true;
  }
  constructor(readonly limit: number, readonly signal: AbortSignal, readonly outputLimit: number = Infinity) {}

  chargeExternalUsage(promptTokens: number, completionTokens: number): void {
    if (![promptTokens, completionTokens].every(value => Number.isInteger(value) && value >= 0)) {
      throw Object.assign(new Error("Worker reported invalid token usage"), { code: "WORKER_USAGE_INVALID" });
    }
    const total = promptTokens + completionTokens;
    this.chargedTokens += total;
    this.inputTokens += promptTokens;
    this.outputTokens += completionTokens;
    this.calls += 1;
    this.measuredCalls += 1;
    if (this.chargedTokens > this.limit) {
      throw Object.assign(new Error("Worker usage exceeded the canonical run budget"), { code: "TOKEN_BUDGET_EXHAUSTED" });
    }
  }

  wrap(provider: any): any {
    return new Proxy(provider, {
      get: (target, key) => {
        const method = Reflect.get(target, key);
        if (!["generateTextStream", "generateTextStreamLive"].includes(String(key)) || typeof method !== "function") return typeof method === "function" ? method.bind(target) : method;
        return async function* (this: CanonicalProviderBudget, messages: unknown[], model: string, options: any = {}) {
          this.signal.throwIfAborted();
          // Conservative reservation is separate from measured usage. Do not invent billing data.
          // Chars→tokens estimate (~3.5 chars/token), never bytes: byteLength overcounts several-fold.
          const inputReserve = Math.ceil(JSON.stringify({ messages, tools: options.tools || [] }).length / 3.5) + 256;
          // Reserve kept untouched by normal calls so a final tool-free answer pass always fits.
          const finalReserve = Math.min(4096, Math.floor(this.limit * 0.15));
          const finalizing = this.finalPassAllowed;
          // A normal call must leave room for the final pass: it re-sends a prompt at least this large, plus its answer.
          const available = this.limit - this.chargedTokens - inputReserve - (finalizing ? 0 : inputReserve + finalReserve);
          if (!finalizing && available <= 0) throw Object.assign(new Error("Canonical token budget cannot cover the next prompt"), { code: "TOKEN_BUDGET_FINALIZE" });
          // The final answer pass is never refused (always-answer outranks the spend cap); it may overrun by this one call.
          const outputReserve = finalizing
            ? Math.max(1, Math.min(options.maxTokens ?? finalReserve, Math.max(available, finalReserve), this.outputLimit))
            : Math.min(options.maxTokens ?? available, available, this.outputLimit);
          if (outputReserve <= 0) throw Object.assign(new Error("Canonical output budget cannot cover the next prompt"), { code: "TOKEN_BUDGET_FINALIZE" });
          const reservation = inputReserve + outputReserve;
          this.chargedTokens += reservation;
          this.calls++;
          let emittedBytes = 0;
          let streamCompleted = false;
          let measuredInput: number | undefined, measuredOutput: number | undefined;
          const callSignal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
          try {
            for await (const chunk of method.call(target, messages, model, { ...options, maxTokens: outputReserve, signal: callSignal })) {
              if (callSignal.aborted) {
                if (options.signal?.aborted) options.signal.throwIfAborted();
                else this.signal.throwIfAborted();
              }
              if (chunk?.type === "usage") {
                const u = chunk.usage || {};
                const input = u.inputTokens ?? u.promptTokens ?? u.prompt_tokens;
                const output = u.outputTokens ?? u.completionTokens ?? u.completion_tokens;
                if (Number.isFinite(input) && input >= 0) measuredInput = input;
                if (Number.isFinite(output) && output >= 0) measuredOutput = output;
              }
              if (chunk?.type !== "usage") emittedBytes += Buffer.byteLength(typeof chunk === "string" ? chunk : JSON.stringify(chunk), "utf8");
              yield chunk;
            }
            streamCompleted = true;
          } finally {
            if (measuredInput !== undefined) this.inputTokens += measuredInput;
            if (measuredOutput !== undefined) this.outputTokens += measuredOutput;
            if (measuredInput !== undefined && measuredOutput !== undefined) {
              this.measuredCalls++;
              this.chargedTokens += measuredInput + measuredOutput - reservation;
            } else if (streamCompleted) {
              // Conservative observed bytes release unused output reservation.
              // The public usage total remains unknown, with coverage explicit.
              this.chargedTokens += inputReserve + Math.min(outputReserve, emittedBytes) - reservation;
            }
          }
          if (!finalizing && this.chargedTokens > this.limit) throw Object.assign(new Error("Provider reported usage beyond run budget"), { code: "TOKEN_BUDGET_EXHAUSTED" });
        }.bind(this);
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
