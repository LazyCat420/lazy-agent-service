/**
 * Local tool advertising in RunExecutionEngine (trading hang fix, 2026-10-17).
 *
 * Local-execution tools (e.g. trading.research.*) may only reach the agentic
 * loop when the request signals a client executor via
 * runtime_overrides.local_tool_schemas — any array, even empty. A direct API
 * run with no such array must not receive local tools from any catalog
 * fallback: no client would POST the result and the run would hang until
 * DEADLINE_EXCEEDED. Global capabilities are always advertised (LAS executes
 * them server-side).
 *
 * Drives the real RunExecutionEngine.startRun against the real
 * trading-strategy-chat-v1 profile, mocking only the provider-facing agentic
 * loop so the tool list handed to it can be captured.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() {
      return null;
    }
    static getCollection() {
      return null;
    }
  }
  return { default: MongoWrapper };
});

vi.mock("../DynamicModelResolver.ts", () => ({
  DynamicModelResolver: {
    queryLiveHosts: async () => [],
    resolveProviderAndModel: () => ({}),
  },
}));

type LoopContext = {
  runtimeTools?: { finalTools: Array<{ name: string }>; resolvedEnabledTools: string[] };
};
let capturedContext: LoopContext | undefined;
const runCoreLoopForRun = vi.fn(async (context: LoopContext) => {
  capturedContext = context;
  return { messages: [{ role: "assistant", content: "done" }] };
});
vi.mock("../../core/loop/RunsAdapter.ts", () => ({
  runCoreLoopForRun: (...args: Parameters<typeof runCoreLoopForRun>) => runCoreLoopForRun(...args),
}));

import { RunExecutionEngine } from "../RunExecutionEngine.ts";
import type { RunEvent } from "../../types/run.ts";

const BASE_REQUEST = {
  profile_id: "trading-strategy-chat-v1",
  app_id: "trading",
  session_id: "sess-local-tool-adv",
  input: [{ role: "user" as const, content: "NVDA price" }],
  identity: { project: "trading", username: "strategy-chat" },
  budget: { max_tool_calls: 2, max_tokens: 1024, max_duration_ms: 30000 },
};

function collectEvents(): { events: RunEvent[]; emit: (event: RunEvent) => void } {
  const events: RunEvent[] = [];
  return { events, emit: (event: RunEvent) => events.push(event) };
}

describe("local tool advertising", () => {
  it("advertises no local-execution tools and keeps global tools for a trading run without local_tool_schemas", async () => {
    const { events, emit } = collectEvents();
    const result = await RunExecutionEngine.startRun(
      "run-no-signal",
      { ...BASE_REQUEST, runtime_overrides: {} } as never,
      emit,
    );
    expect(result.status).toBe("completed");

    const finalTools = capturedContext?.runtimeTools?.finalTools ?? [];
    const local = finalTools.filter((t) => !t.name.startsWith("global."));
    expect(local).toEqual([]);
    expect(finalTools.some((t) => t.name.startsWith("global."))).toBe(true);
    expect(events.some((e) => e.type === "run.warning" && (e.data as { code?: string }).code === "LOCAL_TOOL_SCHEMA_MISSING")).toBe(true);
  });

  it("advertises a supplied local schema when the request signals a client executor", async () => {
    const { events, emit } = collectEvents();
    const result = await RunExecutionEngine.startRun(
      "run-with-signal",
      {
        ...BASE_REQUEST,
        session_id: "sess-local-tool-adv-2",
        runtime_overrides: {
          local_tool_schemas: [
            {
              name: "trading.research.web_search",
              description: "Search the web",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      } as never,
      emit,
    );
    expect(result.status).toBe("completed");

    const finalTools = capturedContext?.runtimeTools?.finalTools ?? [];
    expect(finalTools.map((t) => t.name)).toContain("trading.research.web_search");
    expect(finalTools.some((t) => t.name.startsWith("global."))).toBe(true);
    // scrape_url is profile-admitted but schemaless, so it alone is warned;
    // web_search was supplied and must not be warned about.
    const warnings = events.filter((e) => e.type === "run.warning" && (e.data as { code?: string }).code === "LOCAL_TOOL_SCHEMA_MISSING");
    const warnedTools = warnings.flatMap((e) => (e.data as { tools?: string[] }).tools ?? []);
    expect(warnedTools).toContain("trading.research.scrape_url");
    expect(warnedTools).not.toContain("trading.research.web_search");
  });
});
