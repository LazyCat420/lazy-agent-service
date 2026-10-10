/**
 * Transport layer between the prism turn stream (POST /agent, POST /chat —
 * see prism-client's types/protocol/events.ts, services/agentStream.ts and
 * utils/agentTurnPayload.ts, read-only reference) and the canonical reducer
 * in reducer.ts.
 *
 * Two responsibilities:
 *   - buildTurnPayload — the request body of a turn, byte-compatible with
 *     the wire contract (field names exactly as the service expects).
 *   - ingestTurnEvent — normalize one wire event into a canonical RunEvent
 *     and fold it through the reducer. Wire events that carry no canonical
 *     state (thinking, status, usage_update, …) are recognized no-ops;
 *     unknown `type`s are no-ops counted in state.unrecognizedEvents.
 *
 * ingestStreamClosed models the SSE ending without a terminal `done` /
 * `error` (StreamClosedError in agentStream.ts): the turn may still be
 * running server-side, so pendingRun is deliberately kept.
 */

import {
  ChatState,
  RunEvent,
  StructuredError,
} from './types.js';
import { reduceChatEvent } from './reducer.js';

// ─── Request payload ──────────────────────────────────────────────

/** Model/agent settings the turn runs with (mirrors ChatSettings in useChatModelSettings). */
export interface TurnSettings {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  thinkingBudget?: number;
  thinkingLevel?: string;
  functionCallingEnabled?: boolean;
  webSearchEnabled?: boolean;
  codeExecutionEnabled?: boolean;
  urlContextEnabled?: boolean;
  agents?: {
    harness?: string;
    topology?: Record<string, unknown>;
    thoughtStructure?: string;
    workspaceEnabled?: boolean;
    locale?: string;
  };
}

export interface TurnPayloadInputs {
  /** True → raw /chat endpoint (no agentic loop); false → /agent. */
  isNoAgent: boolean;
  settings: TurnSettings;
  messages: Array<{ role: string; content: string }>;
  /** Turned off by the user, plus locked off (a settings model or the workspace missing). */
  disabledTools: string[];
  conversationId: string;
  traceId: string | null;
  agentId: string;
  agentProject: string | undefined;
  activeRuleNames: string[];
  permissionMode: string;
  planFirst: boolean;
  maxIterations: number;
  maxSubAgentIterations: number;
  maxRecursionDepth: number;
}

export function buildTurnPayload({
  isNoAgent,
  settings,
  messages,
  disabledTools,
  conversationId,
  traceId,
  agentId,
  agentProject,
  activeRuleNames,
  permissionMode,
  planFirst,
  maxIterations,
  maxSubAgentIterations,
  maxRecursionDepth,
}: TurnPayloadInputs): { path: '/chat' | '/agent'; payload: Record<string, unknown> } {
  if (isNoAgent) {
    return {
      path: '/chat',
      payload: {
        provider: settings.provider ?? '',
        model: settings.model ?? '',
        messages: [
          ...(settings.systemPrompt
            ? [{ role: 'system', content: settings.systemPrompt }]
            : []),
          ...messages,
        ],
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
        ...(settings.thinkingEnabled !== undefined && { thinkingEnabled: settings.thinkingEnabled }),
        ...(settings.reasoningEffort && { reasoningEffort: settings.reasoningEffort }),
        ...(settings.thinkingBudget && { thinkingBudget: settings.thinkingBudget }),
        ...(settings.thinkingLevel && { thinkingLevel: settings.thinkingLevel }),
        functionCallingEnabled: settings.functionCallingEnabled ?? false,
        ...(settings.functionCallingEnabled && { disabledTools }),
        ...(settings.webSearchEnabled ? { webSearch: true } : {}),
        ...(settings.codeExecutionEnabled ? { codeExecution: true } : {}),
        ...(settings.urlContextEnabled ? { urlContext: true } : {}),
        conversationId,
        conversationMeta: { systemPrompt: settings.systemPrompt ?? null },
        traceId,
      },
    };
  }

  return {
    path: '/agent',
    payload: {
      provider: settings.provider ?? '',
      model: settings.model ?? '',
      messages,
      functionCallingEnabled: true,
      disabledTools,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      ...(settings.thinkingEnabled !== undefined && { thinkingEnabled: settings.thinkingEnabled }),
      ...(settings.reasoningEffort && { reasoningEffort: settings.reasoningEffort }),
      ...(settings.thinkingBudget && { thinkingBudget: settings.thinkingBudget }),
      ...(settings.thinkingLevel && { thinkingLevel: settings.thinkingLevel }),
      project: agentProject,
      conversationId,
      traceId,
      agent: agentId,
      ...(activeRuleNames.length > 0 && { activeRuleNames }),
      ...(settings.agents?.harness && { harness: settings.agents.harness }),
      topology: settings.agents?.topology ?? {},
      ...(settings.agents?.thoughtStructure && {
        thoughtStructure: settings.agents.thoughtStructure,
      }),
      permissionMode,
      planFirst,
      maxIterations: Number.isFinite(maxIterations) ? maxIterations : 0,
      maxSubAgentIterations: Number.isFinite(maxSubAgentIterations) ? maxSubAgentIterations : 0,
      maxRecursionDepth,
      ...(settings.agents?.workspaceEnabled === false && { workspaceEnabled: false }),
      ...(settings.agents?.locale && { locale: settings.agents.locale }),
    },
  };
}

// ─── Wire events ──────────────────────────────────────────────────

/** The minimal shape every member of prism's `TurnEvent` union shares. */
export interface WireTurnEvent {
  type: string;
  seq?: number;
  [field: string]: unknown;
}

/**
 * Wire event types with no canonical state mapping. They are recognized —
 * a client must ignore them — but do not touch the reducer.
 */
const NOOP_WIRE_TYPES: Record<string, true> = {
  subscribed: true,
  user_message: true,
  thinking: true,
  image: true,
  audio: true,
  executableCode: true,
  codeExecutionResult: true,
  webSearchResult: true,
  citations: true,
  refusal: true,
  tool_output: true,
  plan_proposal: true,
  user_question: true,
  turn_input: true,
  goal_update: true,
  todo_update: true,
  brief_update: true,
  usage_update: true,
  context_budget: true,
  task_notification: true,
  conversation_state_update: true,
  permission_mode: true,
  memory_consolidation_complete: true,
  status: true,
};

/** Fallback run id for events that carry no run identity of their own. */
function resolveRunId(state: ChatState, raw: WireTurnEvent): string {
  if (state.pendingRun) return state.pendingRun.runId;
  const conversationId = typeof raw.conversationId === 'string' ? raw.conversationId : undefined;
  const traceId = typeof raw.traceId === 'string' ? raw.traceId : undefined;
  return `run_${conversationId ?? traceId ?? 'turn'}`;
}

/** Stable-enough id for dedup when the wire event carries no `seq`. */
function hashWireEvent(raw: WireTurnEvent): string {
  const json = JSON.stringify(raw);
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function canonicalId(raw: WireTurnEvent): string {
  return `wire_${raw.seq ?? hashWireEvent(raw)}_${raw.type}`;
}

function wireTimestamp(raw: WireTurnEvent): string {
  return typeof raw.timestamp === 'number' ? new Date(raw.timestamp).toISOString() : new Date().toISOString();
}

/** The ExecutedTool object of tool_execution / sub_agent_tool_execution. */
function executedTool(raw: WireTurnEvent): Record<string, unknown> | undefined {
  const tool = raw.tool;
  return tool !== null && typeof tool === 'object' ? (tool as Record<string, unknown>) : undefined;
}

function toolCallId(tool: Record<string, unknown> | undefined, raw: WireTurnEvent): string {
  if (tool) {
    if (typeof tool.id === 'string' && tool.id) return tool.id;
    if (typeof tool.responsesItemId === 'string' && tool.responsesItemId) return tool.responsesItemId;
    if (typeof raw.responsesItemId === 'string' && raw.responsesItemId) return raw.responsesItemId;
  }
  const name = tool && typeof tool.name === 'string' ? tool.name : 'tool';
  return `tool_${name}_${raw.seq ?? hashWireEvent(raw)}`;
}

/**
 * Map one wire event to zero, one or two canonical RunEvents.
 * Returns [] for recognized no-ops; ingestTurnEvent counts unknown types.
 */
function toCanonicalEvents(state: ChatState, raw: WireTurnEvent): RunEvent[] {
  const runId = resolveRunId(state, raw);
  const id = canonicalId(raw);
  const mk = (
    type: RunEvent['type'],
    data: Record<string, unknown>,
    overrides: Partial<RunEvent> = {},
  ): RunEvent => ({
    id,
    run_id: runId,
    type,
    timestamp: wireTimestamp(raw),
    data,
    ...(raw.seq !== undefined ? { seq: raw.seq } : {}),
    ...overrides,
  });

  switch (raw.type) {
    case 'hello':
      // First event of every turn stream: anchor the run.
      return [mk('run.admitted', {})];
    case 'chunk':
      return [mk('message.delta', { delta: raw.content ?? '' })];
    case 'tool_execution':
    case 'sub_agent_tool_execution': {
      const tool = executedTool(raw);
      const status = raw.status;
      const callId = toolCallId(tool, raw);
      const prefix = raw.type === 'sub_agent_tool_execution' && typeof raw.subAgentId === 'string'
        ? `sub_${raw.subAgentId}:`
        : '';
      const toolData: Record<string, unknown> = {
        tool_call_id: `${prefix}${callId}`,
        tool_name: tool && typeof tool.name === 'string' ? tool.name : 'unknown_tool',
        arguments: (tool?.args as Record<string, unknown>) ?? {},
      };
      if (typeof raw.toolLabel === 'string') toolData.label = raw.toolLabel;

      if (status === 'done' || status === 'error') {
        const result = tool?.result;
        const failed = status === 'error' || (result !== null && typeof result === 'object' && 'error' in (result as object));
        const error = (result !== null && typeof result === 'object' && 'error' in (result as object))
          ? (result as Record<string, unknown>).error
          : undefined;
        // Recompute the startedAt so the reducer's duration math matches the
        // wire duration when the server did not stamp the done event.
        const durationMs = typeof tool?.durationMs === 'number'
          ? tool.durationMs
          : typeof tool?.durationMilliseconds === 'number'
            ? tool.durationMilliseconds
            : undefined;
        const startedAt = state.toolActivities[toolData.tool_call_id as string]?.startedAt;
        const timestamp =
          durationMs !== undefined && startedAt
            ? new Date(new Date(startedAt).getTime() + durationMs).toISOString()
            : wireTimestamp(raw);
        return [
          {
            ...mk(failed ? 'tool.failed' : 'tool.result', {
              ...toolData,
              result,
              ...(error !== undefined ? { error } : {}),
            }),
            timestamp,
          },
        ];
      }
      // streaming | calling
      return [mk('tool.called', toolData)];
    }
    case 'toolCall': {
      const name = typeof raw.name === 'string' ? raw.name : 'unknown_tool';
      const callId = typeof raw.id === 'string' && raw.id
        ? raw.id
        : typeof raw.responsesItemId === 'string' && raw.responsesItemId
          ? raw.responsesItemId
          : `tool_${name}_${raw.seq ?? hashWireEvent(raw)}`;
      const called = mk('tool.called', {
        tool_call_id: callId,
        tool_name: name,
        arguments: (raw.args as Record<string, unknown>) ?? {},
      });
      if (raw.result === undefined) return [called];
      const failed = raw.result !== null && typeof raw.result === 'object' && 'error' in (raw.result as object);
      return [
        called,
        mk(failed ? 'tool.failed' : 'tool.result', {
          tool_call_id: callId,
          tool_name: name,
          arguments: (raw.args as Record<string, unknown>) ?? {},
          result: raw.result,
        }),
      ];
    }
    case 'approval_required':
      return [mk('approval.required', { ...raw, id: raw.toolCallId })];
    case 'approval_decided':
      return [mk('approval.resolved', { ...raw, id: raw.toolCallId, decision: raw.decision })];
    case 'sub_agent_status': {
      const workerId = typeof raw.subAgentId === 'string' ? raw.subAgentId : 'sub_agent';
      const message = typeof raw.message === 'string' ? raw.message : '';
      if (message === 'complete' || message === 'failed') {
        return [
          mk('worker.completed', {
            worker_id: workerId,
            stage: typeof raw.description === 'string' ? raw.description : message,
            status: message === 'failed' ? 'failed' : 'completed',
            output: raw.usage,
            error: typeof raw.error === 'string' ? raw.error : undefined,
          }),
        ];
      }
      const stage = message === 'phase' && typeof raw.label === 'string' ? raw.label : message;
      return [
        mk('worker.dispatched', {
          worker_id: workerId,
          stage: typeof raw.description === 'string' ? raw.description : stage,
          progress: typeof raw.progress === 'number' ? raw.progress : 0,
        }),
      ];
    }
    case 'done': {
      const usage = (raw.usage ?? undefined) as Record<string, unknown> | undefined;
      return [
        mk('run.completed', {
          usage: usage
            ? {
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
                total_tokens: usage.totalTokens,
                duration_ms:
                  typeof raw.totalTime === 'number' ? Math.round(raw.totalTime * 1000) : undefined,
              }
            : undefined,
          estimated_cost: raw.estimatedCost,
          provider: raw.provider,
          model: raw.model,
          status: 'completed',
        }),
      ];
    }
    case 'error': {
      const error: StructuredError = {
        code: typeof raw.code === 'string' ? raw.code : 'internal',
        message: typeof raw.message === 'string' ? raw.message : 'Turn failed',
        retryable: raw.retryable === true,
        category: 'RUNTIME',
      };
      return [mk('run.failed', { error })];
    }
    default:
      return [];
  }
}

/**
 * Normalize one wire event and fold it through the reducer. Unknown wire
 * types are no-ops counted in `unrecognizedEvents`; recognized wire events
 * with no canonical mapping are silent no-ops.
 */
export function ingestTurnEvent(state: ChatState, raw: WireTurnEvent): ChatState {
  if (typeof raw?.type !== 'string') return state;
  if (NOOP_WIRE_TYPES[raw.type]) return state;

  const canonical = toCanonicalEvents(state, raw);
  if (canonical.length === 0) {
    // Not in the taxonomy and not mappable: count it and move on.
    return { ...state, unrecognizedEvents: state.unrecognizedEvents + 1 };
  }

  let next = state;
  for (const event of canonical) next = reduceChatEvent(next, event);
  return next;
}

/**
 * The SSE ended with no terminal `done` / `error` (StreamClosedError in
 * prism-client's agentStream.ts). The turn may still be running server-side,
 * so `pendingRun` is kept; the connection is marked errored with a retryable
 * STREAM_CLOSED error so the UI can offer a reconnect.
 */
export function ingestStreamClosed(state: ChatState): ChatState {
  if (!state.pendingRun) return { ...state, connectionStatus: 'disconnected' };
  return {
    ...state,
    connectionStatus: 'error',
    error: {
      code: 'STREAM_CLOSED',
      message: 'SSE network stream closed early (eof-without-done)',
      retryable: true,
      category: 'RUNTIME',
    },
  };
}
