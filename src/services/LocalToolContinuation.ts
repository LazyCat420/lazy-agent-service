import crypto from "node:crypto";
import { RunStore } from "./RunStore.ts";
import type { RunEvent } from "../types/run.ts";

/** Receipt-bound return channel. Acknowledgement is persisted before waking the model. */
export class LocalToolContinuation {
  private static waiters = new Map<string, { resolve: (result: unknown) => void; reject: (err: Error) => void }>();

  static async wait(runId: string, event: RunEvent, signal: AbortSignal, emit: () => void): Promise<unknown> {
    const callId = event.data.tool_call_id;
    const key = `${runId}:${callId}`;
    await RunStore.mutateRun(runId, run => {
      if (run.pending_tools?.[callId]) throw new Error("Duplicate tool call ID");
      return { status: "waiting_for_tool", pending_tools: { ...run.pending_tools, [callId]: { event: event.data } } };
    });
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (value: unknown, error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.waiters.delete(key);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(undefined, new Error("Local execution cancelled"));
      const expiry = Date.parse(event.data.authorization_receipt.expires_at);
      const timer = setTimeout(() => finish(undefined, new Error("Local tool result expired")), Math.max(0, expiry - Date.now()));
      this.waiters.set(key, { resolve: value => finish(value), reject: error => finish(undefined, error) });
      signal.addEventListener("abort", abort, { once: true });
      try { emit(); } catch (err) { finish(undefined, err as Error); }
    });
  }

  static async submit(runId: string, callId: string, payload: any): Promise<{ duplicate: boolean }> {
    const run = await RunStore.getRun(runId);
    const pending = run?.pending_tools?.[callId];
    const fail = (message: string) => { throw Object.assign(new Error(message), { status: 409 }); };
    if (!pending) return fail("Unknown pending tool call");
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
      || supplied.arguments_hash !== receipt.arguments_hash) return fail("Tool result scope or signature mismatch");
    const observation = { result: payload.result, is_error: payload.is_error };
    const digest = crypto.createHash("sha256").update(JSON.stringify(observation)).digest("hex");
    if (pending.result_digest) {
      if (pending.result_digest !== digest) return fail("Conflicting duplicate tool result");
      return { duplicate: true };
    }
    if (!run || !["running", "waiting_for_tool"].includes(run.status) || Date.parse(receipt.expires_at) <= Date.now()) {
      return fail("Run or authorization has expired");
    }
    const waiter = this.waiters.get(`${runId}:${callId}`);
    if (!waiter) return fail("Execution is no longer active; inspect the run outcome");
    await RunStore.mutateRun(runId, current => {
      const previous = current.pending_tools?.[callId];
      if (previous?.result_digest) return fail("Concurrent duplicate result; retry acknowledgement");
      const pending_tools = { ...current.pending_tools, [callId]: { ...pending, result_digest: digest, observation } };
      return { pending_tools, status: Object.values(pending_tools).every(p => p.result_digest) ? "running" : "waiting_for_tool" };
    });
    if (payload.is_error) waiter.reject(Object.assign(new Error("Local tool execution failed"), { code: "TOOL_EXECUTION_FAILED" }));
    else waiter.resolve(payload.result);
    return { duplicate: false };
  }
}
