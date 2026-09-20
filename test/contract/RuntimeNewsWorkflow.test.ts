import crypto from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const script = vi.hoisted(() => ({ mode: "success", calls: 0, messages: [] as any[][] }));
const fixtureUrl = "https://fixture.test/news";
const fixturePage = "Fixture page: semiconductor revenue grew 12 percent in the latest quarter.";

const provider = {
  async *generateTextStream(messages: any[]) {
    script.calls += 1;
    script.messages.push(messages);
    if (script.mode === "success" && script.calls === 1) {
      yield { type: "toolCall", id: "search-1", name: "global.web.search", args: { query: "fixture semiconductor news" } };
      return;
    }
    if (script.mode === "success" && script.calls === 2) {
      const transcript = JSON.stringify(messages);
      if (!transcript.includes(fixtureUrl)) throw new Error("search observation was not returned to the model");
      yield { type: "toolCall", id: "read-1", name: "global.web.read_page", args: { url: fixtureUrl } };
      return;
    }
    if (script.mode === "success" && script.calls === 3) {
      const transcript = JSON.stringify(messages);
      if (!transcript.includes(fixturePage)) throw new Error("page observation was not returned to the model");
      yield "Sourced result: ";
      yield `${fixturePage} Source: ${fixtureUrl}`;
      return;
    }
    if (script.mode === "empty" && script.calls === 1) {
      yield { type: "toolCall", id: "search-empty", name: "global.web.search", args: { query: "fixture empty" } };
      return;
    }
    if (script.mode === "empty") {
      yield "No sources were returned; I cannot substantiate a current answer.";
      return;
    }
    if (script.mode === "failure" && script.calls === 1) {
      yield { type: "toolCall", id: "search-failure", name: "global.web.search", args: { query: "fixture failure" } };
      return;
    }
    yield "The provider stopped after the tool failure.";
  },
};

vi.mock("../../src/providers/index.ts", () => ({ getProvider: vi.fn(() => provider) }));
vi.mock("../../src/services/NewsSearchService.ts", () => ({
  newsSearch: vi.fn(async (_query: string, _maxResults: number) => {
    if (script.mode === "failure") throw new Error("fixture search transport failed");
    return script.mode === "empty"
      ? { source: "fixture", items: [] }
      : { source: "fixture", items: [{ title: "Fixture news", url: fixtureUrl, snippet: "Fixture result" }] };
  }),
}));

import { RunExecutionEngine } from "../../src/services/RunExecutionEngine.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
import { RunStore } from "../../src/services/RunStore.ts";

describe("real runtime news workflow", () => {
  beforeEach(async () => {
    script.mode = "success";
    script.calls = 0;
    script.messages = [];
    RunExecutionEngine.reset();
    RunStore.clearAll();
    ProfileRegistry.clear();
    vi.restoreAllMocks();
    vi.stubEnv("RUNTIME_AUTH_SECRET", crypto.randomBytes(32).toString("hex"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === fixtureUrl) return new Response(`<html><body>${fixturePage}</body></html>`, { status: 200 });
      throw new Error(`Unexpected fixture URL: ${url}`);
    });
    await ProfileRegistry.loadProfilesFromDisk();
  });

  afterEach(() => vi.unstubAllEnvs());

  it("runs search, returns its exact link, reads that page, and produces a sourced terminal answer", async () => {
    const events: any[] = [];
    const result = await RunExecutionEngine.startRun("runtime-news-success", {
      profile_id: "obsidian-vault-agent-v1", profile_version: "1.0.0", app_id: "obsidian",
      session_id: "fixture-session", input: "Research the latest fixture semiconductor news.",
      runtime_overrides: { tools: ["global.web.search", "global.web.read_page"] },
    }, event => events.push(event));

    expect(result.status).toBe("completed");
    expect(result.messages.at(-1)?.content).toContain(fixtureUrl);
    expect(events.filter(event => event.type === "tool.completed").map(event => event.data.tool_name)).toEqual([
      "global.web.search", "global.web.read_page",
    ]);
    expect(script.calls).toBe(3);
  });

  it("keeps an empty search honest and still reaches a terminal answer", async () => {
    script.mode = "empty";
    const result = await RunExecutionEngine.startRun("runtime-news-empty", {
      profile_id: "obsidian-vault-agent-v1", profile_version: "1.0.0", app_id: "obsidian",
      session_id: "fixture-session", input: "Research the empty fixture feed.",
      runtime_overrides: { tools: ["global.web.search", "global.web.read_page"] },
    }, () => {});

    expect(result.status).toBe("completed");
    expect(result.messages.at(-1)?.content).toContain("No sources were returned");
  });

  it("surfaces a tool transport failure instead of claiming sourced success", async () => {
    script.mode = "failure";
    const events: any[] = [];
    const result = await RunExecutionEngine.startRun("runtime-news-failure", {
      profile_id: "obsidian-vault-agent-v1", profile_version: "1.0.0", app_id: "obsidian",
      session_id: "fixture-session", input: "Research the failing fixture feed.",
      runtime_overrides: { tools: ["global.web.search", "global.web.read_page"] },
    }, event => events.push(event));

    expect(result.status).not.toBe("completed");
    expect(events.some(event => event.type === "tool.failed" && event.data.tool_name === "global.web.search")).toBe(true);
    expect(result.messages.at(-1)?.content ?? "").not.toContain("Source:");
  });
});
