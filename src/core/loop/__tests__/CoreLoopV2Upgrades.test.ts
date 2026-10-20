import { describe, it, expect, vi, afterEach } from "vitest";
import { runCoreLoop } from "../CoreLoop.ts";
import { SpillBuffer } from "../SpillBuffer.ts";
import { RunawayStreamWatch, RUNAWAY_RECOVERY_NUDGE } from "../RunawayStreamWatch.ts";
import {
  compactMessages,
  estimateSingleMessageChars,
  verifyToolPairAtomicity,
} from "../MessageCompactor.ts";
import {
  substituteToolBatchPlaceholders,
  substituteToolOutputTokens,
} from "../ToolOutputSubstituter.ts";
import { stripHistoricalReasoning, formatToolLoadoutDelta, shouldSkipTradingLearning } from "../RunsAdapter.ts";
import { computeToolCallFingerprint } from "../ToolRunner.ts";
import { normalizeLocalModelId } from "../../../services/DynamicModelResolver.ts";
import { prepareTradingAgentRequest, shouldSkipLearningForProject } from "../../../services/TradingAgentRequest.ts";
import {
  prepareTradingRequest,
  filterTradingPayload,
} from "../../../services/learning/TradingLearningBoundary.ts";
import { GlobalCapabilityExecutor } from "../../../services/GlobalCapabilityExecutor.ts";
import AgenticLoopService from "../../../services/AgenticLoopService.ts";
import {
  shouldUseCoreLoopForAgent,
  runCoreLoopForAgent,
  dispatchAgentRouteWithRollback,
  protectInitialUserBriefFromMerge,
} from "../AgentRouteAdapter.ts";
import { expandMessagesForFunctionCall } from "../../../utils/FunctionCallingUtilities.ts";
import {
  prepareOpenAICompatMessages,
  prependIdentitySystemMessage,
  rewriteNonLeadingSystemMessages,
} from "../../../utils/openai-compat.ts";
import { scriptedModel } from "./fakes.ts";
import type {
  ChatMessage,
  CoreLoopEvent,
  CoreLoopOptions,
  CoreLoopResult,
  CoreTool,
} from "../types.ts";

const defaultSignal = new AbortController().signal;

async function runLoop(
  options: CoreLoopOptions,
): Promise<{ result: CoreLoopResult; events: CoreLoopEvent[] }> {
  const events: CoreLoopEvent[] = [];
  const generator = runCoreLoop(options);
  for (;;) {
    const step = await generator.next();
    if (step.done) return { result: step.value, events };
    events.push(step.value);
  }
}

function baseOptions(overrides: Partial<CoreLoopOptions>): CoreLoopOptions {
  return {
    model: scriptedModel([]),
    tools: [],
    messages: [{ role: "user", content: "hi" }],
    signal: defaultSignal,
    maxSteps: 10,
    ...overrides,
  };
}

describe("CoreLoop v2 Upgrades (H1-H10) & Reliability Fixes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── H1: Interleaved Reasoning Preservation ──────────────────────────
  describe("H1 — Interleaved Reasoning Preservation (thinking + reasoning_content)", () => {
    it("preserves thinking and reasoning_content on active assistant tool-call turns and strips historical turns", async () => {
      const model = scriptedModel([
        [
          { type: "thinking", content: "First I should call lookup_ticker for NVDA." },
          { type: "toolCall", id: "tc_1", name: "lookup_ticker", args: { symbol: "NVDA" } },
        ],
        [
          { type: "thinking", content: "Now I have the price, I can answer." },
          "NVDA price is 140.",
        ],
      ]);

      const lookupTool: CoreTool = {
        name: "lookup_ticker",
        description: "Lookup price",
        parameters: { type: "object", properties: { symbol: { type: "string" } } },
        execute: async () => ({ symbol: "NVDA", price: 140 }),
      };

      const { result } = await runLoop(
        baseOptions({
          model,
          tools: [lookupTool],
          messages: [{ role: "user", content: "What is NVDA trading at?" }],
        }),
      );

      expect(result.status).toBe("completed");
      // On the second model call, the assistant message from turn 1 must carry thinking & reasoning_content
      const secondCallAssistant = model.calls[1].messages.find((m) => m.role === "assistant");
      expect(secondCallAssistant?.thinking).toBe("First I should call lookup_ticker for NVDA.");
      expect(secondCallAssistant?.reasoning_content).toBe("First I should call lookup_ticker for NVDA.");

      // Verify expandMessagesForFunctionCall and prepareOpenAICompatMessages preserve reasoning_content
      const expanded = expandMessagesForFunctionCall(model.calls[1].messages as any);
      const assistantExpanded = expanded.find((m: any) => m.role === "assistant");
      expect(assistantExpanded?.reasoning_content).toBe("First I should call lookup_ticker for NVDA.");

      const compat = await prepareOpenAICompatMessages(model.calls[1].messages as any);
      const assistantCompat = compat.find((m: any) => m.role === "assistant");
      expect(assistantCompat?.reasoning_content).toBe("First I should call lookup_ticker for NVDA.");

      // Verify stripHistoricalReasoning strips reasoning prior to the latest user boundary
      const multiTurnHistory: ChatMessage[] = [
        { role: "user", content: "Turn 1 user" },
        {
          role: "assistant",
          content: "Turn 1 answer",
          thinking: "Old thinking",
          reasoning_content: "Old reasoning",
        },
        { role: "user", content: "Turn 2 user" },
        {
          role: "assistant",
          content: "",
          thinking: "Current turn thinking",
          reasoning_content: "Current turn reasoning",
          toolCalls: [{ id: "c2", name: "lookup_ticker", args: {} }],
        },
      ];
      const stripped = stripHistoricalReasoning(multiTurnHistory);
      expect(stripped[1].thinking).toBeUndefined();
      expect(stripped[1].reasoning_content).toBeUndefined();
      expect(stripped[3].thinking).toBe("Current turn thinking");
      expect(stripped[3].reasoning_content).toBe("Current turn reasoning");
    });
  });

  // ── H2: Semantic Duplicate Tool-Call & 3-Cycle Oscillation Guard ────
  describe("H2 — Semantic Duplicate Tool-Call & 3-Cycle Oscillation Guard", () => {
    it("normalizes JSON key order in computeToolCallFingerprint", () => {
      const f1 = computeToolCallFingerprint("search", { b: 2, a: 1, nested: { y: 1, x: 2 } });
      const f2 = computeToolCallFingerprint("search", { a: 1, nested: { x: 2, y: 1 }, b: 2 });
      expect(f1).toBe(f2);
    });

    it("blocks 2nd consecutive identical successful tool call with TOOL_STALL and finalizes on 3rd", async () => {
      let execCount = 0;
      const fetchTool: CoreTool = {
        name: "fetch_data",
        description: "Fetch data",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          execCount += 1;
          return { rows: ["item_1"] };
        },
      };

      const model = scriptedModel([
        // Iteration 1: 1st call succeeds
        [{ type: "toolCall", id: "c1", name: "fetch_data", args: { a: 1, b: 2 } }],
        // Iteration 2: 2nd identical call (reversed key order) -> blocked with TOOL_STALL
        [{ type: "toolCall", id: "c2", name: "fetch_data", args: { b: 2, a: 1 } }],
        // Iteration 3: 3rd identical call -> triggers finalizeNow ("repeated_tool_call:fetch_data")
        [{ type: "toolCall", id: "c3", name: "fetch_data", args: { a: 1, b: 2 } }],
        // Final synthesis pass (tools: [])
        ["Synthesized final response after stall."],
      ]);

      const { result, events } = await runLoop(
        baseOptions({
          model,
          tools: [fetchTool],
          messages: [{ role: "user", content: "Fetch data" }],
        }),
      );

      expect(execCount).toBe(1); // Only executed once!
      expect(result.status).toBe("completed");
      expect(result.text).toBe("Synthesized final response after stall.");
      expect(result.finalizeReason).toBe("repeated_tool_call:fetch_data");
      expect(events.some((e) => e.type === "finalize" && e.reason === "repeated_tool_call:fetch_data")).toBe(true);
      // 4th model call must be the toolless final synthesis pass (finalPass: true, toolChoice: "none")
      expect(model.calls).toHaveLength(4);
      expect(model.calls[3].finalPass).toBe(true);
      expect(model.calls[3].toolChoice).toBe("none");
    });

    it("detects 3-cycle A <-> B oscillation across 6 calls and returns TOOL_OSCILLATION", async () => {
      let execCount = 0;
      const makeTool = (name: string): CoreTool => ({
        name,
        description: name,
        parameters: { type: "object", properties: {} },
        execute: async () => {
          execCount += 1;
          return { ok: true, tool: name };
        },
      });

      const model = scriptedModel([
        [{ type: "toolCall", id: "1", name: "tool_a", args: { x: 1 } }],
        [{ type: "toolCall", id: "2", name: "tool_b", args: { y: 2 } }],
        [{ type: "toolCall", id: "3", name: "tool_a", args: { x: 1 } }],
        [{ type: "toolCall", id: "4", name: "tool_b", args: { y: 2 } }],
        [{ type: "toolCall", id: "5", name: "tool_a", args: { x: 1 } }],
        [{ type: "toolCall", id: "6", name: "tool_b", args: { y: 2 } }], // 6th call completes 3 cycles of A <-> B
        ["Stopped oscillating."],
      ]);

      const { result } = await runLoop(
        baseOptions({
          model,
          tools: [makeTool("tool_a"), makeTool("tool_b")],
          messages: [{ role: "user", content: "Oscillate test" }],
        }),
      );

      expect(result.status).toBe("completed");
      expect(execCount).toBe(5); // 6th call was blocked by TOOL_OSCILLATION before execute()
      const sixthToolMsg = result.messages.filter((m) => m.role === "tool")[5];
      expect(sixthToolMsg?.content).toContain("TOOL_OSCILLATION");
    });
  });

  // ── H3: Runaway Generation Stream Watchdog ──────────────────────────
  describe("H3 — RunawayStreamWatch", () => {
    it("trips on 256 identical consecutive characters", () => {
      const watch = new RunawayStreamWatch();
      const prefix = "Normal reasoning prefix before runaway: ";
      expect(watch.feedText(prefix)).toBe(false);
      const tripped = watch.feedText("x".repeat(260));
      expect(tripped).toBe(true);
      expect(watch.tripped).toBe(true);
      expect(watch.reason).toContain("char_run");
      expect(watch.cleanText(prefix + "x".repeat(260))).toBe(prefix);
    });

    it("trips on 10x contiguous phrase loop (20..200 chars)", () => {
      const watch = new RunawayStreamWatch();
      const prefix = "Analyzing market regime: ";
      const phrase = "The RSI is neutral at 50. "; // 26 chars
      expect(watch.feedText(prefix)).toBe(false);
      const tripped = watch.feedText(phrase.repeat(10));
      expect(tripped).toBe(true);
      expect(watch.reason).toContain("exact_phrase_loop");
      expect(watch.cleanText(prefix + phrase.repeat(10))).toBe(prefix + phrase);
    });

    it("aborts runaway stream in CoreLoop, injects recovery nudge once, and completes on retry", async () => {
      const clean = "Here is the start of my analysis. ";
      const model = scriptedModel([
        [clean, "A".repeat(300)],
        ["Concise recovered final answer."],
      ]);

      const { result, events } = await runLoop(
        baseOptions({
          model,
          messages: [{ role: "user", content: "Analyze SPY" }],
        }),
      );

      expect(result.status).toBe("completed");
      expect(result.text).toBe("Concise recovered final answer.");
      expect(events.some((e) => e.type === "warning" && e.code === "RUNAWAY_GENERATION")).toBe(true);
      // Turn 2 must have received RUNAWAY_RECOVERY_NUDGE
      const turn2Messages = model.calls[1].messages;
      expect(turn2Messages.some((m) => m.role === "user" && m.content === RUNAWAY_RECOVERY_NUDGE)).toBe(true);
    });
  });

  // ── H4: Structured Corrective Error Feedback (Fission-GRPO) ─────────
  describe("H4 — Structured Corrective Error Feedback", () => {
    it("formats TOOL_THREW errors with structured retry_guidance JSON", async () => {
      const badDbTool: CoreTool = {
        name: "query_db",
        description: "Query DB",
        parameters: { type: "object", properties: { sql: { type: "string" } } },
        execute: async () => {
          throw new Error("Connection refused on port 5432");
        },
      };

      const model = scriptedModel([
        [{ type: "toolCall", id: "tc_err", name: "query_db", args: { sql: "SELECT 1" } }],
        ["Database is unreachable."],
      ]);

      const { result } = await runLoop(
        baseOptions({
          model,
          tools: [badDbTool],
          messages: [{ role: "user", content: "Check DB" }],
        }),
      );

      expect(result.status).toBe("completed");
      const toolMsg = model.calls[1].messages.find((m) => m.role === "tool");
      const parsed = JSON.parse(toolMsg!.content);
      expect(parsed.error).toContain("Connection refused on port 5432");
      expect(parsed.retry_guidance).toContain("Attempt 1/3 failed for query_db");
      expect(parsed.retry_guidance).toContain("Do not repeat identical arguments");
    });
  });

  // ── H5: Two-Tier Tool Output Spill Buffer + read_tool_spill ─────────
  describe("H5 — SpillBuffer and read_tool_spill", () => {
    it("stores oversized tool outputs in SpillBuffer and allows reading middle sections via read_tool_spill", async () => {
      const middleMarker = "MIDDLE_SECRET_TOKEN_987654321";
      const bigOutput =
        "HEAD_".repeat(1600) + // 8,000 chars
        middleMarker +
        "_MID_".repeat(2000) + // 10,000 chars
        "TAIL_".repeat(1600); // 8,000 chars (~26,000 chars total > 16,000 cap)

      const dumpLogsTool: CoreTool = {
        name: "dump_logs",
        description: "Dump logs",
        parameters: { type: "object", properties: {} },
        execute: async () => bigOutput,
      };

      const model = scriptedModel([
        [{ type: "toolCall", id: "c_big", name: "dump_logs", args: {} }],
        [
          {
            type: "toolCall",
            id: "c_spill",
            name: "read_tool_spill",
            args: { spill_id: "spill_1", offset: 7990, length: 100 },
          },
        ],
        ["Found marker in spill."],
      ]);

      const { result } = await runLoop(
        baseOptions({
          model,
          tools: [dumpLogsTool],
          messages: [{ role: "user", content: "Dump logs" }],
        }),
      );

      expect(result.status).toBe("completed");
      const firstToolMsg = model.calls[1].messages.find((m) => m.role === "tool");
      expect(firstToolMsg?.content).toContain('spill_id="spill_1"');
      expect(firstToolMsg?.content).toContain("read_tool_spill");

      const secondToolMsg = model.calls[2].messages.filter((m) => m.role === "tool")[1];
      const parsedSpill = JSON.parse(secondToolMsg!.content);
      expect(parsedSpill.ok).toBe(true);
      expect(parsedSpill.content).toContain(middleMarker);

      // Direct unit check on SpillBuffer FIFO eviction and clear()
      const buf = new SpillBuffer(2048);
      const id1 = buf.store("A".repeat(1500));
      const id2 = buf.store("B".repeat(1500)); // evicts id1 to stay <= 2048 bytes
      expect(id1).toBe("spill_1");
      expect(id2).toBe("spill_2");
      expect(buf.read("spill_1").ok).toBe(false);
      expect(buf.read("spill_2").ok).toBe(true);
      buf.clear();
      expect(buf.size()).toBe(0);
    });
  });

  // ── H6 & B8: Tool-Pair-Atomic Message Compactor ─────────────────────
  describe("H6 & B8 — Tool-Pair-Atomic Message Compactor", () => {
    it("never leaves orphan role:'tool' messages when compacting over token budget", () => {
      const messages: ChatMessage[] = [
        { role: "system", content: "System instructions" },
        { role: "user", content: "Initial user request" },
        // Orphan tool message at start of middle (e.g. from legacy corruption)
        { role: "tool", content: "orphan tool output", tool_call_id: "orphan_1", name: "old_tool" },
        // Turn group 1
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "tc_1a", name: "alpha", args: {} },
            { id: "tc_1b", name: "beta", args: {} },
          ],
        },
        { role: "tool", content: "X".repeat(2000), tool_call_id: "tc_1a", name: "alpha" },
        { role: "tool", content: "Y".repeat(2000), tool_call_id: "tc_1b", name: "beta" },
        // Turn group 2
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc_2", name: "gamma", args: {} }],
        },
        { role: "tool", content: "Z".repeat(2000), tool_call_id: "tc_2", name: "gamma" },
        // Turn group 3 (recent tail)
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "tc_3", name: "delta", args: {} }],
        },
        { role: "tool", content: "Recent result", tool_call_id: "tc_3", name: "delta" },
      ];

      const compacted = compactMessages(messages, {
        budgetTokens: 300, // ~1200 chars -> forces eviction of Turn groups 1 and 2
        keepRecentGroups: 1,
      });

      const check = verifyToolPairAtomicity(compacted);
      expect(check.valid).toBe(true);
      expect(check.orphanToolCallIds).toEqual([]);
      expect(check.missingResultToolCallIds).toEqual([]);
      // Tail group tc_3 must still be intact
      expect(compacted.some((m) => m.role === "tool" && m.tool_call_id === "tc_3")).toBe(true);
      // Evicted tc_1a / tc_1b and orphan_1 must be completely gone
      expect(
        compacted.some(
          (m) =>
            m.tool_call_id === "tc_1a" ||
            m.tool_call_id === "tc_1b" ||
            m.tool_call_id === "orphan_1",
        ),
      ).toBe(false);
    });
  });

  // ── H7: Zero-Token Tool-Output Placeholder Substitution ─────────────
  describe("H7 — Zero-Token Tool-Output Placeholder Substitution", () => {
    it("resolves {{tool_output:<id_or_name>.path}} from prior tool outputs in the run", () => {
      const payloadJson = JSON.stringify({ user: { id: "usr_42", tags: ["admin", "quant"] } });
      const outputs = new Map<string, string>([
        ["call_1", payloadJson],
        ["fetch_user", payloadJson],
      ]);

      const batch = substituteToolBatchPlaceholders(
        [
          {
            id: "call_2",
            name: "audit_user",
            args: {
              userId: "{{tool_output:call_1.user.id}}",
              primaryTag: "{{tool_output:fetch_user.user.tags[1]}}",
              summary: "Auditing {{tool_output:call_1.user.id}} now",
            },
          },
        ],
        outputs,
      );

      expect(batch[0].args).toEqual({
        userId: "usr_42",
        primaryTag: "quant",
        summary: "Auditing usr_42 now",
      });
    });
  });

  // ── H8: Dynamic Tool-Loadout Delta Notification ─────────────────────
  describe("H8 — formatToolLoadoutDelta", () => {
    it("emits a <system-reminder> when new tools are unlocked mid-run and null when unchanged", () => {
      const prev = ["search_tools"];
      const next = [
        { name: "search_tools" },
        { name: "execute_trade", description: "Place market order" },
      ];
      const delta = formatToolLoadoutDelta(prev, next);
      expect(delta).toContain("<system-reminder>");
      expect(delta).toContain("+ execute_trade — Place market order");
      expect(
        formatToolLoadoutDelta(
          next.map((t) => t.name),
          next,
        ),
      ).toBeNull();
    });
  });

  // ── H9: Mid-Run Steering & Follow-Up Queue ──────────────────────────
  describe("H9 — getSteeringMessages & getFollowUpMessages", () => {
    it("injects steering messages mid-run and continues on follow-up messages before stopping", async () => {
      let steeringDelivered = false;
      let followUpDelivered = false;

      const stepOneTool: CoreTool = {
        name: "step_one",
        description: "Step one",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ step: 1 }),
      };

      const model = scriptedModel([
        [{ type: "toolCall", id: "tc_1", name: "step_one", args: {} }],
        ["Completed first part."],
        ["Completed follow-up part."],
      ]);

      const { result } = await runLoop(
        baseOptions({
          model,
          tools: [stepOneTool],
          messages: [{ role: "user", content: "Start work" }],
          getSteeringMessages: async () => {
            if (!steeringDelivered) {
              steeringDelivered = true;
              return [{ role: "user", content: "STEERING: focus on risk metrics" }];
            }
            return [];
          },
          getFollowUpMessages: async () => {
            if (!followUpDelivered) {
              followUpDelivered = true;
              return [{ role: "user", content: "FOLLOW_UP: also summarize drawdown" }];
            }
            return [];
          },
        }),
      );

      expect(result.status).toBe("completed");
      expect(result.text).toBe("Completed follow-up part.");
      expect(model.calls).toHaveLength(3);
      expect(
        model.calls[1].messages.some((m) => m.content.includes("STEERING: focus on risk metrics")),
      ).toBe(true);
      expect(
        model.calls[2].messages.some((m) => m.content.includes("FOLLOW_UP: also summarize drawdown")),
      ).toBe(true);
    });
  });

  // ── H10: Bounded Parallel Tool Concurrency ──────────────────────────
  describe("H10 — Bounded Parallel Tool Concurrency", () => {
    it("caps simultaneous parallel tool executions at parallelToolMaxConcurrency", async () => {
      let active = 0;
      let peakActive = 0;

      const ioTaskTool: CoreTool = {
        name: "io_task",
        description: "Parallel IO task",
        parameters: { type: "object", properties: { i: { type: "number" } } },
        execute: async (args) => {
          active += 1;
          if (active > peakActive) peakActive = active;
          await new Promise((r) => setTimeout(r, 15));
          active -= 1;
          return { i: args.i };
        },
      };

      const twentyCalls = Array.from({ length: 20 }, (_, i) => ({
        type: "toolCall" as const,
        id: `call_${i}`,
        name: "io_task",
        args: { i },
      }));

      const model = scriptedModel([twentyCalls, ["All 20 parallel tasks finished."]]);

      const { result } = await runLoop(
        baseOptions({
          model,
          tools: [ioTaskTool],
          messages: [{ role: "user", content: "Run 20 tasks" }],
          parallelToolMaxConcurrency: 4,
        }),
      );

      expect(result.status).toBe("completed");
      expect(peakActive).toBeLessThanOrEqual(4);
      expect(peakActive).toBeGreaterThanOrEqual(2);
    });
  });

  // ── B4, Backlog 13, Phase 6 Step 6.3, and Option B AgentRouteAdapter ─
  describe("Trading Boundary (B4), Model Normalization (Backlog 13), ReadPage Fallback (6.3), and Option B Adapter", () => {
    it("B4: skips memory and workflow learning for vllm-trading-bot", () => {
      expect(shouldSkipTradingLearning({ project: "vllm-trading-bot" })).toBe(true);
      expect(shouldSkipTradingLearning({ project: "other-project" })).toBe(false);
      expect(shouldSkipLearningForProject("vllm-trading-bot")).toBe(true);

      const prevKey = process.env.TRADING_TOOL_CONTEXT_KEY;
      process.env.TRADING_TOOL_CONTEXT_KEY = "test-signing-key-for-trading-boundary";
      try {
        const prepared = prepareTradingAgentRequest({
          project: "vllm-trading-bot",
          provider: "vllm",
          agent: "macro_specialist",
          conversationId: "conv_123",
        });
        expect(prepared.skipMemoryExtraction).toBe(true);
        expect(prepared.skipWorkflowExtraction).toBe(true);
      } finally {
        if (prevKey === undefined) delete process.env.TRADING_TOOL_CONTEXT_KEY;
        else process.env.TRADING_TOOL_CONTEXT_KEY = prevKey;
      }
    });

    it("Backlog 13: normalizes GLM-5.3-Flash-EXL3 to GLM-5.3-Flash-EXL3-TF", () => {
      expect(normalizeLocalModelId("GLM-5.3-Flash-EXL3")).toBe("GLM-5.3-Flash-EXL3-TF");
      expect(normalizeLocalModelId("local-dspark/GLM-5.3-Flash-EXL3")).toBe(
        "local-dspark/GLM-5.3-Flash-EXL3-TF",
      );
      expect(normalizeLocalModelId("local-dspark/GLM-5.3-Flash-EXL3-TF")).toBe(
        "local-dspark/GLM-5.3-Flash-EXL3-TF",
      );
    });

    it("Phase 6 Step 6.3: global.web.read_page falls back to webExtractFallback on HTTP 403 or EMPTY_CONTENT", async () => {
      const recoveredBody = "Recovered full article body via stealth extractor. ".repeat(10);
      vi.spyOn(GlobalCapabilityExecutor, "safeFetchImpl").mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        url: "https://example.com/paywall",
        headers: new Headers(),
        text: "Forbidden",
      });
      const fallbackSpy = vi
        .spyOn(GlobalCapabilityExecutor, "webExtractFallback")
        .mockResolvedValue({
          url: "https://example.com/paywall",
          status: "ok",
          content: recoveredBody,
          charCount: recoveredBody.length,
          engineUsed: "crawl4ai",
        });

      const res403 = await GlobalCapabilityExecutor.execute("global.web.read_page", {
        url: "https://example.com/paywall",
      });

      expect(res403.success).toBe(true);
      expect((res403.result as any).fallback_used).toBe("web_extract");
      expect((res403.result as any).content).toContain("Recovered full article body");
      expect(fallbackSpy).toHaveBeenCalledWith("https://example.com/paywall", 8000);

      // Also test < 200 chars EMPTY_CONTENT fallback trigger
      vi.spyOn(GlobalCapabilityExecutor, "safeFetchImpl").mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://example.com/spa",
        headers: new Headers({ "content-type": "text/html" }),
        text: "<html><body><p>Enable JS</p></body></html>",
      });

      const resShort = await GlobalCapabilityExecutor.execute("global.web.read_page", {
        url: "https://example.com/spa",
      });
      expect(resShort.success).toBe(true);
      expect((resShort.result as any).fallback_used).toBe("web_extract");
    });

    it("Option B: AgentRouteAdapter routes onto CoreLoop by default and honors LAS_AGENT_LOOP=legacy rollback switch", async () => {
      expect(shouldUseCoreLoopForAgent({})).toBe(true);
      expect(shouldUseCoreLoopForAgent({ LAS_AGENT_LOOP: "coreloop" })).toBe(true);
      expect(shouldUseCoreLoopForAgent({ LAS_AGENT_LOOP: "legacy" })).toBe(false);

      const emitted: Array<{ type: string; [key: string]: unknown }> = [];
      const afterResponseHook = vi.fn();

      const coreOut = await runCoreLoopForAgent({
        project: "vllm-trading-bot",
        options: { maxIterations: 4 },
        messages: [{ role: "user", content: "Hello adapter" }],
        provider: {
          async *generateTextStream() {
            yield { type: "thinking", content: "Adapter thinking" };
            yield "Answered via CoreLoop AgentRouteAdapter.";
          },
        },
        resolvedModel: "local-dspark/GLM-5.3-Flash-EXL3-TF",
        signal: defaultSignal,
        runtimeTools: { finalTools: [] },
        emit: (ev) => emitted.push(ev),
        afterResponseHook,
      });

      expect(coreOut.result.status).toBe("completed");
      expect(coreOut.result.text).toBe("Answered via CoreLoop AgentRouteAdapter.");
      expect(coreOut.learningSkipped).toBe(true);
      expect(afterResponseHook).not.toHaveBeenCalled(); // B4 enforced!

      // Verify rollback switch dispatches legacy handler when LAS_AGENT_LOOP=legacy
      const dispatchedLegacy = await dispatchAgentRouteWithRollback({
        env: { LAS_AGENT_LOOP: "legacy" },
        runCoreLoopPath: async () => "coreloop-path",
        runLegacyPath: async () => "legacy-path",
      });
      expect(dispatchedLegacy).toEqual({ pathUsed: "legacy", value: "legacy-path" });

      const dispatchedCore = await dispatchAgentRouteWithRollback({
        env: { LAS_AGENT_LOOP: "coreloop" },
        runCoreLoopPath: async () => "coreloop-path",
        runLegacyPath: async () => "legacy-path",
      });
      expect(dispatchedCore).toEqual({ pathUsed: "coreloop", value: "coreloop-path" });
    });

    it("L1: CoreLoop path accumulates usage across model calls, emits usage_update SSE events, and returns cumulative totals", async () => {
      const emitted: Array<{ type: string; [key: string]: unknown }> = [];
      let providerCallCount = 0;
      const screenerTool = {
        name: "screener",
        description: "screener tool",
        parameters: { type: "object", properties: {}, required: [] },
      };

      const coreOut = await runCoreLoopForAgent({
        project: "vllm-trading-bot",
        options: { maxIterations: 4 },
        messages: [{ role: "user", content: "Screen stocks" }],
        provider: {
          async *generateTextStream() {
            if (providerCallCount === 0) {
              providerCallCount += 1;
              yield { type: "usage", usage: { inputTokens: 5, outputTokens: 7 } };
              yield {
                type: "toolCall",
                id: "call_1",
                name: "screener",
                args: {},
              };
            } else {
              yield { type: "usage", usage: { inputTokens: 11, outputTokens: 13 } };
              yield "Final answer.";
            }
          },
        },
        resolvedModel: "local-dspark/GLM-5.3-Flash-EXL3-TF",
        signal: defaultSignal,
        runtimeTools: {
          finalTools: [screenerTool],
        },
        runtimeToolExecutor: async () => "screened",
        emit: (ev) => emitted.push(ev),
      });

      expect(coreOut.result.status).toBe("completed");
      expect(coreOut.result.modelCalls).toBe(2);
      expect(coreOut.usage).toMatchObject({
        inputTokens: 16,
        outputTokens: 20,
        requests: 2,
      });
      const usageUpdates = emitted.filter((ev) => ev.type === "usage_update");
      expect(usageUpdates).toHaveLength(2);
      expect(usageUpdates[0]).toMatchObject({
        usage: expect.objectContaining({ inputTokens: 5, outputTokens: 7, requests: 1 }),
      });
      expect(usageUpdates[1]).toMatchObject({
        usage: expect.objectContaining({ inputTokens: 16, outputTokens: 20, requests: 2 }),
      });
    });

    it("H7 (Final Text): substituteToolOutputTokens replaces {{tool_output:...}} tokens in final assistant text of runCoreLoop", async () => {
      const fetchQuoteTool: CoreTool = {
        name: "fetch_quote",
        description: "Fetch quote",
        parameters: { type: "object", properties: { symbol: { type: "string" } } },
        execute: async () => ({ symbol: "NVDA", price: 142.75 }),
      };

      const model = scriptedModel([
        [{ type: "toolCall", id: "call_q1", name: "fetch_quote", args: { symbol: "NVDA" } }],
        ["Latest NVDA price is ${{tool_output:fetch_quote.price}} (call id {{tool_output:call_q1.symbol}})."],
      ]);

      const { result } = await runLoop(
        baseOptions({
          model,
          tools: [fetchQuoteTool],
          messages: [{ role: "user", content: "What is NVDA price?" }],
        }),
      );

      expect(result.status).toBe("completed");
      expect(result.text).toBe("Latest NVDA price is $142.75 (call id NVDA).");
      expect(
        substituteToolOutputTokens("Direct check: {{tool_output:fetch_quote.price}}", result.messages),
      ).toBe("Direct check: 142.75");
    });

    it("H10b: beforeFinish in-loop stop gate rejects premature completion, injects retryPrompt, and accepts once required tool is called", async () => {
      const verifyTool: CoreTool = {
        name: "verify_order",
        description: "Verify order",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ verified: true }),
      };

      const model = scriptedModel([
        // Turn 1: model tries to finish prematurely without calling verify_order
        ["Order looks fine, done!"],
        // Turn 2: after beforeFinish rejection + retryPrompt, model calls verify_order
        [{ type: "toolCall", id: "tc_v1", name: "verify_order", args: {} }],
        // Turn 3: model finishes after calling verify_order
        ["Order verified and completed."],
      ]);

      const gateAttempts: number[] = [];
      const { result, events } = await runLoop(
        baseOptions({
          model,
          tools: [verifyTool],
          messages: [{ role: "user", content: "Process and verify order" }],
          maxStopGateRetries: 2,
          beforeFinish: async ({ toolsCalled, attempt }) => {
            gateAttempts.push(attempt);
            if (!toolsCalled.has("verify_order")) {
              return {
                ok: false,
                retryPrompt: "STOP_GATE: You must call verify_order before finishing.",
              };
            }
            return { ok: true };
          },
        }),
      );

      expect(result.status).toBe("completed");
      expect(result.text).toBe("Order verified and completed.");
      expect(gateAttempts).toEqual([1, 2]);
      expect(events.some((e) => e.type === "warning" && e.code === "STOP_GATE_REJECTED")).toBe(true);
      expect(
        model.calls[1].messages.some(
          (m) => m.role === "user" && m.content.includes("STOP_GATE: You must call verify_order"),
        ),
      ).toBe(true);
    });

    it("Option B (End-to-End AgenticLoopService): routes vllm-trading-bot to runCoreLoopForAgent by default and falls back to harness.run() when LAS_AGENT_LOOP=legacy", async () => {
      const prevEnv = process.env.LAS_AGENT_LOOP;
      delete process.env.LAS_AGENT_LOOP;

      try {
        const emittedEvents: Array<Record<string, unknown>> = [];
        const baseContext = () => ({
          options: {
            harness: "standard",
            topology: "single-agent",
            thoughtStructure: "chain-of-thought",
            enableCriticGate: false,
            maxIterations: 3,
          } as any,
          agent: "macro_specialist",
          project: "vllm-trading-bot",
          username: "trader",
          modelDefinition: null,
          messages: [{ role: "user", content: "Run trading check" }] as any,
          agentConversationId: "conv_trading_e2e_1",
          conversationId: "conv_trading_e2e_1",
          provider: {
            async *generateTextStream() {
              yield "Trading response from CoreLoop.";
            },
          } as any,
          providerName: "vllm",
          resolvedModel: "local-dspark/GLM-5.3-Flash-EXL3-TF",
          signal: defaultSignal,
          emit: (ev: Record<string, unknown>) => emittedEvents.push(ev),
          runtimeTools: {
            finalTools: [],
            toolServiceMaps: { toolMap: new Map(), serverToolMap: new Map() },
            resolvedEnabledTools: [],
          } as any,
        });

        // 1. Default for vllm-trading-bot -> dispatches through CoreLoop
        const resCore = await AgenticLoopService.runAgenticLoop(baseContext() as any);
        const lastMsg = resCore.messages[resCore.messages.length - 1];
        expect(lastMsg?.role).toBe("assistant");
        expect(lastMsg?.content).toBe("Trading response from CoreLoop.");
        expect(emittedEvents.some((e) => e.type === "done")).toBe(true);

        // 2. Rollback via LAS_AGENT_LOOP=legacy -> dispatches through harness.run()
        process.env.LAS_AGENT_LOOP = "legacy";
        const { default: HarnessRegistry } = await import(
          "../../../services/harnesses/HarnessRegistry.ts"
        );
        const StandardClass = HarnessRegistry.get("standard")!;
        const harnessRunSpy = vi
          .spyOn(StandardClass.prototype, "run")
          .mockResolvedValueOnce({
            messages: [
              { role: "user", content: "Run trading check" },
              { role: "assistant", content: "Legacy harness response." },
            ] as any,
          });

        const resLegacy = await AgenticLoopService.runAgenticLoop(baseContext() as any);
        expect(harnessRunSpy).toHaveBeenCalledTimes(1);
        expect(resLegacy.messages[resLegacy.messages.length - 1]?.content).toBe(
          "Legacy harness response.",
        );
      } finally {
        if (prevEnv === undefined) delete process.env.LAS_AGENT_LOOP;
        else process.env.LAS_AGENT_LOOP = prevEnv;
      }
    });

    it("Dependency-Chain Regression (cycle-v3-1792361754): forwards thinkingEnabled:false on every turn and preserves TradingLearningBoundary user brief hash across empty-reply nudges, compaction, and finalPass", async () => {
      // 1. Verify estimateSingleMessageChars does not double-count identical thinking + reasoning_content
      const thinkingStr = "T".repeat(32_000);
      const singleCount = estimateSingleMessageChars({
        role: "assistant",
        content: "ok",
        thinking: thinkingStr,
        reasoning_content: thinkingStr,
      });
      expect(singleCount).toBe(2 + 32_000 + 16);

      // 2. Stamp a realistic 24KB trading brief via prepareTradingRequest (TradingLearningBoundary)
      const originalBrief =
        "## Cycle: cycle-v3-test\n## Ticker: AXP\n## Trace Parent: 0123456789abcdef\n" +
        "Evidence line for AXP quant analysis.\n".repeat(600);
      const stamped = prepareTradingRequest({
        project: "vllm-trading-bot",
        provider: "vllm",
        agent: "CUSTOM_V3_QUANT_ANALYST",
        conversationId: "conv_axp_quant",
        systemPrompt: "You are the V3 Quant Analyst.",
        messages: [{ role: "user", content: originalBrief }],
      });

      const recordedProviderOptions: Array<Record<string, unknown>> = [];
      const recordedReceipts: Array<Record<string, unknown> | null> = [];
      let turnIndex = 0;

      // 3. Wire runCoreLoopForAgent through the exact vllm.ts message preparation + filterTradingPayload boundary
      const coreOut = await runCoreLoopForAgent({
        project: "vllm-trading-bot",
        agent: "CUSTOM_V3_QUANT_ANALYST",
        conversationId: "conv_axp_quant",
        options: {
          systemPrompt: stamped.systemPrompt,
          thinkingEnabled: false,
          temperature: 0.2,
          topP: 0.9,
          topK: 40,
          minP: 0.05,
          repeatPenalty: 1.05,
          maxIterations: 4,
          compactionBudgetTokens: 7000, // Tight budget to force mid-run compaction if bloated
        },
        messages: stamped.messages,
        provider: {
          async *generateTextStream(msgs, model, opts) {
            recordedProviderOptions.push({ ...opts });

            // Replicate vllm.ts lines 189-231 -> VllmShimService.ts:845 filterTradingPayload
            const rewritten = rewriteNonLeadingSystemMessages(
              prependIdentitySystemMessage(msgs as any, opts.systemPrompt as string),
              model,
            );
            const compatMsgs = await prepareOpenAICompatMessages(rewritten as any);
            const vllmPayload: Record<string, unknown> = {
              model,
              messages: compatMsgs,
              ...(opts.thinkingEnabled !== undefined
                ? {
                    enable_thinking: opts.thinkingEnabled,
                    chat_template_kwargs: { enable_thinking: opts.thinkingEnabled },
                  }
                : {}),
            };

            // Must NOT throw "Trading task delivery failed: original user brief is missing or changed"
            const filtered = filterTradingPayload(vllmPayload);
            recordedReceipts.push(filtered.receipt);

            turnIndex += 1;
            if (turnIndex <= 2) {
              // Simulate a model that emitted 32KB of thinking and 0 chars of text (finish_reason=length)
              yield { type: "thinking", content: "R".repeat(32_000) };
              return;
            }
            // Turn 3 (finalPass): emit valid JSON artifact
            yield '{"thesis_direction":"BULLISH","signal_strength":0.72}';
          },
        },
        resolvedModel: "local-dspark/GLM-5.3-Flash-EXL3-TF",
        signal: defaultSignal,
        runtimeTools: { finalTools: [] },
        emit: () => {},
      });

      expect(coreOut.result.status).toBe("completed");
      expect(coreOut.result.text).toBe('{"thesis_direction":"BULLISH","signal_strength":0.72}');
      expect(recordedProviderOptions).toHaveLength(3);

      // Every single turn (Turn 1, Turn 2 retry, Turn 3 finalPass) MUST have thinkingEnabled: false
      for (const opts of recordedProviderOptions) {
        expect(opts.thinkingEnabled).toBe(false);
        expect(opts.temperature).toBe(0.2);
        expect(opts.topP).toBe(0.9);
        expect(opts.topK).toBe(40);
        expect(opts.minP).toBe(0.05);
        expect(opts.repeatPenalty).toBe(1.05);
      }

      // Every single turn MUST pass TradingLearningBoundary with exact task_delivery
      for (const receipt of recordedReceipts) {
        expect(receipt).not.toBeNull();
        expect(receipt?.task_delivery).toBe("exact");
      }

      // Also verify direct compaction + protectInitialUserBriefFromMerge when middle tool turns are evicted
      const compactedWithFinalPass = compactMessages(
        [
          { role: "system", content: stamped.systemPrompt },
          { role: "user", content: originalBrief },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc1", name: "t", args: {} }],
          },
          { role: "tool", tool_call_id: "tc1", name: "t", content: "X".repeat(40_000) },
          { role: "user", content: "Final pass instruction" },
        ],
        { budgetTokens: 7000, keepRecentGroups: 1 },
      );
      const guarded = protectInitialUserBriefFromMerge(compactedWithFinalPass as any);
      const checkPayload = filterTradingPayload({
        model: "local-dspark/GLM-5.3-Flash-EXL3-TF",
        messages: guarded,
      });
      expect(checkPayload.receipt?.task_delivery).toBe("exact");
    });
  });
});
