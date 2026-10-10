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

export interface ActivityFeedEntry {
  id: string;
  /** Epoch ms the activity started. */
  at: number;
  kind: 'thinking' | 'tool' | 'worker' | 'status';
  label: string;
  detail?: string;
  state: 'active' | 'done' | 'failed';
  durationMs?: number;
}

export interface PresentationSnapshot {
  messages: RenderableMessage[];
  activeActivities: ActivityRow[];
  /** Chronological (oldest first) feed of everything that happened this turn. */
  activityFeed: ActivityFeedEntry[];
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

  const activityFeed = buildActivityFeed(state, isThinking, activeActivities);

  return {
    messages,
    activeActivities,
    activityFeed,
    isThinking,
    canSend,
    canCancel,
    statusBanner,
    usageSummary,
  };
}

/**
 * Chronological (oldest first) feed of turn activity: every tool and worker
 * with its final state, a thinking row while the agent is thinking with no
 * active work, and a status row when the connection errored.
 */
function buildActivityFeed(
  state: ChatState,
  isThinking: boolean,
  activeActivities: ActivityRow[],
): ActivityFeedEntry[] {
  const feed: ActivityFeedEntry[] = [];

  for (const tool of Object.values(state.toolActivities)) {
    const at = Date.parse(tool.startedAt) || 0;
    const active = tool.status === 'invoked' || tool.status === 'executing';
    feed.push({
      id: tool.toolId,
      at,
      kind: 'tool',
      label: active
        ? `Running tool: ${tool.toolName}`
        : tool.status === 'failed'
          ? `Tool ${tool.toolName} failed`
          : `Tool ${tool.toolName} completed`,
      detail: tool.label ?? tool.error ?? undefined,
      state: active ? 'active' : tool.status === 'failed' ? 'failed' : 'done',
      durationMs: tool.durationMs,
    });
  }

  for (const worker of Object.values(state.workerActivities)) {
    const at = Date.parse(worker.startedAt) || 0;
    const active = worker.status === 'dispatched' || worker.status === 'running';
    feed.push({
      id: worker.workerId,
      at,
      kind: 'worker',
      label: active ? `Worker stage: ${worker.stage}` : `Worker ${worker.stage} ${worker.status}`,
      detail: worker.error ?? undefined,
      state: active ? 'active' : worker.status === 'failed' ? 'failed' : 'done',
    });
  }

  const hasActiveWork = activeActivities.length > 0;
  if (isThinking && !hasActiveWork) {
    feed.push({
      id: 'thinking',
      at: state.pendingRun ? Date.parse(state.pendingRun.startedAt) || 0 : Date.now(),
      kind: 'thinking',
      label: 'Thinking',
      state: 'active',
    });
  }

  if (state.connectionStatus === 'error') {
    feed.push({
      id: 'connection-error',
      at: state.pendingRun ? Date.parse(state.pendingRun.startedAt) || 0 : Date.now(),
      kind: 'status',
      label: state.error ? `${state.error.code}: ${state.error.message}` : 'Connection error',
      state: 'failed',
    });
  }

  return feed.sort((a, b) => a.at - b.at);
}

// ─── Activity indicator renderer ──────────────────────────────────

export const THINKING_DOTS_CLASS = 'agent-chat-thinking-dots';

const ACTIVITY_INDICATOR_CLASS = 'agent-chat-activity-indicator';
const ACTIVITY_ROW_CLASS = 'agent-chat-activity-row';

/** CSS for the animated thinking dots (`. .. ...` stepping) and feed rows. */
export const THINKING_DOTS_CSS = `.${ACTIVITY_INDICATOR_CLASS} { display: flex; flex-direction: column; gap: 4px; }
.${ACTIVITY_ROW_CLASS} { display: flex; align-items: baseline; gap: 6px; font-size: 0.9em; }
.${ACTIVITY_ROW_CLASS}[data-state='failed'] { color: #b91c1c; }
.${ACTIVITY_ROW_CLASS}[data-state='done'] { opacity: 0.7; }
.${THINKING_DOTS_CLASS}::after {
  display: inline-block;
  width: 1.4em;
  text-align: left;
  content: '';
  animation: agentChatThinkingDots 1.2s steps(1, end) infinite;
}
@keyframes agentChatThinkingDots {
  0% { content: ''; }
  25% { content: '.'; }
  50% { content: '..'; }
  75% { content: '...'; }
  100% { content: ''; }
}`;

/**
 * Mount or update the activity indicator inside `el`: the animated thinking
 * dots while `snapshot.isThinking`, and the activity feed with the latest
 * entry first. Idempotent — successive snapshots update the same node.
 * Pure DOM, no dependencies.
 */
export function renderActivityIndicator(el: HTMLElement, snapshot: PresentationSnapshot): void {
  const doc = el.ownerDocument;
  if (!doc) {
    throw new TypeError('renderActivityIndicator requires an element with an ownerDocument');
  }

  let root: Element | undefined;
  for (const child of Array.from(el.children)) {
    if (child.className === ACTIVITY_INDICATOR_CLASS) {
      root = child;
      break;
    }
  }
  if (!root) {
    root = doc.createElement('div');
    root.className = ACTIVITY_INDICATOR_CLASS;
    el.appendChild(root);
  }

  const nodes: Element[] = [];
  if (snapshot.isThinking) {
    const dots = doc.createElement('span');
    dots.className = THINKING_DOTS_CLASS;
    dots.setAttribute('data-state', 'active');
    dots.textContent = 'Thinking';
    nodes.push(dots);
  }

  for (const entry of [...snapshot.activityFeed].reverse()) {
    const row = doc.createElement('div');
    row.className = ACTIVITY_ROW_CLASS;
    row.setAttribute('data-state', entry.state);
    const duration = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : '';
    row.textContent = `${entry.label}${duration}`;
    nodes.push(row);
  }

  root.replaceChildren(...nodes);
}
