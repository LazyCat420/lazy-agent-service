/**
 * InternalLoopRunner — gives lazy-agent-service's own internal callers
 * (ConversationTimerService, ScheduledTaskService, OrchestratorService
 * sub-agents) the same profile admission, capability resolution, and
 * receipt-bound local-tool execution that /v1/runs gets, without forcing
 * them onto the HTTP run API.
 *
 * Usage:
 *   const admission = await InternalLoopRunner.admit({
 *     profileId: "scheduled-tasks-v1",       // optional — no profile → undefined
 *     appId: "scheduled-tasks",
 *     sessionId: task.id,
 *     enabledTools: task.toolConfig?.enabledTools,
 *     allowedGlobalCapabilities: profile.allowed_global_capabilities,
 *     allowedLocalTools: profile.allowed_local_tools,
 *     localToolPolicy: profile.local_tool_policy,
 *   });
 *   // then spread into the AgenticLoopService context:
 *   await AgenticLoopService.runAgenticLoop({
 *     ...existingContext,
 *     ...(admission ?? {}),
 *   });
 *
 * `undefined` admission means "no runtimeTools/runtimeToolExecutor fields" —
 * AgenticLoopService resolves tools the legacy way, byte-identical to today.
 */
import crypto from "node:crypto";
import { ProfileRegistry } from "./ProfileRegistry.js";
import { CapabilityRegistry } from "./CapabilityRegistry.js";
import { RunExecutionEngine } from "./RunExecutionEngine.js";
import { LocalToolContinuation } from "./LocalToolContinuation.js";
import { z } from "zod";
/** Build the runtime tool list from a profile's capability + local tool admission. */
function buildFinalTools(profile, callerTools) {
    const callerSet = callerTools ? new Set(callerTools.map((t) => t.split("@")[0])) : null;
    const finalTools = [];
    for (const ref of profile.allowed_global_capabilities || []) {
        const name = ref.split("@")[0];
        if (callerSet && !callerSet.has(name))
            continue;
        const cap = CapabilityRegistry.listCapabilities().find((c) => c.id === name);
        if (cap)
            finalTools.push({ name, description: cap.description, parameters: cap.parameters });
    }
    for (const ref of profile.allowed_local_tools || []) {
        const name = ref.split("@")[0];
        if (callerSet && !callerSet.has(name))
            continue;
        finalTools.push({ name, description: `Local tool ${name} (profile-admitted)`, parameters: { type: "object", properties: {} } });
    }
    return finalTools;
}
export class InternalLoopRunner {
    /**
     * Resolve a profile into loop context fields. Returns undefined when no
     * profileId is given or the profile fails to load — callers spread the
     * result and proceed exactly as before.
     */
    static async admit(req) {
        if (!req.profileId)
            return undefined;
        let profile = null;
        try {
            profile = await ProfileRegistry.loadProfile(req.profileId);
        }
        catch {
            return undefined;
        }
        if (!profile)
            return undefined;
        const runId = req.runId || `internal-${crypto.randomUUID()}`;
        const finalTools = buildFinalTools(profile, req.enabledTools);
        const appId = req.appId;
        const sessionId = req.sessionId;
        const profileVersion = profile.version;
        const onEvent = req.onEvent;
        const toolValidators = new Map();
        for (const schema of finalTools) {
            try {
                toolValidators.set(schema.name, z.fromJSONSchema(schema.parameters));
            }
            catch {
                toolValidators.delete(schema.name);
            }
        }
        const runtimeToolExecutor = async (call) => {
            req.signal?.throwIfAborted();
            const validator = toolValidators.get(call.name);
            if (validator && !validator.safeParse(call.args || {}).success) {
                throw Object.assign(new Error("Tool arguments do not match the admitted schema"), { code: "TOOL_ARGUMENTS_INVALID" });
            }
            const processed = await RunExecutionEngine.processToolCall(runId, call, {
                profile_id: profile.profile_id,
                profile_version: profileVersion,
                app_id: appId,
                session_id: sessionId,
                signal: req.signal,
            }, (event) => onEvent?.(event));
            if (processed.status === "denied") {
                throw Object.assign(new Error(processed.error?.message || "Tool denied"), { code: processed.error?.code });
            }
            if (processed.status === "admitted_local") {
                onEvent?.({ type: processed.event.type, tool_name: call.name });
                const observation = await LocalToolContinuation.wait(runId, processed.event, req.signal, () => onEvent?.(processed.event));
                onEvent?.({ type: "tool.completed", tool_name: call.name });
                return observation;
            }
            // Non-local admitted calls (global capabilities) resolve server-side.
            return processed.result;
        };
        return {
            runtimeTools: { finalTools, resolvedEnabledTools: finalTools.map((t) => t.name) },
            runtimeToolExecutor,
            runId,
            profile,
        };
    }
}
//# sourceMappingURL=InternalLoopRunner.js.map