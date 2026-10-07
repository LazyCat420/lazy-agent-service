import crypto from "node:crypto";
import { SubagentRegistry } from "./SubagentRegistry.ts";
import { getLastAssistantText } from "./orchestrator/SubAgentResultBuilder.ts";
import logger from "../utils/logger.ts";
import type AgenticLoopService from "./AgenticLoopService.ts";

/** The sub-agent loop entry point — OrchestratorService's exact call shape. */
export type AgenticLoopRunner = typeof AgenticLoopService.runAgenticLoop;

// ────────────────────────────────────────────────────────────
// DelegateTool — the `delegate` tool (PLAN_claude_code.md §3).
//
// The parent agent calls delegate({agent, task}); the named subagent
// runs its own agentic loop (same call shape as OrchestratorService's
// sub-agent spawn) with its own tool allowlist and model, and the
// subagent's final assistant text is returned as one observation —
// the parent context holds only the final report.
//
// Guards:
//  - unknown `agent` → structured error listing available agents;
//  - a subagent calling delegate (recursionDepth > 0) → refused:
//    "nested delegation is not allowed".
// ────────────────────────────────────────────────────────────

export interface DelegateArgs {
  agent: string;
  task: string;
}

/** Execution context threaded from the wiring site (OrchestratorService). */
export interface DelegateContext {
  /** Recursion depth of the calling loop — >0 means the caller is itself a subagent. */
  recursionDepth?: number;
  providerName?: string;
  resolvedModel?: string;
  project?: string;
  username?: string;
  workspaceRoot?: string;
  traceId?: string;
  agentConversationId?: string;
  conversationId?: string;
  emit?: (event: unknown) => void;
  /** Test seam: replaces AgenticLoopService.runAgenticLoop. */
  runner?: AgenticLoopRunner;
}

function buildMessages(task: string, systemPrompt: string) {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: task });
  return messages;
}

export const DelegateTool = {
  name: "delegate",

  schema: {
    name: "delegate",
    description:
      "Delegate a task to a named subagent. The subagent runs in its own context with its own tool allowlist and returns its final report as the result.",
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Subagent name (see the available subagents in your prompt).",
        },
        task: {
          type: "string",
          description: "Self-contained task for the subagent.",
        },
      },
      required: ["agent", "task"],
    },
  },

  /**
   * Run a subagent and return its final message text. Structured error
   * objects (with `error: true`) are returned for guard failures — never
   * thrown — so the parent loop sees them as tool observations.
   */
  async execute(args: Partial<DelegateArgs>, context: DelegateContext = {}): Promise<unknown> {
    const agent = typeof args?.agent === "string" ? args.agent.trim() : "";
    const task = typeof args?.task === "string" ? args.task : "";

    if (context.recursionDepth !== undefined && context.recursionDepth > 0) {
      return {
        error: true,
        message: "nested delegation is not allowed",
      };
    }

    if (!agent) {
      return {
        error: true,
        message: 'Missing required argument "agent".',
        availableAgents: SubagentRegistry.list().map((entry) => entry.name),
      };
    }

    const definition = SubagentRegistry.get(agent);
    if (!definition) {
      return {
        error: true,
        message: `Unknown subagent "${agent}".`,
        availableAgents: SubagentRegistry.list().map((entry) => entry.name),
      };
    }

    if (!task) {
      return {
        error: true,
        message: 'Missing required argument "task".',
      };
    }

    // Lazy load: AgenticLoopService initializes heavy module state (mongo,
    // provider registry) that must not load for guard-refusals; matches
    // OrchestratorService's lazy `import()` of the same module.
    const runAgenticLoop =
      context.runner ||
      ((await import("./AgenticLoopService.ts")).default.runAgenticLoop as AgenticLoopRunner);

    // Provider + model: prefer the calling loop's provider; the subagent's
    // `model:` frontmatter (resolved via config) overrides the model only.
    let providerInstance: unknown;
    let resolvedModel = context.resolvedModel || "default";
    let modelDefinition: unknown;
    if (!context.runner) {
      const { getProvider } = await import("../providers/index.ts");
      const { getModelByName } = await import("../config.ts");
      providerInstance = getProvider(context.providerName || "default");
      if (!providerInstance) {
        return {
          error: true,
          message: `Provider not found: ${context.providerName || "default"}`,
        };
      }
      if (definition.model) {
        resolvedModel = definition.model;
      }
      modelDefinition = getModelByName(resolvedModel);
    }

    const subAgentConversationId = crypto.randomUUID().replaceAll("-", "");
    try {
      const loopResult = (await runAgenticLoop({
        provider: providerInstance,
        providerName: context.providerName || "default",
        resolvedModel,
        modelDefinition,
        messages: buildMessages(task, definition.systemPrompt),
        options: {
          autoApprove: true,
          agenticLoopEnabled: true,
          isSubAgent: true,
          enabledTools: definition.tools === "all" ? undefined : [...definition.tools],
          maxTokens: 8192,
        },
        agentConversationId: subAgentConversationId,
        parentAgentConversationId: context.agentConversationId,
        conversationId: subAgentConversationId,
        parentConversationId: context.conversationId,
        traceId: context.traceId || crypto.randomUUID().replaceAll("-", ""),
        project: context.project,
        username: context.username,
        agent: definition.name,
        requestId: crypto.randomUUID(),
        requestStart: performance.now(),
        emit: context.emit || (() => {}),
        workspaceRoot: context.workspaceRoot,
      } as Parameters<AgenticLoopRunner>[0])) as { messages?: Array<{ role: string; content: unknown }> } | undefined;

      const finalText = getLastAssistantText(
        (loopResult?.messages || []) as Parameters<typeof getLastAssistantText>[0],
      );
      return finalText || "(subagent returned no final message)";
    } catch (error) {
      logger.warn(
        `[DelegateTool] Subagent ${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        error: true,
        message: `Subagent "${definition.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

export default DelegateTool;
