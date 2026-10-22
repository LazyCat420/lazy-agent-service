// ─── Sub-Agent Telemetry Emitter ─────────────────────────────
// Encapsulates all sub-agent SSE telemetry: burst token counting,
// phase transitions, HWM aggregate progress, and event routing.
// Extracted from OrchestratorService._runSubAgentLoop()

import ConversationGenerationTracker from "../ConversationGenerationTracker.ts";
import { estimateTokens } from "./SubAgentResultBuilder.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import type { EmitFunction, ToolCall } from "../harnesses/types.ts";

interface SubAgentTelemetryConfig {
  subAgentId: string;
  subAgentDescription: string;
  parentEmit: EmitFunction | null | undefined;
  parentConversationId: string | null | undefined;
  recursionDepth?: number;
}

function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string";
}

function isUsageRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Object.values(candidate).every((value) => typeof value === "number");
}

/**
 * Manages per-sub-agent SSE telemetry for the Orchestrator.
 *
 * Tracks burst-scoped token counters, phase transitions
 * (thinking ↔ generating), high-water-mark aggregate progress,
 * and forwards namespaced events to the parent SSE stream.
 */
export class SubAgentTelemetryEmitter {
  private subAgentId: string;
  private subAgentDescription: string;
  private parentEmit: EmitFunction | null | undefined;
  private parentConversationId: string | null | undefined;
  private recursionDepth: number;

  // Timing
  private firstChunkTime: number | null = null;
  private lastChunkTime: number | null = null;

  // Cumulative counters (across all bursts)
  private cumulativeOutputCharacters = 0;

  // Burst-scoped counters (reset on phase transitions and tool breaks)
  private burstOutputCharacters = 0;
  private burstFirstChunkTime: number | null = null;
  private burstChunkCount = 0;

  // Phase tracking
  private lastPhase: string | null = null;

  // Aggregate session-level HWMs (prevent non-monotonic values)
  private highWaterMarkOutputTokens = 0;
  private highWaterMarkInputTokens = 0;
  private highWaterMarkTotalTokens = 0;

  // Emit on every chunk — LM Studio batches SSE deltas heavily under continuous batching
  private static readonly PROGRESS_INTERVAL = 1;

  // Public access for the parent to read accumulated output/tool state
  output = "";
  toolCalls: ToolCall[] = [];
  totalCost: number | null = null;
  usage: Record<string, number> | null = null;
  iterations: number | null = null;

  constructor(config: SubAgentTelemetryConfig) {
    this.subAgentId = config.subAgentId;
    this.subAgentDescription = config.subAgentDescription;
    this.parentEmit = config.parentEmit;
    this.parentConversationId = config.parentConversationId;
    this.recursionDepth = config.recursionDepth ?? 0;
  }

  /** Build the generation_progress payload for the frontend. */
  private buildProgress() {
    const burstTokens = estimateTokens(this.burstOutputCharacters);
    let subAgentTokensPerSecond: number | null = null;
    if (burstTokens > 1 && this.burstFirstChunkTime && this.lastChunkTime) {
      const elapsedSeconds =
        (this.lastChunkTime - this.burstFirstChunkTime) / 1000;
      if (elapsedSeconds > 0.1)
        subAgentTokensPerSecond = burstTokens / elapsedSeconds;
    }
    return {
      type: "sub_agent_status",
      subAgentId: this.subAgentId,
      message: "generation_progress",
      outputTokens: burstTokens,
      firstChunkTime: this.burstFirstChunkTime,
      lastChunkTime: this.lastChunkTime,
      tokPerSec: subAgentTokensPerSecond,
      totalOutputTokens: estimateTokens(this.cumulativeOutputCharacters),
    };
  }

  /** Emit aggregate session-level generation_progress from the tracker. */
  private emitAggregateProgress() {
    if (!this.parentEmit || !this.parentConversationId) return;
    const stats = ConversationGenerationTracker.getConversationStats(
      this.parentConversationId,
    );
    if (stats.totalOutputTokens > 0 || stats.activeRequests > 0) {
      this.highWaterMarkOutputTokens = Math.max(
        this.highWaterMarkOutputTokens,
        stats.totalOutputTokens,
      );
      this.highWaterMarkInputTokens = Math.max(
        this.highWaterMarkInputTokens,
        stats.totalInputTokens,
      );
      this.highWaterMarkTotalTokens = Math.max(
        this.highWaterMarkTotalTokens,
        stats.totalTokens,
      );
      this.parentEmit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.GENERATION_PROGRESS,
        tokPerSec: stats.tokPerSec,
        activeRequests: stats.activeRequests,
        outputTokens: this.highWaterMarkOutputTokens,
        inputTokens: this.highWaterMarkInputTokens,
        totalTokens: this.highWaterMarkTotalTokens,
        avgTtft: stats.avgTtft,
      });
    }
  }

  /** Flush the current burst progress (emits final reading + aggregate). */
  private flushBurstProgress() {
    if (this.parentEmit && this.burstOutputCharacters > 0) {
      this.parentEmit(this.buildProgress());
      this.emitAggregateProgress();
    }
  }

  /** Reset burst counters for a new generation/thinking phase. */
  private resetBurst() {
    this.burstOutputCharacters = 0;
    this.burstChunkCount = 0;
    this.burstFirstChunkTime = null;
  }

  /** Track character output for a chunk/thinking event. */
  private trackOutput(characters: number) {
    this.cumulativeOutputCharacters += characters;
    this.burstOutputCharacters += characters;
    this.burstChunkCount++;
    if (!this.firstChunkTime) this.firstChunkTime = Date.now();
    if (!this.burstFirstChunkTime) this.burstFirstChunkTime = Date.now();
    this.lastChunkTime = Date.now();
  }

  /** Should we emit progress for this chunk? */
  private shouldEmitProgress(): boolean {
    return (
      this.burstChunkCount === 1 ||
      this.burstChunkCount % SubAgentTelemetryEmitter.PROGRESS_INTERVAL === 0
    );
  }

  /**
   * The EmitFunction to pass to the agentic loop.
   * Routes sub-agent events to the parent SSE stream with telemetry.
   */
  createEmitFunction(): EmitFunction {
    return (event) => {
      if (event.type === "chunk") {
        const contentString =
          typeof event.content === "string" ? event.content : "";
        this.output += contentString;
        const chunkCharacters = contentString.length;

        // Reset burst counters on phase transition (thinking → generating)
        if (this.lastPhase === "thinking" && this.burstOutputCharacters > 0) {
          this.flushBurstProgress();
          this.resetBurst();
        }

        this.trackOutput(chunkCharacters);

        if (this.parentEmit && this.lastPhase !== "generating") {
          this.lastPhase = "generating";
          this.parentEmit({
            type: "sub_agent_status",
            subAgentId: this.subAgentId,
            message: "phase",
            phase: "generating",
          });
        }

        if (this.parentEmit && this.shouldEmitProgress()) {
          this.parentEmit(this.buildProgress());
          this.emitAggregateProgress();
        }
      } else if (event.type === "thinking") {
        const contentString =
          typeof event.content === "string" ? event.content : "";
        const thinkingCharacters = contentString.length;

        // Reset burst counters on phase transition (generating → thinking)
        if (this.lastPhase === "generating" && this.burstOutputCharacters > 0) {
          this.flushBurstProgress();
          this.resetBurst();
        }

        this.trackOutput(thinkingCharacters);

        if (this.parentEmit && this.lastPhase !== "thinking") {
          this.lastPhase = "thinking";
          this.parentEmit({
            type: "sub_agent_status",
            subAgentId: this.subAgentId,
            message: "phase",
            phase: "thinking",
          });
        }

        if (this.parentEmit && this.shouldEmitProgress()) {
          this.parentEmit(this.buildProgress());
          this.emitAggregateProgress();
        }
      } else if (event.type === "tool_execution") {
        if (event.status === "calling" && isToolCall(event.tool)) {
          this.toolCalls.push({
            id: event.tool.id ?? null,
            name: event.tool.name,
            args: event.tool.args,
          });
        }
        // Flush generation progress before tool execution pauses generation
        if (this.lastPhase === "generating") {
          this.flushBurstProgress();
        }
        this.resetBurst();
        this.lastPhase = null;

        if (this.parentEmit) {
          this.parentEmit({
            type: "sub_agent_tool_execution",
            subAgentId: this.subAgentId,
            subAgentDescription: this.subAgentDescription,
            tool: event.tool,
            status: event.status,
          });
        }
      } else if (event.type === "tool_output") {
        if (this.parentEmit) {
          this.parentEmit({
            type: "sub_agent_tool_output",
            subAgentId: this.subAgentId,
            toolCallId: event.toolCallId,
            name: event.name,
            event: event.event,
            data: event.data,
          });
        }
      } else if (event.type === "status") {
        this.handleStatusEvent(event);
      } else if (event.type === "done") {
        this.handleDoneEvent(event);
      } else if (event.type === "usage_update") {
        if (this.parentEmit) {
          this.parentEmit(event);
        }
      } else if (
        event.type === "sub_agent_status" ||
        event.type === "sub_agent_tool_execution" ||
        event.type === "sub_agent_tool_output"
      ) {
        // Recursive forwarding: when a depth-N sub-agent spawns depth-(N+1)
        // grandchildren, their telemetry emitters produce sub_agent_* events.
        // Forward them directly — they are already namespaced with the
        // grandchild's subAgentId and contain all needed metadata.
        if (this.parentEmit) {
          this.parentEmit(event);
        }
      }
    };
  }

  private handleStatusEvent(event: Record<string, unknown>) {
    if (
      this.parentEmit &&
      (event.message === "iteration_progress" ||
        event.message === "sub_agents_updated")
    ) {
      if (typeof event.iteration === "number")
        this.iterations = event.iteration;
      this.parentEmit({
        type: "sub_agent_status",
        subAgentId: this.subAgentId,
        message: typeof event.message === "string" ? event.message : "",
        iteration: event.iteration,
        maxIterations: event.maxIterations,
      });
    }
    if (this.parentEmit && event.message === "generation_started") {
      this.parentEmit({
        type: "sub_agent_status",
        subAgentId: this.subAgentId,
        message: "generation_started",
        timeToFirstToken: event.timeToFirstToken,
      });
    }
    if (this.parentEmit && typeof event.phase === "string") {
      this.lastPhase = event.phase;
      this.parentEmit({
        type: "sub_agent_status",
        subAgentId: this.subAgentId,
        message: "phase",
        phase: event.phase,
        label: typeof event.message === "string" ? event.message : undefined,
        ...(event.progress != null && { progress: event.progress }),
      });
    }
  }

  private handleDoneEvent(event: Record<string, unknown>) {
    // Capture cost and usage from finalizeTextGeneration
    this.totalCost =
      typeof event.estimatedCost === "number" ? event.estimatedCost : null;
    this.usage = isUsageRecord(event.usage) ? event.usage : null;

    if (this.parentEmit && isUsageRecord(event.usage)) {
      const finalTokPerSec =
        typeof event.tokensPerSec === "number" ? event.tokensPerSec : null;
      const estimatedOutput = estimateTokens(this.cumulativeOutputCharacters);
      const finalOutputTokens = event.usage.outputTokens || estimatedOutput;
      const burstTokens = estimateTokens(this.burstOutputCharacters);
      this.parentEmit({
        type: "sub_agent_status",
        subAgentId: this.subAgentId,
        message: "generation_progress",
        outputTokens: burstTokens || finalOutputTokens,
        firstChunkTime: this.burstFirstChunkTime || this.firstChunkTime,
        lastChunkTime: this.lastChunkTime || Date.now(),
        tokPerSec: finalTokPerSec,
        totalOutputTokens: finalOutputTokens,
      });
      this.emitAggregateProgress();
    }
  }

  /** Emit a completion event to the parent SSE stream. */
  emitCompletion(
    durationMs: number,
    usage: Record<string, number> | null,
    estimatedCost: number | null,
  ) {
    if (this.parentEmit) {
      this.parentEmit({
        type: "sub_agent_status",
        subAgentId: this.subAgentId,
        message: "complete",
        durationMs,
        toolCount: this.toolCalls.length,
        usage: usage || null,
        estimatedCost: estimatedCost || null,
      });
    }
  }
}
