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

  private reserveTokensForStream(
    messages: unknown[],
    options: any,
  ): { inputReserve: number; outputReserve: number; reservation: number; finalizing: boolean } {
    this.signal.throwIfAborted();
    const inputReserve =
      Math.ceil(JSON.stringify({ messages, tools: options.tools || [] }).length / 3.5) + 256;
    const finalReserve = Math.min(4096, Math.floor(this.limit * 0.15));
    const finalizing = this.finalPassAllowed;
    const available =
      this.limit -
      this.chargedTokens -
      inputReserve -
      (finalizing ? 0 : inputReserve + finalReserve);
    if (!finalizing && available <= 0) {
      throw Object.assign(
        new Error("Canonical token budget cannot cover the next prompt"),
        { code: "TOKEN_BUDGET_FINALIZE" },
      );
    }
    const outputReserve = finalizing
      ? Math.max(
          1,
          Math.min(
            options.maxTokens ?? finalReserve,
            Math.max(available, finalReserve),
            this.outputLimit,
          ),
        )
      : Math.min(options.maxTokens ?? available, available, this.outputLimit);
    if (outputReserve <= 0) {
      throw Object.assign(
        new Error("Canonical output budget cannot cover the next prompt"),
        { code: "TOKEN_BUDGET_FINALIZE" },
      );
    }
    const reservation = inputReserve + outputReserve;
    this.chargedTokens += reservation;
    this.calls++;
    return { inputReserve, outputReserve, reservation, finalizing };
  }

  private extractChunkUsageMetrics(chunk: any): {
    measuredInput?: number;
    measuredOutput?: number;
    emittedBytes: number;
  } {
    if (chunk?.type === "usage") {
      const u = chunk.usage || {};
      const input = u.inputTokens ?? u.promptTokens ?? u.prompt_tokens;
      const output = u.outputTokens ?? u.completionTokens ?? u.completion_tokens;
      return {
        measuredInput: Number.isFinite(input) && input >= 0 ? input : undefined,
        measuredOutput: Number.isFinite(output) && output >= 0 ? output : undefined,
        emittedBytes: 0,
      };
    }
    const serialized = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
    return { emittedBytes: Buffer.byteLength(serialized, "utf8") };
  }

  private reconcileStreamBudget(
    measuredInput: number | undefined,
    measuredOutput: number | undefined,
    streamCompleted: boolean,
    inputReserve: number,
    outputReserve: number,
    reservation: number,
    emittedBytes: number,
  ): void {
    if (measuredInput !== undefined) this.inputTokens += measuredInput;
    if (measuredOutput !== undefined) this.outputTokens += measuredOutput;
    if (measuredInput !== undefined && measuredOutput !== undefined) {
      this.measuredCalls++;
      this.chargedTokens += measuredInput + measuredOutput - reservation;
    } else if (streamCompleted) {
      this.chargedTokens +=
        inputReserve + Math.min(outputReserve, emittedBytes) - reservation;
    }
  }

  private async *runBudgetedStream(
    target: any,
    method: (...args: any[]) => AsyncIterable<any>,
    messages: unknown[],
    model: string,
    options: any = {},
  ): AsyncGenerator<any, void, unknown> {
    const { inputReserve, outputReserve, reservation, finalizing } =
      this.reserveTokensForStream(messages, options);
    let emittedBytes = 0;
    let streamCompleted = false;
    let measuredInput: number | undefined;
    let measuredOutput: number | undefined;
    const callSignal = options.signal
      ? AbortSignal.any([this.signal, options.signal])
      : this.signal;
    try {
      const stream = method.call(target, messages, model, {
        ...options,
        maxTokens: outputReserve,
        signal: callSignal,
      });
      for await (const chunk of stream) {
        if (callSignal.aborted) {
          if (options.signal?.aborted) options.signal.throwIfAborted();
          else this.signal.throwIfAborted();
        }
        const metrics = this.extractChunkUsageMetrics(chunk);
        if (metrics.measuredInput !== undefined) measuredInput = metrics.measuredInput;
        if (metrics.measuredOutput !== undefined) measuredOutput = metrics.measuredOutput;
        emittedBytes += metrics.emittedBytes;
        yield chunk;
      }
      streamCompleted = true;
    } finally {
      this.reconcileStreamBudget(
        measuredInput,
        measuredOutput,
        streamCompleted,
        inputReserve,
        outputReserve,
        reservation,
        emittedBytes,
      );
    }
    if (!finalizing && this.chargedTokens > this.limit) {
      throw Object.assign(
        new Error("Provider reported usage beyond run budget"),
        { code: "TOKEN_BUDGET_EXHAUSTED" },
      );
    }
  }

  wrap(provider: any): any {
    return new Proxy(provider, {
      get: (target, key) => {
        const method = Reflect.get(target, key);
        const isStreamMethod =
          ["generateTextStream", "generateTextStreamLive"].includes(String(key)) &&
          typeof method === "function";
        if (!isStreamMethod) {
          return typeof method === "function" ? method.bind(target) : method;
        }
        return (messages: unknown[], model: string, options: any = {}) =>
          this.runBudgetedStream(target, method, messages, model, options);
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
