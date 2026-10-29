/**
 * Bounded, run-scoped evidence store for deterministic verifiers.
 *
 * Decouples verifiers from the network exporter queue:
 * 1. Verifiers inspect only spans belonging to their specific run_id.
 * 2. Exporter queue flushes or drops do NOT alter verification evidence.
 * 3. Two concurrent workflows cannot borrow each other's verification evidence.
 * 4. Bounded per run (max 500 spans) to prevent memory leaks.
 */
export class RunEvidenceStore {
    static instance = null;
    runs = new Map();
    maxSpansPerRun;
    maxRuns;
    constructor(options = {}) {
        this.maxSpansPerRun = options.maxSpansPerRun || 500;
        this.maxRuns = options.maxRuns || 100;
    }
    static getGlobalInstance() {
        if (!this.instance) {
            this.instance = new RunEvidenceStore();
        }
        return this.instance;
    }
    static setGlobalInstance(store) {
        this.instance = store;
    }
    record(span) {
        const runId = span.run_id;
        if (!runId || runId === "unassigned_run")
            return;
        let spans = this.runs.get(runId);
        if (!spans) {
            if (this.runs.size >= this.maxRuns) {
                // Drop oldest run
                const oldest = this.runs.keys().next().value;
                if (oldest)
                    this.runs.delete(oldest);
            }
            spans = [];
            this.runs.set(runId, spans);
        }
        if (spans.length >= this.maxSpansPerRun) {
            // Drop oldest 10%
            spans.splice(0, Math.floor(this.maxSpansPerRun * 0.1));
        }
        spans.push(span);
    }
    getSpans(runId) {
        if (!runId)
            return [];
        return [...(this.runs.get(runId) || [])];
    }
    has(runId) {
        return this.runs.has(runId);
    }
    clear(runId) {
        this.runs.delete(runId);
    }
    clearAll() {
        this.runs.clear();
    }
    getActiveRunIds() {
        return Array.from(this.runs.keys());
    }
}
//# sourceMappingURL=RunEvidenceStore.js.map