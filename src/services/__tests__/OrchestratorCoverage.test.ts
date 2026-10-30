/**
 * OrchestratorService — coverage of sub-agent spawning, the sub-agent loop,
 * continuation, team creation and teardown. Git worktrees, providers, the
 * agentic loop, Mongo, load balancing and telemetry are fakes; the service is
 * real and assertions read the returned SubAgentResult/registry state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  runAgenticLoop: vi.fn(),
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
  getWorktreeDiff: vi.fn(),
  toolsApiPost: vi.fn(),
  getDefaultWorkspaceRoot: vi.fn(),
  resolveRepositoryPath: vi.fn(),
  selectAndReserveInstance: vi.fn(),
  releaseReservation: vi.fn(),
  isLocal: vi.fn(),
  getProvider: vi.fn(),
  getInstanceType: vi.fn(),
  getInstancesByType: vi.fn(),
  resolveModelForInstances: vi.fn(),
  getSection: vi.fn(),
  personaGet: vi.fn(),
  getWorkspaceRoots: vi.fn(),
  getToolSchemas: vi.fn(),
  setWorktree: vi.fn(),
  clearWorktree: vi.fn(),
  admit: vi.fn(),
  evictIdleSecondaryModel: vi.fn(),
  updateOne: vi.fn(),
  getModelByName: vi.fn(),
  traceDelegation: vi.fn(),
  routerExecute: vi.fn(),
}));

vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../providers/instance-registry.ts", () => ({
  getInstanceType: fakes.getInstanceType,
  getInstancesByType: fakes.getInstancesByType,
}));
vi.mock("../../utils/ModelResolution.ts", () => ({
  resolveModelForInstances: fakes.resolveModelForInstances,
}));
vi.mock("../SettingsService.ts", () => ({ default: { getSection: fakes.getSection } }));
vi.mock("../AgentPersonaRegistry.ts", () => ({ default: { get: fakes.personaGet } }));
vi.mock("../ToolOrchestratorService.ts", () => ({
  default: {
    getWorkspaceRoots: fakes.getWorkspaceRoots,
    getToolSchemas: fakes.getToolSchemas,
    _setWorktree: fakes.setWorktree,
    _clearWorktree: fakes.clearWorktree,
  },
}));
vi.mock("../LocalModelQueue.ts", () => ({ default: { isLocal: fakes.isLocal } }));
vi.mock("../InternalLoopRunner.ts", () => ({
  InternalLoopRunner: { admit: fakes.admit },
}));
vi.mock("../AgenticLoopService.ts", () => ({
  default: { runAgenticLoop: fakes.runAgenticLoop },
}));
vi.mock("../orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    createWorktree: fakes.createWorktree,
    removeWorktree: fakes.removeWorktree,
    getWorktreeDiff: fakes.getWorktreeDiff,
    toolsApiPost: fakes.toolsApiPost,
    getDefaultWorkspaceRoot: fakes.getDefaultWorkspaceRoot,
    resolveRepositoryPath: fakes.resolveRepositoryPath,
  },
}));
vi.mock("../orchestrator/InstanceLoadBalancer.ts", () => ({
  InstanceLoadBalancer: {
    selectAndReserveInstance: fakes.selectAndReserveInstance,
    releaseReservation: fakes.releaseReservation,
  },
}));
vi.mock("../orchestrator/VramEvictionPolicy.ts", () => ({
  evictIdleSecondaryModel: fakes.evictIdleSecondaryModel,
}));
vi.mock("../orchestrator/SubAgentTelemetryEmitter.ts", () => {
  class SubAgentTelemetryEmitter {
    output = "";
    toolCalls: Array<Record<string, unknown>> = [];
    totalCost: number | null = 4.5;
    usage: Record<string, number> | null = { inputTokens: 12 };
    iterations: number | null = 3;
    createEmitFunction() {
      return () => {};
    }
    emitCompletion() {}
  }
  return { SubAgentTelemetryEmitter };
});
vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getCollection: () => ({ updateOne: fakes.updateOne }) },
}));
vi.mock("../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getModelByName: fakes.getModelByName,
}));
vi.mock("../../platform/trace/HarnessInstrumenter.ts", () => ({
  HarnessInstrumenter: { traceDelegation: fakes.traceDelegation },
}));
vi.mock("../../platform/trace/TraceExporter.ts", () => {
  class TraceExporter {
    private static instance = new TraceExporter();
    static getGlobalInstance() {
      return TraceExporter.instance;
    }
    enqueueSpan() {}
  }
  return { TraceExporter };
});
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const routerModule = (exportName: string) => {
  class Router {
    async execute(
      name: string,
      members: Array<{ description: string }>,
      _context: unknown,
      spawn: (assignment: Record<string, unknown>) => Promise<unknown>,
    ) {
      return fakes.routerExecute(exportName, name, members, spawn);
    }
  }
  return { [exportName]: Router };
};

vi.mock("../orchestrator/routers/SequentialRouter.ts", () => routerModule("SequentialRouter"));
vi.mock("../orchestrator/routers/PeerToPeerRouter.ts", () => routerModule("PeerToPeerRouter"));
vi.mock("../orchestrator/routers/HierarchicalAggregationRouter.ts", () =>
  routerModule("HierarchicalAggregationRouter"),
);
vi.mock("../orchestrator/routers/TournamentRouter.ts", () => routerModule("TournamentRouter"));
vi.mock("../orchestrator/routers/CriticLoopRouter.ts", () => routerModule("CriticLoopRouter"));
vi.mock("../orchestrator/routers/DivideAndConquerRouter.ts", () =>
  routerModule("DivideAndConquerRouter"),
);
vi.mock("../orchestrator/routers/MCTSRouter.ts", () => routerModule("MCTSRouter"));
vi.mock("../orchestrator/routers/HierarchicalRouter.ts", () => routerModule("HierarchicalRouter"));

import OrchestratorService from "../OrchestratorService.ts";

type Event = Record<string, unknown>;
type SpawnParams = Record<string, unknown>;

let emitted: Event[];
/** Every agentConversationId minted by a test, cleaned up afterwards so the
 *  module-level sub-agent registry never leaks state between tests. */
const cleanupIds: string[] = [];
let contextSeq = 0;

function context(overrides: Event = {}): Event {
  contextSeq += 1;
  const agentConversationId = `agent-conv-${contextSeq}`;
  cleanupIds.push(agentConversationId);
  return {
    project: "proj",
    username: "alice",
    agent: "coding",
    providerName: "lm-studio",
    resolvedModel: "local-model",
    agentConversationId,
    conversationId: `conv-${contextSeq}`,
    traceId: "trace-1",
    workspaceRoot: process.cwd(),
    enabledTools: ["read_file"],
    topology: "hierarchical",
    emit: (event: Event) => emitted.push(event),
    maxRecursionDepth: 3,
    recursionDepth: 0,
    maxSubAgentIterations: 10,
    minContextLength: 8192,
    ...overrides,
  };
}

function spawnParams(overrides: SpawnParams = {}): SpawnParams {
  return {
    description: "Write the report",
    prompt: "Summarise the findings",
    files: ["notes.md"],
    orchestratorContext: context(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  emitted = [];
  fakes.createWorktree.mockResolvedValue({ worktreePath: "/workspace/.worktrees/agent-1" });
  fakes.removeWorktree.mockResolvedValue(undefined);
  fakes.toolsApiPost.mockResolvedValue({ ok: true });
  fakes.getWorktreeDiff.mockResolvedValue({
    hasChanges: true,
    additions: 3,
    deletions: 1,
    files: ["notes.md"],
  });
  fakes.getDefaultWorkspaceRoot.mockReturnValue("/workspace");
  fakes.resolveRepositoryPath.mockReturnValue("/repo");
  fakes.getWorkspaceRoots.mockReturnValue([process.cwd()]);
  fakes.getToolSchemas.mockReturnValue([
    { name: "read_file" },
    { name: "create_subagent" },
  ]);
  fakes.getSection.mockResolvedValue({ topology: "hierarchical" });
  fakes.personaGet.mockReturnValue(null);
  fakes.isLocal.mockReturnValue(true);
  fakes.getInstanceType.mockReturnValue("lm-studio");
  fakes.getInstancesByType.mockReturnValue([{ id: "lm-studio" }]);
  fakes.selectAndReserveInstance.mockReturnValue({
    provider: "lm-studio",
    model: "local-model",
    slotsAvailable: 2,
  });
  fakes.resolveModelForInstances.mockResolvedValue({
    usable: [{ id: "lm-studio" }],
    modelOverrides: new Map(),
  });
  fakes.getProvider.mockReturnValue({ name: "lm-studio" });
  fakes.admit.mockResolvedValue(undefined);
  fakes.updateOne.mockResolvedValue({ matchedCount: 1 });
  fakes.getModelByName.mockReturnValue({ label: "Local Model" });
  fakes.traceDelegation.mockReturnValue({
    delegateSpan: { span_id: "span-1" },
    complete: vi.fn(),
    emitJoinSpan: vi.fn(),
  });
  fakes.runAgenticLoop.mockResolvedValue({
    messages: [{ role: "assistant", content: "Final report" }],
  });
  fakes.routerExecute.mockImplementation(async (routerName: string) => [
    { agent_id: `agent-from-${routerName}`, status: "completed" },
    { error: "second member failed" },
  ]);
});

afterEach(() => {
  for (const agentConversationId of cleanupIds.splice(0)) {
    OrchestratorService.cleanupConversation(agentConversationId);
  }
});

describe("spawnFromTool", () => {
  it("spawns an isolated sub-agent, runs the loop and returns the completed result", async () => {
    fakes.personaGet.mockReturnValue({ id: "writer", availableTools: ["read_file"] });
    const ctx = context();

    const result = (await OrchestratorService.spawnFromTool(
      spawnParams({
        orchestratorContext: ctx,
        agent: "writer",
        agentIndex: 0,
        teamSize: 2,
        round: 2,
        totalRounds: 3,
        files: ["notes.md", "appendix.md"],
      }) as never,
    )) as Event;

    expect(result).toMatchObject({
      agent_id: expect.stringMatching(/^agent-1-/),
      description: "Write the report",
      status: "completed",
      toolUses: 0,
      result: "Final report",
      iterations: 3,
      recursionDepth: 1,
      diff: { additions: 3, deletions: 1, files: ["notes.md"] },
    });
    expect(String(result.summary)).toContain("completed successfully");

    // Isolated worktree: committed, diffed, cleaned up.
    expect(fakes.createWorktree).toHaveBeenCalledWith("/repo", expect.stringMatching(/^orchestrator\/agent-1-/));
    expect(fakes.toolsApiPost).toHaveBeenCalledWith(
      "/agentic/command/run",
      expect.objectContaining({ command: "git add -A", cwd: "/workspace/.worktrees/agent-1" }),
    );
    expect(fakes.toolsApiPost).toHaveBeenCalledWith(
      "/agentic/command/run",
      expect.objectContaining({ command: expect.stringContaining("git commit -m \"orchestrator: ") }),
    );
    expect(fakes.getWorktreeDiff).toHaveBeenCalledWith("/repo", expect.stringMatching(/^orchestrator\/agent-1-/));
    expect(fakes.removeWorktree).toHaveBeenCalledWith("/repo", "/workspace/.worktrees/agent-1");
    expect(fakes.releaseReservation).toHaveBeenCalledWith("lm-studio");
    expect(fakes.setWorktree).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        originalRoot: process.cwd(),
        worktreePath: "/workspace/.worktrees/agent-1",
      }),
    );
    expect(fakes.clearWorktree).toHaveBeenCalledWith(expect.any(String));
    expect(fakes.evictIdleSecondaryModel).toHaveBeenCalled();
    expect(fakes.updateOne).toHaveBeenCalledWith(
      { id: ctx.conversationId, project: "proj", username: "alice" },
      { $set: { hasSubAgents: true } },
    );

    // The loop received the persona tools and the recursion-aware prompt.
    const loopArgs = fakes.runAgenticLoop.mock.calls[0][0];
    expect(loopArgs.workspaceRoot).toBe("/workspace/.worktrees/agent-1");
    expect(loopArgs.options.enabledTools).toEqual(["read_file"]);
    expect(loopArgs.options.isSubAgent).toBe(true);
    expect(loopArgs.options.maxIterations).toBe(10);
    expect(loopArgs.messages[0].content).toContain("Agent: 1 of 2");
    expect(loopArgs.messages[0].content).toContain("Round: 2");
    expect(loopArgs.messages[0].content).toContain("Focus on files: notes.md, appendix.md");
    expect(loopArgs.messages[0].content).toContain("Only modify files within your workspace");
    expect(loopArgs.messages[1]).toEqual({ role: "user", content: "Summarise the findings" });

    const spawned = emitted.find((event) => event.type === "sub_agent_status" && event.message === "spawned");
    expect(spawned).toMatchObject({
      description: "Write the report",
      parentConversationId: ctx.conversationId,
      provider: "lm-studio",
    });
    expect(emitted.at(-1)).toMatchObject({ type: "status" });
  });

  it("runs in the workspace root when worktree creation fails and reports no diff", async () => {
    fakes.createWorktree.mockResolvedValue({ error: "disk full" });

    const result = (await OrchestratorService.spawnFromTool(spawnParams() as never)) as Event;

    expect(result).toMatchObject({ status: "completed" });
    expect(fakes.getWorktreeDiff).not.toHaveBeenCalled();
    expect(fakes.removeWorktree).not.toHaveBeenCalled();
    expect(fakes.toolsApiPost).toHaveBeenCalledWith(
      "/agentic/command/run",
      expect.objectContaining({ cwd: "/workspace" }),
    );
  });

  it("marks the sub-agent failed and cleans up when the loop throws", async () => {
    fakes.runAgenticLoop.mockRejectedValue(new Error("model crashed"));

    const result = (await OrchestratorService.spawnFromTool(spawnParams() as never)) as Event;

    expect(result).toMatchObject({ status: "failed" });
    expect(String(result.summary)).toContain("model crashed");
    expect(fakes.removeWorktree).toHaveBeenCalled();
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: expect.any(String), message: "failed", error: "model crashed" }),
    );
  });

  it("refuses to spawn when recursion is disabled or the depth limit is reached", async () => {
    const disabled = await OrchestratorService.spawnFromTool(
      spawnParams({ orchestratorContext: context({ maxRecursionDepth: 0 }) }) as never,
    );
    expect(disabled).toEqual({
      error: "Sub-agent spawning is disabled (recursion depth is set to 0).",
    });

    const exhausted = await OrchestratorService.spawnFromTool(
      spawnParams({ orchestratorContext: context({ recursionDepth: 3, maxRecursionDepth: 3 }) }) as never,
    );
    expect(exhausted).toEqual({
      error:
        "Sub-agent spawning limit reached. Current depth 3 exceeds or matches max depth 3.",
    });
    expect(fakes.createWorktree).not.toHaveBeenCalled();
  });

  it("drops orchestrator tools when the sub-agent cannot recurse further", async () => {
    await OrchestratorService.spawnFromTool(
      spawnParams({
        orchestratorContext: context({
          recursionDepth: 2,
          maxRecursionDepth: 3,
          enabledTools: ["read_file", "create_subagent"],
        }),
      }) as never,
    );
    expect(fakes.runAgenticLoop.mock.calls[0][0].options.enabledTools).toEqual(["read_file"]);
    expect(fakes.runAgenticLoop.mock.calls[0][0].messages[0].content).toContain("complete");
  });

  it("derives the tool list from the catalog when none is pinned", async () => {
    await OrchestratorService.spawnFromTool(
      spawnParams({ orchestratorContext: context({ enabledTools: null }) }) as never,
    );
    expect(fakes.runAgenticLoop.mock.calls[0][0].options.enabledTools).toEqual([
      "read_file",
      "create_subagent",
    ]);
    expect(fakes.getToolSchemas).toHaveBeenCalledWith("hierarchical");
  });

  it("fails when the resolved provider is not registered", async () => {
    fakes.getProvider.mockReturnValue(undefined);
    const result = (await OrchestratorService.spawnFromTool(spawnParams() as never)) as Event;
    expect(result).toMatchObject({ status: "failed" });
    expect(String(result.summary)).toContain("Provider not found: lm-studio");
  });

  it("uses a pre-assigned provider/model without touching the load balancer", async () => {
    await OrchestratorService.spawnFromTool(
      spawnParams({ assignedProvider: "anthropic", assignedModel: "claude-x" }) as never,
    );
    expect(fakes.selectAndReserveInstance).not.toHaveBeenCalled();
    const loopArgs = fakes.runAgenticLoop.mock.calls[0][0];
    expect(loopArgs.providerName).toBe("anthropic");
    expect(loopArgs.resolvedModel).toBe("claude-x");
  });

  it("keeps the parent model for cloud providers", async () => {
    fakes.isLocal.mockReturnValue(false);
    await OrchestratorService.spawnFromTool(spawnParams({ model: "claude-fallback" }) as never);
    expect(fakes.runAgenticLoop.mock.calls[0][0].resolvedModel).toBe("claude-fallback");
  });

  it("falls back to the configured sub-agent model when local instances are full", async () => {
    fakes.getInstancesByType.mockReturnValue([{ id: "lm-studio" }, { id: "lm-studio-2" }]);
    fakes.resolveModelForInstances.mockResolvedValue({ usable: [], modelOverrides: new Map() });
    fakes.selectAndReserveInstance.mockReturnValue(undefined);
    fakes.getSection.mockResolvedValue({
      topology: "hierarchical",
      subAgentProvider: "openrouter",
      subAgentModel: "remote-model",
    });

    await OrchestratorService.spawnFromTool(spawnParams() as never);
    const loopArgs = fakes.runAgenticLoop.mock.calls[0][0];
    expect(loopArgs.providerName).toBe("openrouter");
    expect(loopArgs.resolvedModel).toBe("remote-model");
  });

  it("queues on the local provider when nothing is free and no fallback exists", async () => {
    fakes.selectAndReserveInstance.mockReturnValue(undefined);
    await OrchestratorService.spawnFromTool(spawnParams() as never);
    const loopArgs = fakes.runAgenticLoop.mock.calls[0][0];
    expect(loopArgs.providerName).toBe("lm-studio");
    expect(loopArgs.resolvedModel).toBe("local-model");
  });

  it("honours the instance the load balancer assigns", async () => {
    fakes.getInstancesByType.mockReturnValue([{ id: "lm-studio" }, { id: "lm-studio-2" }]);
    fakes.resolveModelForInstances.mockResolvedValue({
      usable: [{ id: "lm-studio-2" }],
      modelOverrides: new Map([["lm-studio-2", "override-model"]]),
    });
    fakes.selectAndReserveInstance.mockReturnValue({
      provider: "lm-studio-2",
      model: "override-model",
      slotsAvailable: 1,
    });

    await OrchestratorService.spawnFromTool(spawnParams() as never);
    expect(fakes.selectAndReserveInstance).toHaveBeenCalledWith(
      [{ id: "lm-studio-2" }],
      "lm-studio",
      expect.any(Map),
      "local-model",
      expect.any(Map),
    );
    expect(fakes.runAgenticLoop.mock.calls[0][0].providerName).toBe("lm-studio-2");
  });
});

/** Spawn a sub-agent whose loop stays pending until `release()` is called. */
async function spawnRunning(ctx: Event, params: SpawnParams = {}) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fakes.runAgenticLoop.mockImplementation(async () => {
    await gate;
    return { messages: [{ role: "assistant", content: "Final report" }] };
  });
  const pending = OrchestratorService.spawnFromTool(
    spawnParams({ ...params, orchestratorContext: ctx }) as never,
  );
  await vi.waitFor(() => {
    expect(
      OrchestratorService.listSubAgents({ parentConversationId: ctx.conversationId }).some(
        (subAgent) => subAgent.status === "running",
      ),
    ).toBe(true);
  });
  const running = OrchestratorService.listSubAgents({
    parentConversationId: ctx.conversationId,
  }).find((subAgent) => subAgent.status === "running")!;
  return { agentId: running.agentId, pending, release };
}

describe("continueAgent", () => {
  it("re-activates a completed sub-agent and returns the continuation result", async () => {
    const ctx = context();
    const spawned = (await OrchestratorService.spawnFromTool(
      spawnParams({ orchestratorContext: ctx }) as never,
    )) as Event;
    fakes.removeWorktree.mockClear();
    fakes.clearWorktree.mockClear();

    const continued = (await OrchestratorService.continueAgent(
      String(spawned.agent_id),
      "Follow-up task",
      ctx as never,
      4,
    )) as Event;

    expect(continued).toMatchObject({
      agent_id: spawned.agent_id,
      status: "completed",
      result: "Final report",
    });
    // Stateful reuse keeps the worktree and the conversation history.
    expect(fakes.removeWorktree).not.toHaveBeenCalled();
    expect(fakes.clearWorktree).not.toHaveBeenCalled();
    const loopArgs = fakes.runAgenticLoop.mock.calls.at(-1)![0];
    expect(loopArgs.messages[0].content).toContain("Round: 4");
    expect(loopArgs.messages[1]).toEqual({ role: "user", content: "Follow-up task" });
    expect(loopArgs.workspaceRoot).toBe("/workspace/.worktrees/agent-1");
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: "sub_agent_status", message: "spawned" }),
    );
  });

  it("marks the sub-agent failed when the continuation throws", async () => {
    const ctx = context();
    const spawned = (await OrchestratorService.spawnFromTool(
      spawnParams({ orchestratorContext: ctx }) as never,
    )) as Event;
    fakes.runAgenticLoop.mockRejectedValue(new Error("context overflow"));

    const failed = (await OrchestratorService.continueAgent(
      String(spawned.agent_id),
      "Again",
      ctx as never,
    )) as Event;

    expect(failed).toMatchObject({ status: "failed", error: "context overflow" });
    expect(emitted).toContainEqual(
      expect.objectContaining({ message: "failed", error: "context overflow" }),
    );
  });

  it("rejects unknown and still-running agents", async () => {
    expect(await OrchestratorService.continueAgent("ghost", "x", context() as never)).toEqual({
      error: 'Sub-agent "ghost" not found for continuation',
    });

    const ctx = context();
    const { agentId, pending, release } = await spawnRunning(ctx);
    expect(await OrchestratorService.continueAgent(agentId, "x", ctx as never)).toEqual({
      error: `Sub-agent "${agentId}" is in "running" state and cannot be continued`,
    });
    release();
    await pending;
  });
});

describe("deleteTeam", () => {
  it("reports an empty team when no sub-agent belongs to the conversation", async () => {
    expect(await OrchestratorService.deleteTeam("empty", context() as never)).toEqual({
      name: "empty",
      deleted: true,
      subAgentsAborted: 0,
    });
    expect(await OrchestratorService.deleteTeam("no-context")).toEqual({
      name: "no-context",
      deleted: true,
      subAgentsAborted: 0,
    });
  });

  it("aborts a running team, releases reservations and removes worktrees", async () => {
    const ctx = context();
    const { pending, release } = await spawnRunning(ctx, { description: "first" });
    const second = OrchestratorService.spawnFromTool(
      spawnParams({ description: "second", orchestratorContext: ctx }) as never,
    );
    await vi.waitFor(() => {
      expect(
        OrchestratorService.listSubAgents({ parentConversationId: ctx.conversationId }),
      ).toHaveLength(2);
    });

    const result = await OrchestratorService.deleteTeam("alpha", ctx as never);

    expect(result).toEqual({ name: "alpha", deleted: true, subAgentsAborted: 2 });
    expect(OrchestratorService.listSubAgents({ parentConversationId: ctx.conversationId })).toEqual([]);
    expect(fakes.releaseReservation).toHaveBeenCalledTimes(2);
    expect(fakes.removeWorktree).toHaveBeenCalled();

    release();
    await Promise.allSettled([pending, second]);
  });
});

describe("listAllDescendantSubAgents", () => {
  it("walks parent→child conversation links breadth-first", async () => {
    const rootCtx = context();
    const parent = (await OrchestratorService.spawnFromTool(
      spawnParams({ orchestratorContext: rootCtx }) as never,
    )) as Event;
    const childConversationId = emitted.find(
      (event) => event.type === "sub_agent_status" && event.message === "spawned",
    )!.conversationId as string;
    cleanupIds.push(childConversationId);

    emitted = [];
    await OrchestratorService.spawnFromTool(
      spawnParams({
        description: "Child task",
        orchestratorContext: context({
          conversationId: childConversationId,
          agentConversationId: childConversationId,
        }),
      }) as never,
    );

    const descendants = OrchestratorService.listAllDescendantSubAgents(String(rootCtx.conversationId));
    expect(descendants.map((subAgent) => subAgent.description)).toEqual([
      "Write the report",
      "Child task",
    ]);
    expect(descendants[0]).toMatchObject({
      agentId: parent.agent_id,
      status: "complete",
      recursionDepth: 1,
      hasChanges: true,
      toolUses: 0,
    });
    expect(descendants[1]).toMatchObject({ recursionDepth: 1, providerName: "lm-studio" });

    // A conversation with no descendants yields nothing, and a deep chain stops at the depth cap.
    expect(OrchestratorService.listAllDescendantSubAgents("nobody")).toEqual([]);
    expect(OrchestratorService.getRootConversationId(childConversationId)).toBe(rootCtx.conversationId);
  });
});

describe("createTeam", () => {
  const members = [{ description: "one", prompt: "do one" }, { description: "two", prompt: "do two" }];

  it("rejects an unknown topology", async () => {
    const result = await OrchestratorService.createTeam(
      { name: "t", members, topology: "bogus" },
      context({ topology: "hierarchical" }) as never,
    );
    expect(result).toEqual([{ error: expect.stringContaining('Invalid topology: "bogus"') }]);
    expect(fakes.routerExecute).not.toHaveBeenCalled();
  });

  it("rejects spawning when recursion depth is zero", async () => {
    const result = await OrchestratorService.createTeam(
      { name: "t", members, topology: "sequential" },
      context({ maxRecursionDepth: 0 }) as never,
    );
    expect(result).toEqual([
      {
        error:
          "Sub-agent spawning is disabled (recursion depth is set to 0). Complete the task directly without delegating to sub-agents.",
      },
    ]);
  });

  it("rejects a missing members array and members without prompts", async () => {
    expect(
      await OrchestratorService.createTeam({ name: "t", members: undefined } as never, context() as never),
    ).toEqual([{ error: "Invalid or missing 'members' array in createTeam arguments." }]);

    const missing = await OrchestratorService.createTeam(
      {
        name: "t",
        members: [
          { description: "ok", prompt: "do it" },
          { description: "blank", prompt: "   " },
          { prompt: 7 },
        ],
      } as never,
      context() as never,
    );
    expect(missing).toHaveLength(1);
    expect(String((missing[0] as Event).error)).toContain('member[1] "blank"');
    expect(String((missing[0] as Event).error)).toContain('member[2] "(no description)"');
  });

  it("routes each topology to its router and returns the spawn results", async () => {
    const topologies = [
      "sequential",
      "peer_to_peer",
      "hierarchical_aggregation",
      "tournament",
      "critic_loop",
      "divide_and_conquer",
      "mcts",
      "hierarchical",
    ];
    const expectedRouters = [
      "SequentialRouter",
      "PeerToPeerRouter",
      "HierarchicalAggregationRouter",
      "TournamentRouter",
      "CriticLoopRouter",
      "DivideAndConquerRouter",
      "MCTSRouter",
      "HierarchicalRouter",
    ];

    for (const [index, topology] of topologies.entries()) {
      fakes.routerExecute.mockClear();
      const teamContext = context();
      const result = await OrchestratorService.createTeam(
        { name: `team-${topology}`, members, topology },
        teamContext as never,
      );
      expect(fakes.routerExecute.mock.calls[0][0]).toBe(expectedRouters[index]);
      expect(fakes.routerExecute.mock.calls[0][1]).toBe(`team-${topology}`);
      expect(fakes.routerExecute.mock.calls[0][2]).toEqual(members);
      expect(teamContext.topology).toBe(topology);
      expect(result).toEqual([
        { agent_id: `agent-from-${expectedRouters[index]}`, status: "completed" },
        { error: "second member failed" },
      ]);
    }
  });

  it("falls back to the settings topology and tolerates the conversation sync failing", async () => {
    fakes.getSection.mockResolvedValue({ topology: "tournament" });
    fakes.updateOne.mockRejectedValue(new Error("mongo down"));

    const teamContext = context({ topology: undefined });
    const result = await OrchestratorService.createTeam(
      { name: "settings-team", members },
      teamContext as never,
    );

    expect(fakes.routerExecute.mock.calls[0][0]).toBe("TournamentRouter");
    expect(teamContext.topology).toBe("tournament");
    expect(result).toHaveLength(2);
    expect(fakes.updateOne).toHaveBeenCalledWith(
      { id: teamContext.conversationId, project: "proj", username: "alice" },
      { $set: { "settings.agents.topology": "tournament", updatedAt: expect.any(String) } },
    );
  });

  it("warns when the topology sync matches no conversation document", async () => {
    fakes.updateOne.mockResolvedValue({ matchedCount: 0 });
    const result = await OrchestratorService.createTeam(
      { name: "unmatched", members, topology: "hierarchical" },
      context() as never,
    );
    expect(result).toHaveLength(2);
    expect(fakes.updateOne).toHaveBeenCalledTimes(1);
  });

  it("uses the default recursion depth when neither context nor settings provide one", async () => {
    fakes.getSection.mockResolvedValue({ topology: "hierarchical", maxRecursionDepth: 2 });
    const teamContext = context({ maxRecursionDepth: undefined });
    await OrchestratorService.createTeam({ name: "depth", members }, teamContext as never);
    expect(teamContext.maxRecursionDepth).toBe(2);
  });
});

describe("_runSubAgentLoop — abort and diff edge cases", () => {
  it("marks an aborted loop stopped and skips the commit", async () => {
    const abortError = new Error("aborted by user");
    abortError.name = "AbortError";
    fakes.runAgenticLoop.mockRejectedValue(abortError);

    const result = (await OrchestratorService.spawnFromTool(spawnParams() as never)) as Event;

    expect(result).toMatchObject({ status: "stopped" });
    expect(String(result.summary)).toContain("was stopped");
    expect(fakes.toolsApiPost).not.toHaveBeenCalled();
    expect(fakes.clearWorktree).toHaveBeenCalled();
  });

  it("drops the diff when the worktree diff call fails", async () => {
    fakes.getWorktreeDiff.mockResolvedValue({ error: "branch not found" });
    const result = (await OrchestratorService.spawnFromTool(spawnParams() as never)) as Event;
    expect(result.status).toBe("completed");
    expect(result.diff).toBeUndefined();
  });

  it("tolerates a non-numeric diff payload", async () => {
    fakes.getWorktreeDiff.mockResolvedValue({
      hasChanges: "yes",
      additions: 1,
      deletions: 1,
      files: [],
    });
    const result = (await OrchestratorService.spawnFromTool(spawnParams() as never)) as Event;
    expect(result.status).toBe("completed");
    expect(result.diff).toBeUndefined();
  });
});
