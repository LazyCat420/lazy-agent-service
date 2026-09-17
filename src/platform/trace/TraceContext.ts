import { AsyncLocalStorage } from "node:async_hooks";
import type { Span } from "./Span.ts";

export interface ActiveTraceContext {
  trace_id: string;
  run_id: string;
  currentSpan?: Span;
  current_span_id?: string | null;
  parentSpanId?: string | null;
  parent_span_id?: string | null;
  conversation_id?: string | null;
}

export class TraceContext {
  private static storage = new AsyncLocalStorage<ActiveTraceContext>();

  static run<T>(context: ActiveTraceContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  static runWithSpan<T>(span: Span, fn: () => T): T {
    const current = this.storage.getStore();
    const newContext: ActiveTraceContext = {
      trace_id: span.trace_id,
      run_id: span.run_id,
      currentSpan: span,
      parentSpanId: span.parent_span_id,
      conversation_id: current?.conversation_id,
    };
    return this.storage.run(newContext, fn);
  }

  static get(): ActiveTraceContext | undefined {
    return this.storage.getStore();
  }

  static currentSpan(): Span | undefined {
    return this.storage.getStore()?.currentSpan;
  }

  static currentSpanId(): string | undefined {
    const store = this.storage.getStore();
    return store?.currentSpan?.span_id ?? (store?.current_span_id || undefined);
  }

  static parentSpanId(): string | null | undefined {
    const store = this.storage.getStore();
    return store?.parent_span_id ?? store?.parentSpanId ?? store?.currentSpan?.parent_span_id;
  }

  static traceId(): string | undefined {
    return this.storage.getStore()?.trace_id;
  }

  static runId(): string | undefined {
    return this.storage.getStore()?.run_id;
  }

  static conversationId(): string | null | undefined {
    return this.storage.getStore()?.conversation_id;
  }
}
