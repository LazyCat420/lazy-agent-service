import AgentHooks, { type HookHandler } from "../../AgentHooks.ts";
import SystemPromptAssembler from "../../system-prompt/index.ts";
import MemoryExtractor from "../../MemoryExtractor.ts";
import ConversationEmbeddingService from "../../ConversationEmbeddingService.ts";
import WorkflowMemoryService from "../../WorkflowMemoryService.ts";
import CriticGate from "./CriticGate.ts";

/**
 * HookInitializer — standardized lifecycle hook wiring for agentic harnesses.
 *
 * Every harness needs the same baseline hooks:
 *   - beforePrompt  → SystemPromptAssembler (builds the system message)
 *   - beforeToolCall → CriticGate (optional decide hook; tool authorization
 *                      itself is ToolAuthorization.decideToolCall, applied by
 *                      ApprovalGate.authorizeToolCalls)
 *   - afterResponse  → MemoryExtractor (extracts memories from conversation)
 *   - afterResponse  → ConversationEmbeddingService (embeds conversation for cross-session search)
 *
 * This module creates and wires them in a single call so harnesses
 * don't duplicate the registration boilerplate.
 */

interface HookInitOptions {
  workspaceRoot?: string;
  /** Enable CriticGate multi-model review of dangerous tool calls. */
  enableCriticGate?: boolean;
  /** Model to use for CriticGate reviews. */
  criticModel?: string;
}

/** Create a fully wired AgentHooks instance with standard lifecycle hooks. */
export function createStandardHooks({
  workspaceRoot,
  enableCriticGate = false,
  criticModel,
}: HookInitOptions = {}) {
  const hooks = new AgentHooks();

  // CriticGate: a 'decide' hook; its deny is honored by decideToolCall
  // (hook deny ranks after allow-list and DENY policies, before asks).
  if (enableCriticGate) {
    const criticGate = new CriticGate({ model: criticModel });
    hooks.register(
      "beforeToolCall",
      criticGate.createHook() as HookHandler,
      "CriticGate",
      "decide",
    );
  }

  const assembler = new SystemPromptAssembler({
    workspaceRoot: workspaceRoot || undefined,
  });
  hooks.register(
    "beforePrompt",
    assembler.createHook() as HookHandler,
    "SystemPromptAssembler",
    "transform",
  );

  hooks.register(
    "afterResponse",
    MemoryExtractor.createHook() as HookHandler,
    "MemoryExtractor",
    "inspect",
  );

  hooks.register(
    "afterResponse",
    ConversationEmbeddingService.createHook() as HookHandler,
    "ConversationEmbedding",
    "inspect",
  );

  hooks.register(
    "afterResponse",
    WorkflowMemoryService.createHook() as HookHandler,
    "WorkflowMemory",
    "inspect",
  );

  return { hooks, assembler };
}
