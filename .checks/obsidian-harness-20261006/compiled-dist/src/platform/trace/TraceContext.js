import { AsyncLocalStorage } from "node:async_hooks";
export class TraceContext {
    static storage = new AsyncLocalStorage();
    static run(context, fn) {
        return this.storage.run(context, fn);
    }
    static runWithSpan(span, fn) {
        const current = this.storage.getStore();
        const newContext = {
            trace_id: span.trace_id,
            run_id: span.run_id,
            currentSpan: span,
            parentSpanId: span.parent_span_id,
            conversation_id: current?.conversation_id,
        };
        return this.storage.run(newContext, fn);
    }
    static get() {
        return this.storage.getStore();
    }
    static currentSpan() {
        return this.storage.getStore()?.currentSpan;
    }
    static currentSpanId() {
        const store = this.storage.getStore();
        return store?.currentSpan?.span_id ?? (store?.current_span_id || undefined);
    }
    static parentSpanId() {
        const store = this.storage.getStore();
        return store?.parent_span_id ?? store?.parentSpanId ?? store?.currentSpan?.parent_span_id;
    }
    static traceId() {
        return this.storage.getStore()?.trace_id;
    }
    static runId() {
        return this.storage.getStore()?.run_id;
    }
    static conversationId() {
        return this.storage.getStore()?.conversation_id;
    }
}
//# sourceMappingURL=TraceContext.js.map