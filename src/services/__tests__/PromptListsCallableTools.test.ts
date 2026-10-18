/**
 * The system prompt must list only callable tools (tracing fix, 2026-10-17).
 *
 * RunExecutionEngine used to render the whole profile whitelist into the
 * prompt via ContextAssembly selectedToolSchemas while the request `tools`
 * array only contained the callable ones. A model that answers with a call
 * to a whitelisted-but-uncallable tool gets it stripped as text markup and
 * the run ends INCOMPLETE_RUN.
 *
 * Drives the real RunExecutionEngine.startRun with a controlled profile,
 * mocking ContextAssembly to capture the selectedToolSchemas it receives.
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

vi.mock("../ProfileRegistry.ts", () => ({
  ProfileRegistry: {
    loadProfile: async () => PROFILE,
    validateOverrides: () => {},
  },
}));

const capturedToolSchemas: Array<Array<{ name: string }>> = [];
vi.mock("../../platform/context/ContextAssembly.ts", () => ({
  ContextAssembly: class {
    assemble(options: { selectedToolSchemas: Array<{ name: string }> }) {
      capturedToolSchemas.push(options.selectedToolSchemas);
      return { layerTexts: { prefix: "", projectScope: "", retrievedEvidence: "" } };
    }
  },
}));

import { RunExecutionEngine } from "../RunExecutionEngine.ts";
import type { RunEvent } from "../../types/run.ts";

const PROFILE = {
  profile_id: "prompt-callable-tools-test-v1",
  version: "v1",
  role: "assistant",
  workflow_type: "interactive_agent" as const,
  system_prompt: "You are a test agent.",
  model_constraints: {
    default_model: "test-model",
    allowed_models: ["test-model"],
    allowed_providers: ["vllm-shim"],
  },
  tool_policy: {
    mode: "STRICT_WHITELIST" as const,
    whitelist: ["global.web.search", "html_notes.weather.get"],
  },
  budget_limits: { max_tokens: 1024, max_tool_calls: 2, max_duration_ms: 30000 },
  retention_class: "EPHEMERAL" as const,
};

const BASE_REQUEST = {
  profile_id: "prompt-callable-tools-test-v1",
  app_id: "test",
  session_id: "sess-prompt-callable",
  input: [{ role: "user" as const, content: "weather?" }],
  identity: { project: "test", username: "tester" },
  budget: { max_tool_calls: 2, max_tokens: 1024, max_duration_ms: 30000 },
};

function collectEvents(): { events: RunEvent[]; emit: (event: RunEvent) => void } {
  const events: RunEvent[] = [];
  return { events, emit: (event: RunEvent) => events.push(event) };
}

describe("prompt lists only callable tools", () => {
  it("omits a whitelisted name with no supplied local schema", async () => {
    const { emit } = collectEvents();
    await RunExecutionEngine.startRun(
      "run-prompt-uncallable",
      { ...BASE_REQUEST, runtime_overrides: {} } as never,
      emit,
    );

    const names = (capturedToolSchemas.at(-1) ?? []).map((s) => s.name);
    expect(names).toContain("global.web.search");
    expect(names).not.toContain("html_notes.weather.get");
  });

  it("lists a whitelisted name once a local schema is supplied for it", async () => {
    const { emit } = collectEvents();
    await RunExecutionEngine.startRun(
      "run-prompt-callable",
      {
        ...BASE_REQUEST,
        session_id: "sess-prompt-callable-2",
        runtime_overrides: {
          local_tool_schemas: [
            {
              name: "html_notes.weather.get",
              description: "Get weather",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      } as never,
      emit,
    );

    const names = (capturedToolSchemas.at(-1) ?? []).map((s) => s.name);
    expect(names).toContain("global.web.search");
    expect(names).toContain("html_notes.weather.get");
  });
});
