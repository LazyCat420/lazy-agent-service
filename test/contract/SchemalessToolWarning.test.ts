/**
 * Contract test: a profile-admitted local tool without a supplied schema must
 * emit a run.warning event naming the dropped tools — admission must not be
 * silent about tools the model will not be able to call.
 */
import { CreateRunRequest, RunEvent } from "../../src/types/run.ts";
import { RunExecutionEngine } from "../../src/services/RunExecutionEngine.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
import { RunEvidenceStore } from "../../src/platform/verify/RunEvidenceStore.ts";
import AgenticLoopService from "../../src/services/AgenticLoopService.ts";
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("local tool schema missing warning", () => {
	const testDir = path.dirname(fileURLToPath(import.meta.url));
	const profilesDir = path.resolve(testDir, "..", "..", "profiles");

	beforeEach(async () => {
		RunExecutionEngine.reset();
		ProfileRegistry.clear();
		RunEvidenceStore.getGlobalInstance().clearAll();
		vi.restoreAllMocks();
		await ProfileRegistry.loadProfilesFromDisk(profilesDir);
		for (const id of ProfileRegistry.getRegisteredProfileIds()) {
			const profile = await ProfileRegistry.loadProfile(id);
			ProfileRegistry.registerProfile({ ...profile!, plugins: {} });
		}
	});

	function makeLoopMock(shouldContain: boolean) {
		return vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
			// Assert the loop received the expected local schema state for
			// obsidian.read_note — absent when schemaless, present otherwise.
			const runtimeTools = (ctx as { runtimeTools?: { finalTools: Array<{ name: string }> } }).runtimeTools;
			const names = (runtimeTools?.finalTools ?? []).map((t) => t.name);
			expect(names.includes("obsidian.read_note")).toBe(shouldContain);
			return { messages: [{ role: "assistant", content: "done" }] } as never;
		});
	}

	it("warns when a profile local tool has no supplied schema", async () => {
		const loopSpy = makeLoopMock(false);
		const events: RunEvent[] = [];
		const request: CreateRunRequest = {
			profile_id: "obsidian-vault-agent-v1",
			app_id: "obsidian",
			session_id: "obsidian-vault",
			input: "read the note",
			budget: { max_tool_calls: 1 },
			// No runtime_overrides.local_tool_schemas — the exact silent-drop
			// shape that hobbled the model in the live wire benchmark.
		};
		const result = await RunExecutionEngine.startRun(
			"run-schemaless-1",
			request,
			(evt) => events.push({ ...evt, id: "1", timestamp: new Date().toISOString() } as RunEvent),
		);

		expect(result.status).toBe("completed");
		expect(loopSpy).toHaveBeenCalled();

		const warnings = events.filter((e) => e.type === "run.warning");
		expect(warnings).toHaveLength(1);
		const data = warnings[0].data as { code: string; tools: string[] };
		expect(data.code).toBe("LOCAL_TOOL_SCHEMA_MISSING");
		expect(data.tools).toContain("obsidian.read_note");
	});

	it("does not warn for tools that have a supplied schema", async () => {
		makeLoopMock(true);
		const events: RunEvent[] = [];
		const request: CreateRunRequest = {
			profile_id: "obsidian-vault-agent-v1",
			app_id: "obsidian",
			session_id: "obsidian-vault",
			input: "read the note",
			budget: { max_tool_calls: 1 },
			runtime_overrides: {
				local_tool_schemas: [
					{
						name: "obsidian.read_note",
						description: "Read a note",
						parameters: { type: "object", properties: { note_path: { type: "string" } }, required: ["note_path"], additionalProperties: false },
					},
				],
			},
		};
		const result = await RunExecutionEngine.startRun(
			"run-schemaful-1",
			request,
			(evt) => events.push({ ...evt, id: "2", timestamp: new Date().toISOString() } as RunEvent),
		);

		expect(result.status).toBe("completed");
		// Sibling tools without schemas still warn — but the supplied tool must
		// not appear in the dropped list.
		const warnings = events.filter((e) => e.type === "run.warning");
		for (const w of warnings) {
			const data = w.data as { code: string; tools: string[] };
			if (data.code === "LOCAL_TOOL_SCHEMA_MISSING") {
				expect(data.tools).not.toContain("obsidian.read_note");
			}
		}
	});

	it("does not warn for global capabilities (schemaless by design)", async () => {
		const seenFinalTools: string[] = [];
		vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
			const rt = (ctx as { runtimeTools?: { finalTools: Array<{ name: string }> } }).runtimeTools;
			seenFinalTools.push(...(rt?.finalTools ?? []).map((t) => t.name));
			return { messages: [{ role: "assistant", content: "done" }] } as never;
		});
		const events: RunEvent[] = [];
		const request: CreateRunRequest = {
			profile_id: "obsidian-vault-agent-v1",
			app_id: "obsidian",
			session_id: "obsidian-vault",
			input: "search the web",
			budget: { max_tool_calls: 1 },
			// No local schemas: global capabilities resolve from the registry and
			// local tools warn — but a run using only globals stays clean.
			runtime_overrides: {
				tools: ["global.web.search", "global.web.read_page"],
			},
		};
		const result = await RunExecutionEngine.startRun(
			"run-global-only-1",
			request,
			(evt) => events.push({ ...evt, id: "3", timestamp: new Date().toISOString() } as RunEvent),
		);

		expect(result.status).toBe("completed");
		expect(seenFinalTools).toContain("global.web.search");
		expect(events.filter((e) => e.type === "run.warning")).toHaveLength(0);
	});
});
