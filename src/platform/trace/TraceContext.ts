import { AsyncLocalStorage } from "node:async_hooks";
import type { Span } from "./Span.ts";

export interface ActiveTraceContext {
  trace_id: string;
  run_id: string;
  currentSpan?: Span;
  parentSpanId?: string | null;
}

export class TraceContext {
  private static storage = new AsyncLocalStorage<ActiveTraceContext>();

  static run<T>(context: ActiveTraceContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  static get(): ActiveTraceContext | undefined {
    return this.storage.getStore();
  }

  static currentSpan(): Span | undefined {
    return this.storage.getStore()?.currentSpan;
  }

  static traceId(): string | undefined {
    return this.storage.getStore()?.trace_id;
  }

  static runId(): string | undefined {
    return this.storage.getStore()?.run_id;
  }
}
