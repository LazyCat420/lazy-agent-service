import crypto from "node:crypto";
import { RunStore } from "./RunStore.js";
/** Receipt-bound return channel. Acknowledgement is persisted before waking the model. */
export class LocalToolContinuation {
    static waiters = new Map();
    static async wait(runId, event, signal, emit) {
        const callId = event.data.tool_call_id;
        const key = `${runId}:${callId}`;
        await RunStore.mutateRun(runId, run => {
            if (run.pending_tools?.[callId])
                throw new Error("Duplicate tool call ID");
            return { status: "waiting_for_tool", pending_tools: { ...run.pending_tools, [callId]: { event: event.data } } };
        });
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const finish = (value, error) => {
                clearTimeout(timer);
                signal.removeEventListener("abort", abort);
                this.waiters.delete(key);
                if (error)
                    reject(error);
                else
                    resolve(value);
            };
            const abort = () => finish(undefined, new Error("Local execution cancelled"));
            const expiry = Date.parse(event.data.authorization_receipt.expires_at);
            const timer = setTimeout(() => finish(undefined, new Error("Local tool result expired")), Math.max(0, expiry - Date.now()));
            this.waiters.set(key, { resolve: value => finish(value), reject: error => finish(undefined, error) });
            signal.addEventListener("abort", abort, { once: true });
            try {
                emit();
            }
            catch (err) {
                finish(undefined, err);
            }
        });
    }
    /** Verify before an app-owned side effect; signing material never leaves the server. */
    static async verify(runId, callId, supplied) {
        const run = await RunStore.getRun(runId);
        const pending = run?.pending_tools?.[callId];
        const fail = (message) => { throw Object.assign(new Error(message), { status: 409 }); };
        if (!pending || !supplied || typeof supplied.signature !== "string")
            fail("Unknown call or missing signed receipt");
        const receipt = pending.event.authorization_receipt;
        const expected = Buffer.from(receipt.signature);
        const actual = Buffer.from(supplied.signature);
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)
            || Object.keys(receipt).some(key => key !== "signature" && JSON.stringify(supplied[key]) !== JSON.stringify(receipt[key]))
            || Object.keys(supplied).length !== Object.keys(receipt).length)
            fail("Tool admission scope or signature mismatch");
        if (!pending.result_digest && (!run || !["running", "waiting_for_tool"].includes(run.status)
            || Date.parse(receipt.expires_at) <= Date.now() || !this.waiters.has(`${runId}:${callId}`)))
            fail("Execution is no longer active or admission expired");
    }
    static async submit(runId, callId, payload) {
        await this.verify(runId, callId, payload?.authorization_receipt);
        const run = await RunStore.getRun(runId);
        const pending = run?.pending_tools?.[callId];
        const fail = (message) => { throw Object.assign(new Error(message), { status: 409 }); };
        if (!pending)
            return fail("Unknown pending tool call");
        const receipt = pending.event.authorization_receipt;
        const supplied = payload?.authorization_receipt;
        if (!supplied || typeof supplied.signature !== "string" || typeof payload.is_error !== "boolean" || !("result" in payload)) {
            return fail("A signed receipt, result and boolean is_error are required");
        }
        const expected = Buffer.from(receipt.signature);
        const actual = Buffer.from(supplied.signature);
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)
            || supplied.run_id !== runId || supplied.tool_call_id !== callId
            || supplied.app_id !== receipt.app_id || supplied.session_id !== receipt.session_id
            || supplied.arguments_hash !== receipt.arguments_hash)
            return fail("Tool result scope or signature mismatch");
        const observation = { result: payload.result, is_error: payload.is_error };
        const digest = crypto.createHash("sha256").update(JSON.stringify(observation)).digest("hex");
        if (pending.result_digest) {
            if (pending.result_digest !== digest)
                return fail("Conflicting duplicate tool result");
            return { duplicate: true };
        }
        if (!run || !["running", "waiting_for_tool"].includes(run.status) || Date.parse(receipt.expires_at) <= Date.now()) {
            return fail("Run or authorization has expired");
        }
        const waiter = this.waiters.get(`${runId}:${callId}`);
        if (!waiter)
            return fail("Execution is no longer active; inspect the run outcome");
        await RunStore.mutateRun(runId, current => {
            const previous = current.pending_tools?.[callId];
            if (previous?.result_digest)
                return fail("Concurrent duplicate result; retry acknowledgement");
            const pending_tools = { ...current.pending_tools, [callId]: { ...pending, result_digest: digest, observation } };
            return { pending_tools, status: Object.values(pending_tools).every(p => p.result_digest) ? "running" : "waiting_for_tool" };
        });
        waiter.resolve(payload.is_error ? { ok: false, is_error: true, result: payload.result } : payload.result);
        return { duplicate: false };
    }
}
//# sourceMappingURL=LocalToolContinuation.js.map