import {
  ChatState,
  ChatMessage,
  ToolActivityState,
  WorkerActivityState,
} from './types.js';

export interface ActivityRow {
  id: string;
  type: 'tool' | 'worker';
  name: string;
  label: string;
  status: 'invoked' | 'executing' | 'running' | 'completed' | 'failed' | 'dispatched';
  isPending: boolean;
  durationMs?: number;
  outputSummary?: string;
  error?: string;
}

export interface RenderableMessage {
  id: string;
  role: ChatMessage['role'];
  content: string;
  timestamp: string;
  status: ChatMessage['status'];
  tools: ToolActivityState[];
  workers: WorkerActivityState[];
  evidenceCount: number;
  hasReceipt: boolean;
  errorSummary?: string;
}

export interface PresentationSnapshot {
  messages: RenderableMessage[];
  activeActivities: ActivityRow[];
  isThinking: boolean;
  canSend: boolean;
  canCancel: boolean;
  statusBanner: {
    text: string;
    type: 'info' | 'warning' | 'error' | 'success';
  } | null;
  usageSummary?: {
    totalTokens: number | null;
    durationMs: number | null;
  };
}

/**
 * Transforms raw ChatState into a framework-neutral PresentationSnapshot
 * ready to be rendered by React, Vue, Svelte, or Vanilla HTML/CSS UIs.
 */
export function toPresentationSnapshot(state: ChatState): PresentationSnapshot {
  const messages: RenderableMessage[] = state.transcript.map((msg) => {
    const tools: ToolActivityState[] = (msg.toolCallIds || [])
      .map((tid) => state.toolActivities[tid])
      .filter((t): t is ToolActivityState => t !== undefined);

    const workers: WorkerActivityState[] = (msg.workerIds || [])
      .map((wid) => state.workerActivities[wid])
      .filter((w): w is WorkerActivityState => w !== undefined);

    const evidenceCount =
      msg.receipt?.evidence_records?.length ??
      0;

    return {
      id: msg.id,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      status: msg.status,
      tools,
      workers,
      evidenceCount,
      hasReceipt: !!msg.receipt,
      errorSummary: msg.error?.message,
    };
  });

  const activeActivities: ActivityRow[] = [];

  // Map active tool activities
  for (const tool of Object.values(state.toolActivities)) {
    if (tool.status === 'invoked' || tool.status === 'executing') {
      activeActivities.push({
        id: tool.toolId,
        type: 'tool',
        name: tool.toolName,
        label: `Running tool: ${tool.toolName}`,
        status: tool.status,
        isPending: true,
        durationMs: tool.durationMs,
      });
    }
  }

  // Map active worker activities
  for (const worker of Object.values(state.workerActivities)) {
    if (worker.status === 'dispatched' || worker.status === 'running') {
      activeActivities.push({
        id: worker.workerId,
        type: 'worker',
        name: worker.stage,
        label: `Worker stage: ${worker.stage}`,
        status: worker.status,
        isPending: true,
      });
    }
  }

  if (!state.pendingRun) activeActivities.length = 0;

  const isThinking =
    state.connectionStatus === 'connecting' ||
    (state.connectionStatus === 'streaming' && !!state.pendingRun) ||
    activeActivities.length > 0;

  const canSend = !state.pendingRun && !isThinking && state.connectionStatus !== 'reconnecting';
  const canCancel = isThinking && !!state.pendingRun && !state.cancellationRequested;

  let statusBanner: PresentationSnapshot['statusBanner'] = null;
  if (state.error) {
    statusBanner = {
      text: `${state.error.code}: ${state.error.message}`,
      type: 'error',
    };
  } else if (state.cancellationRequested) {
    statusBanner = { text: 'Cancellation requested...', type: 'info' };
  } else if (Object.keys(state.approvals).length) {
    statusBanner = { text: 'Approval required', type: 'warning' };
  } else if (state.transcript.some(m => m.status === 'incomplete')) {
    statusBanner = { text: 'Response incomplete', type: 'warning' };
  } else if (state.connectionStatus === 'reconnecting') {
    statusBanner = {
      text: 'Reconnecting to agent stream...',
      type: 'warning',
    };
  } else if (isThinking) {
    statusBanner = {
      text: activeActivities.length > 0
        ? activeActivities[0].label
        : 'Agent is thinking...',
      type: 'info',
    };
  }

  let usageSummary: PresentationSnapshot['usageSummary'] = undefined;
  if (state.terminalReceipt?.usage) {
    usageSummary = {
      totalTokens: state.terminalReceipt.usage.total_tokens ?? null,
      durationMs: state.terminalReceipt.usage.duration_ms ?? null,
    };
  }

  return {
    messages,
    activeActivities,
    isThinking,
    canSend,
    canCancel,
    statusBanner,
    usageSummary,
  };
}
