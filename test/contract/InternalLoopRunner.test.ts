/**
 * Contract tests: InternalLoopRunner admission + internal caller wiring.
 * Verifies:
 *  1. admission resolves global capabilities into runtimeTools.finalTools
 *  2. the runtimeToolExecutor routes local-tool calls through
 *     RunExecutionEngine.processToolCall (receipt-bound) and legacy
 *     tool names stay blocked (POLICY_VIOLATION)
 *  3. absent/unknown profile → undefined admission → spread is a no-op
 *  4. the loop actually receives runtimeTools when admission succeeds
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { InternalLoopRunner } from "../../src/services/InternalLoopRunner.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
import { RunEvidenceStore } from "../../src/platform/verify/RunEvidenceStore.ts";
import AgenticLoopService from "../../src/services/AgenticLoopService.ts";
import { RunExecutionEngine } from "../../src/services/RunExecutionEngine.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("InternalLoopRunner", () => {
	const testDir = path.dirname(fileURLToPath(import.meta.url));
	const profilesDir = path.resolve(testDir, "..", "..", "profiles");

	beforeEach(async () => {
		ProfileRegistry.clear();
		RunEvidenceStore.getGlobalInstance().clearAll();
		vi.restoreAllMocks();
		await ProfileRegistry.loadProfilesFromDisk(profilesDir);
		for (const id of ProfileRegistry.getRegisteredProfileIds()) {
			const profile = await ProfileRegistry.loadProfile(id);
			ProfileRegistry.registerProfile({ ...profile!, plugins: {} });
		}
	});

	it("resolves global capabilities into runtimeTools for a valid profile", async () => {
		const admission = await InternalLoopRunner.admit({
			profileId: "internal-agent-v1",
			appId: "conversation-timers",
			sessionId: "timer-123",
		});
		expect(admission).toBeDefined();
		const names = admission!.runtimeTools.finalTools.map((t) => t.name);
		expect(names).toContain("global.web.search");
		expect(names).toContain("global.web.read_page");
		expect(admission!.runId).toMatch(/^internal-/);
		expect(admission!.profile.profile_id).toBe("internal-agent-v1");
	});

	it("intersects caller enabledTools with the profile allowlist", async () => {
		const admission = await InternalLoopRunner.admit({
			profileId: "internal-agent-v1",
			appId: "scheduled-tasks",
			sessionId: "task-1",
			enabledTools: ["global.web.search"], // read_page omitted by caller
		});
		const names = admission!.runtimeTools.finalTools.map((t) => t.name);
		expect(names).toContain("global.web.search");
		expect(names).not.toContain("global.web.read_page");
		expect(admission!.runtimeTools.resolvedEnabledTools).toEqual(["global.web.search"]);
	});

	it("returns undefined for an unknown profile (legacy behavior preserved)", async () => {
		const admission = await InternalLoopRunner.admit({
			profileId: "does-not-exist-v9",
			appId: "x",
			sessionId: "y",
		});
		expect(admission).toBeUndefined();
	});

	it("routes tool calls through processToolCall and rejects non-whitelisted names", async () => {
		const processSpy = vi.spyOn(RunExecutionEngine, "processToolCall");
		const admission = await InternalLoopRunner.admit({
			profileId: "internal-agent-v1",
			appId: "conversation-timers",
			sessionId: "timer-abc",
		});

		// A non-whitelisted tool must be denied by admission policy.
		await expect(admission!.runtimeToolExecutor({ name: "obsidian.read_note", args: {} })).rejects.toThrow(/not allowed|denied/i);
		expect(processSpy).toHaveBeenCalled();

		// processToolCall itself must be queried with the internal profile identity.
		const callArgs = processSpy.mock.calls[0];
		expect(callArgs[0]).toMatch(/^internal-/);
		expect(callArgs[2].profile_id).toBe("internal-agent-v1");
		expect(callArgs[2].app_id).toBe("conversation-timers");
	});

	it("delivers runtimeTools to the loop context when wired", async () => {
		const loopSpy = vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
			const rt = (ctx as { runtimeTools?: { finalTools: Array<{ name: string }> } }).runtimeTools;
			expect(rt?.finalTools.map((t) => t.name)).toContain("global.web.search");
			expect(typeof (ctx as { runtimeToolExecutor?: unknown }).runtimeToolExecutor).toBe("function");
			return { messages: [{ role: "assistant", content: "ok" }] } as never;
		});

		const admission = await InternalLoopRunner.admit({
			profileId: "internal-agent-v1",
			appId: "scheduled-tasks",
			sessionId: "task-2",
		});
		await AgenticLoopService.runAgenticLoop({
			provider: {} as never,
			providerName: "vllm",
			resolvedModel: "GLM-5.3-Flash-EXL3",
			...(admission ? { runtimeTools: admission.runtimeTools, runtimeToolExecutor: admission.runtimeToolExecutor } : {}),
		} as never);
		expect(loopSpy).toHaveBeenCalled();
	});
});
