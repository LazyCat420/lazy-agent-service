import crypto from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const script = vi.hoisted(() => ({ mode: "success", calls: 0, messages: [] as any[][] }));
// A public IP literal: the SSRF guard resolves hostnames, and .test never resolves.
const fixtureUrl = "https://93.184.215.14/news";
// read_page reports pages under 200 chars of text as EMPTY_CONTENT (JS shells), so the article needs a real body.
const fixturePage =
  "Fixture page: semiconductor revenue grew 12 percent in the latest quarter. Memory makers led the gains as data-center " +
  "demand stayed strong, while handset chip sales were flat. Analysts expect the trend to continue into next year.";

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
    if (script.mode === "forbidden" && script.calls === 1) {
      yield { type: "toolCall", id: "search-1", name: "global.web.search", args: { query: "fixture semiconductor news" } };
      return;
    }
    if (script.mode === "forbidden" && script.calls === 2) {
      yield { type: "toolCall", id: "read-1", name: "global.web.read_page", args: { url: fixtureUrl } };
      return;
    }
    if (script.mode === "forbidden" && script.calls === 3) {
      const transcript = JSON.stringify(messages);
      if (!transcript.includes("HTTP 403")) throw new Error("HTTP 403 observation was not returned to the model");
      yield "Synthesized result from snippet: Semiconductor revenue grew based on search snippet. Source: " + fixtureUrl;
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
vi.mock("../../src/services/WebSearchService.ts", () => ({
  webSearch: vi.fn(async (_query: string, _maxResults: number) => {
    if (script.mode === "failure") {
      return { status: "error", provider: "exa", cached: false, results: [], error: "fixture search transport failed" };
    }
    return script.mode === "empty"
      ? { status: "ok", provider: "exa", cached: false, results: [] }
      : { status: "ok", provider: "exa", cached: false, results: [{ title: "Fixture news", url: fixtureUrl, snippet: "Fixture result", published: "", author: "" }] };
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
      if (url === fixtureUrl) {
        if (script.mode === "forbidden") {
          return new Response("Forbidden", { status: 403, statusText: "Forbidden" });
        }
        return new Response(`<html><body>${fixturePage}</body></html>`, { status: 200 });
      }
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

  it("returns a tool transport failure to the model, which answers without claiming a source", async () => {
    script.mode = "failure";
    const events: any[] = [];
    const result = await RunExecutionEngine.startRun("runtime-news-failure", {
      profile_id: "obsidian-vault-agent-v1", profile_version: "1.0.0", app_id: "obsidian",
      session_id: "fixture-session", input: "Research the failing fixture feed.",
      runtime_overrides: { tools: ["global.web.search", "global.web.read_page"] },
    }, event => events.push(event));

    // Always-answer: a failed tool is an observation, not a run failure.
    expect(result.status).toBe("completed");
    expect(JSON.stringify(script.messages[1])).toContain("fixture search transport failed");
    expect(events.some(event => event.type === "tool.failed" && event.data.tool_name === "global.web.search")).toBe(true);
    expect(result.messages.at(-1)?.content ?? "").not.toContain("Source:");
  });

  it("softly handles page access restriction (HTTP 403) so model synthesizes from search snippet without crashing", async () => {
    script.mode = "forbidden";
    const events: any[] = [];
    const result = await RunExecutionEngine.startRun("runtime-news-403", {
      profile_id: "obsidian-vault-agent-v1", profile_version: "1.0.0", app_id: "obsidian",
      session_id: "fixture-session", input: "Research the fixture feed with forbidden page.",
      runtime_overrides: { tools: ["global.web.search", "global.web.read_page"] },
    }, event => events.push(event));

    expect(result.status).toBe("completed");
    expect(events.filter(event => event.type === "tool.completed").map(event => event.data.tool_name)).toEqual(["global.web.search"]);
    expect(events.some(event => event.type === "tool.failed" && event.data.tool_name === "global.web.read_page")).toBe(true);
    expect(result.messages.at(-1)?.content).toContain("Semiconductor revenue grew based on search snippet");
    expect(script.calls).toBe(3);
  });
});
