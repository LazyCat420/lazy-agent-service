/**
 * Topology routers — coverage of Sequential, Peer-to-Peer, Hierarchical
 * Aggregation, Tournament, Critic Loop, MCTS and Divide & Conquer.
 *
 * The routers are real. Sub-agent spawning, provider calls, instance
 * resolution, git worktree merges, request logging and locale strings are
 * fakes at the process boundary; assertions read the returned result arrays
 * (order, error objects, synthesis/judge entries) and the prompts the routers
 * build for their children.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getProvider: vi.fn(),
  resolveSiblingInstances: vi.fn(),
  selectInstanceForMember: vi.fn(),
  getDefaultWorkspaceRoot: vi.fn(),
  resolveRepositoryPath: vi.fn(),
  mergeWorktree: vi.fn(),
  logBackgroundLlmCall: vi.fn(),
  localeGet: vi.fn(),
}));

vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../orchestrator/InstanceResolver.ts", () => ({
  resolveSiblingInstances: fakes.resolveSiblingInstances,
  selectInstanceForMember: fakes.selectInstanceForMember,
}));
vi.mock("../orchestrator/GitWorktreeHelper.ts", () => ({
  GitWorktreeHelper: {
    getDefaultWorkspaceRoot: fakes.getDefaultWorkspaceRoot,
    resolveRepositoryPath: fakes.resolveRepositoryPath,
    mergeWorktree: fakes.mergeWorktree,
  },
}));
vi.mock("../RequestLogger.ts", () => ({
  default: { logBackgroundLlmCall: fakes.logBackgroundLlmCall },
}));
vi.mock("../PromptLocaleService.ts", () => ({
  default: { get: fakes.localeGet },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import { SequentialRouter } from "../orchestrator/routers/SequentialRouter.ts";
import { PeerToPeerRouter } from "../orchestrator/routers/PeerToPeerRouter.ts";
import { HierarchicalAggregationRouter } from "../orchestrator/routers/HierarchicalAggregationRouter.ts";
import { TournamentRouter } from "../orchestrator/routers/TournamentRouter.ts";
import { CriticLoopRouter } from "../orchestrator/routers/CriticLoopRouter.ts";
import { MCTSRouter } from "../orchestrator/routers/MCTSRouter.ts";
import { DivideAndConquerRouter } from "../orchestrator/routers/DivideAndConquerRouter.ts";
import { HierarchicalRouter } from "../orchestrator/routers/HierarchicalRouter.ts";

type Any = Record<string, unknown>;

const member = (overrides: Any = {}) => ({
  description: "member",
  prompt: "do the task",
  files: [],
  agent: "CODING",
  ...overrides,
});

const result = (overrides: Any = {}) => ({
  agent_id: "agent-1",
  description: "member",
  status: "completed",
  summary: "done",
  result: "output text",
  toolUses: 1,
  iterations: 1,
  durationMs: 10,
  messages: [],
  diff: null,
  ...overrides,
});

const context = (overrides: Any = {}) => ({
  providerName: "lm-studio",
  resolvedModel: "model-x",
  conversationId: "conv-1",
  project: "proj",
  username: "alice",
  workspaceRoot: "/ws",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  fakes.resolveSiblingInstances.mockResolvedValue([{ providerName: "lm-studio", model: "model-x" }]);
  fakes.selectInstanceForMember.mockReturnValue({ assignedProvider: "lm-studio", assignedModel: "model-x" });
  fakes.getDefaultWorkspaceRoot.mockReturnValue("/ws");
  fakes.resolveRepositoryPath.mockReturnValue("/ws/repo");
  fakes.mergeWorktree.mockResolvedValue({});
  fakes.logBackgroundLlmCall.mockResolvedValue(undefined);
  fakes.localeGet.mockImplementation((_locale: string, key: string) => `locale:${key}`);
});

describe("SequentialRouter.execute", () => {
  it("chains member prompts and accumulates prior step output", async () => {
    const prompts: string[] = [];
    const spawn = vi.fn(async (assignment: Any) => {
      prompts.push(assignment.prompt);
      return result({ agent_id: `a-${prompts.length}`, result: `step-${prompts.length}` });
    });
    const router = new SequentialRouter();

    const results = await router.execute(
      "team",
      [member({ description: "first" }), member({ description: "second" })],
      context() as never,
      spawn as never,
    );

    expect(results).toHaveLength(2);
    expect(prompts[0]).toBe("do the task");
    expect(prompts[1]).toContain("--- PREVIOUS STEPS RESULTS ---");
    expect(prompts[1]).toContain("Step 1 (first):\nstep-1");
  });

  it("merges the worktree branch when a step changed files", async () => {
    const spawn = vi.fn(async () => result({ diff: { additions: 2, deletions: 0, files: ["a.ts"] } }));
    const results = await new SequentialRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
    );
    expect(fakes.mergeWorktree).toHaveBeenCalledWith("/ws/repo", "orchestrator/agent-1", expect.stringContaining("chore(sequence)"));
    expect(results).toHaveLength(1);
  });

  it("returns the merge error after a successful step", async () => {
    fakes.mergeWorktree.mockResolvedValue({ error: "conflict" });
    const spawn = vi.fn(async () => result({ diff: { additions: 1, deletions: 1, files: ["a.ts"] } }));
    const results = await new SequentialRouter().execute("team", [member()], context() as never, spawn as never);
    expect(results).toEqual([
      expect.objectContaining({ status: "completed" }),
      { error: "Failed to merge branch for agent-1: conflict" },
    ]);
  });

  it("aborts the sequence on an errored step", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ error: "boom" })
      .mockResolvedValueOnce(result());
    const results = await new SequentialRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
    );
    expect(results).toEqual([{ error: "boom" }]);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("aborts the sequence on a failed status", async () => {
    const spawn = vi.fn().mockResolvedValue(result({ status: "failed" }));
    const results = await new SequentialRouter().execute("team", [member()], context() as never, spawn as never);
    expect(results).toEqual([expect.objectContaining({ status: "failed" })]);
  });
});

describe("PeerToPeerRouter.execute", () => {
  it("rejects members with empty prompts", async () => {
    const results = await new PeerToPeerRouter().execute(
      "team",
      [member({ prompt: "   " })],
      context() as never,
      vi.fn() as never,
    );
    expect(results).toEqual([{ error: expect.stringContaining("missing or empty prompts") }]);
  });

  it("spawns each member then continues their sessions in the next round", async () => {
    const spawn = vi.fn(async (assignment: Any) => result({ agent_id: `a-${assignment.agentIndex}`, result: "long substantive contribution ".repeat(4) }));
    const continuation = vi.fn(async (agentId: string) => result({ agent_id: agentId, result: "continued ".repeat(10) }));
    const results = await new PeerToPeerRouter().execute(
      "team",
      [member({ description: "alpha", agent: "agent-0" }), member({ description: "beta", agent: "agent-1" })],
      context() as never,
      spawn as never,
      continuation as never,
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(continuation).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][0].prompt).toContain("Your speaker identity in this discussion is agent-0");
    expect(spawn.mock.calls[1][0].prompt).toContain("--- SHARED DISCUSSION BOARD ---");
    expect(results).toHaveLength(2);
    expect(results.every((entry) => !("error" in entry))).toBe(true);
  });

  it("honours topologyConfig.maxRounds", async () => {
    const spawn = vi.fn(async () => result({ result: "substantive ".repeat(10) }));
    const continuation = vi.fn(async (_id: string) => result({ result: "more ".repeat(20) }));
    await new PeerToPeerRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
      continuation as never,
      { maxRounds: 1 } as never,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(continuation).toHaveBeenCalledTimes(0);
  });

  it("stops when a speaker signals [DONE]", async () => {
    const spawn = vi.fn(async () => result({ result: "all finished [DONE] " + "x".repeat(100) }));
    const results = await new PeerToPeerRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      vi.fn() as never,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });

  it("aborts the mesh on an errored turn", async () => {
    const spawn = vi.fn().mockResolvedValueOnce({ error: "spawn failed" });
    const results = await new PeerToPeerRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
    );
    expect(results).toEqual([{ error: "spawn failed" }]);
  });

  it("returns the merge error after a completed turn with file changes", async () => {
    fakes.mergeWorktree.mockResolvedValue({ error: "dirty tree" });
    const spawn = vi.fn(async () => result({ diff: { additions: 1, deletions: 0, files: ["a.ts"] }, result: "work ".repeat(20) }));
    const results = await new PeerToPeerRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
    );
    expect(results).toEqual([
      expect.objectContaining({ status: "completed" }),
      { error: "Failed to merge branch for agent-1: dirty tree" },
    ]);
  });

  it("aborts after three consecutive stall responses", async () => {
    const spawn = vi.fn(async () => result({ result: "ok", toolUses: 0 }));
    const continuation = vi.fn(async () => result({ result: "ok", toolUses: 0 }));
    const results = await new PeerToPeerRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
      continuation as never,
      { maxRounds: 5 } as never,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(continuation).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
  });
});

describe("HierarchicalAggregationRouter.execute", () => {
  const provider = { generateText: vi.fn() };

  beforeEach(() => {
    fakes.getProvider.mockReturnValue(provider);
    provider.generateText.mockReset();
    provider.generateText.mockResolvedValue({ text: "synthesized answer", usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it("runs proposers then a synthesis pass and appends the synthesis result", async () => {
    const spawn = vi.fn(async (assignment: Any) => result({ agent_id: `a-${assignment.agentIndex}` }));
    const results = await new HierarchicalAggregationRouter().execute(
      "team",
      [member({ description: "one" }), member({ description: "two" })],
      context() as never,
      spawn as never,
    );

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(3);
    expect(results[2]).toMatchObject({ status: "completed", result: "synthesized answer" });
    expect(String(provider.generateText.mock.calls[0][0][0].content)).toContain("## Sub-Agent Results");
  });

  it("returns proposer results only when a single proposer succeeds", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce({ error: "failed" });
    const results = await new HierarchicalAggregationRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
    );
    expect(results).toHaveLength(2);
    expect(provider.generateText).not.toHaveBeenCalled();
  });

  it("returns all results when every proposer fails", async () => {
    const spawn = vi.fn(async () => ({ error: "nope" }));
    const results = await new HierarchicalAggregationRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
    );
    expect(results).toEqual([{ error: "nope" }, { error: "nope" }]);
  });

  it("stops before synthesis when the provider is missing", async () => {
    fakes.getProvider.mockReturnValue(undefined);
    const spawn = vi.fn(async () => result());
    const results = await new HierarchicalAggregationRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
    );
    expect(results).toHaveLength(2);
    expect(results.every((entry) => !("error" in entry))).toBe(true);
  });

  it("runs multiple layers and feeds the previous synthesis into layer prompts", async () => {
    provider.generateText.mockResolvedValue({ text: "layer output" });
    const prompts: string[] = [];
    const spawn = vi.fn(async (assignment: Any) => {
      prompts.push(assignment.prompt);
      return result();
    });
    const results = await new HierarchicalAggregationRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      undefined,
      { layerCount: 2 } as never,
    );
    expect(prompts[2]).toContain("## Previous Layer Output (Auxiliary Context)");
    expect(prompts[2]).toContain("layer output");
    expect(results.length).toBeGreaterThan(3);
  });

  it("keeps the proposer results when synthesis throws", async () => {
    provider.generateText.mockRejectedValue(new Error("synthesis exploded"));
    const spawn = vi.fn(async () => result());
    const results = await new HierarchicalAggregationRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
    );
    expect(results).toHaveLength(2);
  });
});

describe("TournamentRouter.execute", () => {
  const provider = { generateText: vi.fn() };

  beforeEach(() => {
    fakes.getProvider.mockReturnValue(provider);
    provider.generateText.mockReset();
    provider.generateText.mockResolvedValue({ text: "winner: Sub-Agent #1", usage: { inputTokens: 3, outputTokens: 4 } });
  });

  it("appends the judge selection result after a judge pass", async () => {
    const spawn = vi.fn(async () => result());
    const results = await new TournamentRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
    );
    expect(results).toHaveLength(3);
    expect(results[2]).toMatchObject({ status: "completed", result: "winner: Sub-Agent #1" });
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "orchestrator:tournament-judge" }),
    );
  });

  it("skips the judge when only one candidate succeeds", async () => {
    const spawn = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce({ error: "failed" });
    const results = await new TournamentRouter().execute("team", [member(), member()], context() as never, spawn as never);
    expect(results).toHaveLength(2);
    expect(provider.generateText).not.toHaveBeenCalled();
  });

  it("returns the candidates when the provider is unavailable", async () => {
    fakes.getProvider.mockReturnValue(undefined);
    const spawn = vi.fn(async () => result());
    const results = await new TournamentRouter().execute("team", [member(), member()], context() as never, spawn as never);
    expect(results).toHaveLength(2);
  });

  it("returns the candidates when the judge call throws", async () => {
    provider.generateText.mockRejectedValue(new Error("judge down"));
    const spawn = vi.fn(async () => result());
    const results = await new TournamentRouter().execute("team", [member(), member()], context() as never, spawn as never);
    expect(results).toHaveLength(2);
  });

  it("verifies candidates and skips verification for unchanged diffs", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(result({ diff: { additions: 2, deletions: 0, files: ["a.ts"] } }))
      .mockResolvedValueOnce(result({ diff: null }))
      .mockResolvedValueOnce(result({ result: '[{"command":"tsc --noEmit","pass":true,"output":""},{"command":"npm test","pass":true,"output":""}]' }));
    const results = await new TournamentRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      undefined,
      { enableVerification: true } as never,
    );
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    expect(String(provider.generateText.mock.calls[0][0][0].content)).toContain("**Verification:**");
  });

  it("records a failing verification when the verifier errors", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(result({ diff: { additions: 1, deletions: 0, files: ["a.ts"] } }))
      .mockResolvedValueOnce(result({ diff: { additions: 1, deletions: 0, files: ["b.ts"] } }))
      .mockResolvedValueOnce({ error: "verifier crashed" })
      .mockResolvedValueOnce(result({ result: "PASS" }));
    const results = await new TournamentRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      undefined,
      { enableVerification: true } as never,
    );
    expect(results).toHaveLength(3);
  });
});

describe("CriticLoopRouter.execute — council mode", () => {
  it("returns the error for an empty member list", async () => {
    const results = await new CriticLoopRouter().execute("team", [], context() as never, vi.fn() as never);
    expect(results).toEqual([{ error: expect.stringContaining("at least 1 member") }]);
  });

  it("accepts the actor output on a unanimous PASS", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(result({ result: "actor output" }))
      .mockResolvedValueOnce(result({ result: "PASS\nlooks good" }));
    const results = await new CriticLoopRouter().execute(
      "team",
      [member({ description: "actor" }), member({ description: "critic" })],
      context() as never,
      spawn as never,
    );
    expect(results).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("continues the actor with feedback after a FAIL verdict", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(result({ result: "actor output" }))
      .mockResolvedValueOnce(result({ result: "FAIL\nneeds tests" }))
      .mockResolvedValueOnce(result({ result: "PASS\nfixed" }));
    const continuation = vi
      .fn()
      .mockResolvedValueOnce(result({ result: "revised actor output" }))
      .mockResolvedValueOnce(result({ result: "revised actor output" }));
    const results = await new CriticLoopRouter().execute(
      "team",
      [member({ description: "actor" }), member({ description: "critic" })],
      context() as never,
      spawn as never,
      continuation as never,
    );
    expect(continuation).toHaveBeenCalledWith("agent-1", expect.stringContaining("Critic Feedback (FAIL verdicts)"), expect.anything(), 2);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });

  it("creates a default critic when only the actor is supplied", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(result({ result: "actor output" }))
      .mockResolvedValueOnce(result({ result: "PASS" }));
    await new CriticLoopRouter().execute("team", [member()], context() as never, spawn as never);
    expect(spawn.mock.calls[1][0].prompt).toContain("locale:routers.critic.evaluator");
  });

  it("stops when the actor spawn errors", async () => {
    const spawn = vi.fn().mockResolvedValue({ error: "actor failed" });
    const results = await new CriticLoopRouter().execute("team", [member()], context() as never, spawn as never);
    expect(results).toEqual([{ error: "actor failed" }]);
  });

  it("treats an ambiguous verdict as a failure and stops at max rounds", async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce(result({ result: "actor output" }))
      .mockResolvedValueOnce(result({ result: "unsure what to say" }));
    const continuation = vi.fn(async () => result({ result: "revision" }));
    const results = await new CriticLoopRouter().execute(
      "team",
      [member(), member({ description: "critic" })],
      context() as never,
      spawn as never,
      continuation as never,
      { maxRounds: 1 } as never,
    );
    expect(continuation).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
  });
});

describe("CriticLoopRouter.execute — jury mode", () => {
  const provider = { generateText: vi.fn() };

  beforeEach(() => {
    fakes.getProvider.mockReturnValue(provider);
    provider.generateText.mockReset();
    provider.generateText.mockResolvedValue({ text: '{"bestActorIndex": 0, "verdict": "PASS", "feedback": "good"}' });
  });

  it("selects the best actor and returns on a PASS verdict", async () => {
    const spawn = vi.fn(async () => result({ result: "actor output" }));
    const results = await new CriticLoopRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      undefined,
      { actorCount: 2 } as never,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(String(provider.generateText.mock.calls[0][0][0].content)).toContain("## Competing Solutions");
  });

  it("refines the winner when the jury returns FAIL", async () => {
    provider.generateText
      .mockResolvedValueOnce({ text: '{"bestActorIndex": 1, "verdict": "FAIL", "feedback": "add tests"}' })
      .mockResolvedValueOnce({ text: '{"bestActorIndex": 0, "verdict": "PASS", "feedback": "ok"}' });
    const spawn = vi.fn(async () => result({ result: "actor output" }));
    const continuation = vi.fn(async () => result({ result: "revised" }));
    const results = await new CriticLoopRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      continuation as never,
      { actorCount: 2 } as never,
    );
    expect(continuation).toHaveBeenCalledWith("agent-1", expect.stringContaining("Judge's Feedback"), expect.anything(), 2);
    expect(results).toHaveLength(3);
  });

  it("returns the actors when the provider is missing", async () => {
    fakes.getProvider.mockReturnValue(undefined);
    const spawn = vi.fn(async () => result());
    const results = await new CriticLoopRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      undefined,
      { actorCount: 2 } as never,
    );
    expect(results).toHaveLength(2);
  });

  it("returns the actors when the jury call throws", async () => {
    provider.generateText.mockRejectedValue(new Error("judge down"));
    const spawn = vi.fn(async () => result());
    const results = await new CriticLoopRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      undefined,
      { actorCount: 2 } as never,
    );
    expect(results).toHaveLength(2);
  });

  it("aborts when every actor fails", async () => {
    const spawn = vi.fn(async () => ({ error: "actor failed" }));
    const results = await new CriticLoopRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      undefined,
      { actorCount: 2 } as never,
    );
    expect(results).toHaveLength(2);
    expect(provider.generateText).not.toHaveBeenCalled();
  });

  it("falls back to actor 0 when the jury response is unparseable", async () => {
    provider.generateText.mockResolvedValue({ text: "not json at all" });
    const spawn = vi.fn(async () => result());
    const continuation = vi.fn(async () => result());
    const results = await new CriticLoopRouter().execute(
      "team",
      [member(), member()],
      context() as never,
      spawn as never,
      continuation as never,
      { actorCount: 2 } as never,
    );
    expect(continuation).toHaveBeenCalledWith("agent-1", expect.stringContaining("not json at all"), expect.anything(), 2);
    expect(results.length).toBeGreaterThan(2);
  });
});

describe("MCTSRouter.execute", () => {
  const provider = { generateText: vi.fn() };

  beforeEach(() => {
    fakes.getProvider.mockReturnValue(provider);
    provider.generateText.mockReset();
    provider.generateText.mockResolvedValue({
      text: JSON.stringify({ scores: [0.9, 0.4], bestBranchIndex: 0, isComplete: true, feedback: "done", branchFeedback: ["a", "b"] }),
    });
  });

  it("returns a provider error when the provider is missing", async () => {
    fakes.getProvider.mockReturnValue(undefined);
    const results = await new MCTSRouter().execute("team", [member()], context() as never, vi.fn() as never);
    expect(results).toEqual([{ error: 'Provider "lm-studio" not found' }]);
  });

  it("expands the root, evaluates the branches and appends a search summary", async () => {
    const spawn = vi.fn(async (assignment: Any) => result({ agent_id: `a-${assignment.agentIndex}` }));
    const results = await new MCTSRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
      undefined,
      { branchFactor: 2, maxDepth: 1, searchIterations: 1 } as never,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(3);
    expect(results[2]).toMatchObject({ status: "completed", summary: expect.stringContaining("MCTS search explored") });
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "orchestrator:mcts-evaluate" }),
    );
  });

  it("aborts the search when all branches fail on the first iteration", async () => {
    const spawn = vi.fn(async () => ({ error: "branch failed" }));
    const results = await new MCTSRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
      undefined,
      { branchFactor: 2, searchIterations: 1 } as never,
    );
    expect(results).toEqual([{ error: "branch failed" }, { error: "branch failed" }]);
  });

  it("falls back to neutral scores when evaluation fails", async () => {
    provider.generateText.mockRejectedValue(new Error("eval down"));
    const spawn = vi.fn(async () => result());
    const results = await new MCTSRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
      undefined,
      { branchFactor: 2, maxDepth: 1, searchIterations: 1 } as never,
    );
    expect(results).toHaveLength(3);
    expect(results[2]).toMatchObject({ status: "completed" });
  });

  it("runs a second iteration by expanding a recorded node", async () => {
    provider.generateText
      .mockResolvedValueOnce({ text: JSON.stringify({ scores: [0.9, 0.4], bestBranchIndex: 0, isComplete: false, feedback: "", branchFeedback: ["a", "b"] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ scores: [0.7, 0.6], bestBranchIndex: 0, isComplete: true, feedback: "", branchFeedback: ["a", "b"] }) });
    const spawn = vi.fn(async () => result());
    const results = await new MCTSRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
      undefined,
      { branchFactor: 2, maxDepth: 2, searchIterations: 2 } as never,
    );
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(5);
  });
});

describe("DivideAndConquerRouter.execute", () => {
  const provider = { generateText: vi.fn() };

  beforeEach(() => {
    fakes.getProvider.mockReturnValue(provider);
    provider.generateText.mockReset();
    provider.generateText.mockResolvedValue({
      text: JSON.stringify([
        { description: "first subtask", prompt: "do first" },
        { description: "second subtask", prompt: "do second", dependsOn: [0] },
      ]),
    });
  });

  it("rejects an empty member list", async () => {
    const results = await new DivideAndConquerRouter().execute("team", [], context() as never, vi.fn() as never);
    expect(results).toEqual([{ error: "No members provided for Divide & Conquer execution" }]);
  });

  it("returns a provider error when the provider is missing", async () => {
    fakes.getProvider.mockReturnValue(undefined);
    const results = await new DivideAndConquerRouter().execute("team", [member()], context() as never, vi.fn() as never);
    expect(results).toEqual([{ error: 'Provider "lm-studio" not found for decomposition pass' }]);
  });

  it("decomposes, executes tiers in order and synthesises", async () => {
    provider.generateText
      .mockResolvedValueOnce({
        text: JSON.stringify([
          { description: "first subtask", prompt: "do first" },
          { description: "second subtask", prompt: "do second", dependsOn: [0] },
        ]),
      })
      .mockResolvedValueOnce({ text: "synthesized" });
    const prompts: string[] = [];
    const spawn = vi.fn(async (assignment: Any) => {
      prompts.push(assignment.prompt);
      return result();
    });
    const results = await new DivideAndConquerRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
    );
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("## Prerequisite Subtask Outputs");
    expect(results).toHaveLength(3);
    expect(results[2]).toMatchObject({ result: "synthesized" });
  });

  it("falls back to a single subtask when decomposition returns nothing", async () => {
    provider.generateText.mockResolvedValueOnce({ text: "not json" }).mockResolvedValueOnce({ text: "s" });
    const spawn = vi.fn(async () => result());
    const results = await new DivideAndConquerRouter().execute("team", [member()], context() as never, spawn as never);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
  });

  it("returns a decomposition error when the planner throws", async () => {
    provider.generateText.mockRejectedValue(new Error("planner down"));
    const results = await new DivideAndConquerRouter().execute("team", [member()], context() as never, vi.fn() as never);
    expect(results).toEqual([{ error: "Decomposition failed: planner down" }]);
  });

  it("skips synthesis when all subtasks fail", async () => {
    const spawn = vi.fn(async () => ({ error: "subtask failed" }));
    const results = await new DivideAndConquerRouter().execute("team", [member()], context() as never, spawn as never);
    expect(results).toEqual([{ error: "subtask failed" }, { error: "subtask failed" }]);
  });

  it("returns the subtask results when synthesis throws", async () => {
    provider.generateText
      .mockResolvedValueOnce({
        text: JSON.stringify([
          { description: "a", prompt: "do a" },
          { description: "b", prompt: "do b" },
        ]),
      })
      .mockRejectedValueOnce(new Error("synthesis down"));
    const spawn = vi.fn(async () => result());
    const results = await new DivideAndConquerRouter().execute("team", [member()], context() as never, spawn as never);
    expect(results).toHaveLength(2);
  });

  it("recursively decomposes long subtasks and synthesises the children", async () => {
    const longPrompt = "x".repeat(400);
    provider.generateText
      .mockResolvedValueOnce({
        text: JSON.stringify([{ description: "long subtask", prompt: longPrompt }, { description: "short", prompt: "do short" }]),
      })
      .mockResolvedValueOnce({ text: JSON.stringify([{ description: "child a", prompt: "do a" }, { description: "child b", prompt: "do b" }]) })
      .mockResolvedValueOnce({ text: "recursive synthesis" })
      .mockResolvedValueOnce({ text: "top synthesis" });
    const spawn = vi.fn(async () => result());
    const results = await new DivideAndConquerRouter().execute(
      "team",
      [member()],
      context() as never,
      spawn as never,
      undefined,
      { maxRecursionDepth: 2, recursionComplexityThreshold: 300 } as never,
    );
    expect(results).toHaveLength(3);
    expect(results.some((entry) => !("error" in entry) && String(entry.description).includes("Recursive synthesis"))).toBe(true);
  });
});

describe("HierarchicalRouter.execute", () => {
  it("spawns every member in parallel and returns their results in order", async () => {
    const spawn = vi.fn(async (assignment: Any) => result({ agent_id: `a-${assignment.agentIndex}` }));
    const results = await new HierarchicalRouter().execute(
      "team",
      [member({ description: "one" }), member({ description: "two" }), member({ description: "three" })],
      context() as never,
      spawn as never,
    );
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(results.map((entry) => (entry as Any).agent_id)).toEqual(["a-0", "a-1", "a-2"]);
  });
});


