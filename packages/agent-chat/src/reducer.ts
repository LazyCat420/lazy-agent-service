import {
  ChatState,
  RunEvent,
  ChatMessage,
  ToolActivityState,
  WorkerActivityState,
  RunReceipt,
  StructuredError,
} from './types.js';

/**
 * Pure reducer function mapping canonical RunEvent objects to ChatState.
 * Guarantees immutability and monotonic sequence ordering.
 */
export function reduceChatEvent(state: ChatState, event: RunEvent): ChatState {
  if (state.pendingRun && event.run_id !== state.pendingRun.runId) return state;
  const seen = state.seenEventIds[event.run_id] || [];
  if (seen.includes(event.id) || state.sealedRuns[event.run_id]) return state;
  if (event.seq !== undefined && event.seq <= (state.runSequences[event.run_id] || 0)) return state;
  const terminal = ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type);
  state = {
    ...state,
    eventCursors: { ...state.eventCursors, [event.run_id]: event.id },
    seenEventIds: { ...state.seenEventIds, [event.run_id]: [...seen, event.id] },
    runSequences: { ...state.runSequences, [event.run_id]: event.seq ?? (state.runSequences[event.run_id] || 0) + 1 },
    sealedRuns: terminal ? { ...state.sealedRuns, [event.run_id]: true } : state.sealedRuns,
    cancellationRequested: terminal ? false : state.cancellationRequested,
    approvals: terminal ? {} : state.approvals,
  };
  return applyEvent(state, event);
}

function applyEvent(state: ChatState, event: RunEvent): ChatState {
  // Monotonic sequence cursor check
  const eventSeq = event.seq ?? state.eventSequenceCursor + 1;
  const nextSeq = Math.max(state.eventSequenceCursor, eventSeq);

  switch (event.type) {
    case 'run.admitted': {
      return {
        ...state,
        eventSequenceCursor: nextSeq,
        connectionStatus: 'connecting',
        pendingRun: {
          runId: event.run_id,
          profileId: event.data.profile_id,
          status: 'admitted',
          startedAt: event.timestamp,
        },
      };
    }

    case 'run.created':
    case 'run.started': {
      const runId = event.run_id;
      // Ensure an assistant message placeholder exists for streaming
      const existingMsgIndex = state.transcript.findIndex(
        (m) => m.runId === runId && m.role === 'assistant'
      );

      let nextTranscript = [...state.transcript];
      if (existingMsgIndex === -1) {
        const newAssistantMsg: ChatMessage = {
          id: `msg_asst_${runId}`,
          runId,
          role: 'assistant',
          content: '',
          timestamp: event.timestamp,
          status: 'streaming',
          toolCallIds: [],
          workerIds: [],
        };
        nextTranscript.push(newAssistantMsg);
      } else {
        nextTranscript[existingMsgIndex] = {
          ...nextTranscript[existingMsgIndex],
          status: 'streaming',
        };
      }

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        connectionStatus: 'streaming',
        transcript: nextTranscript,
        pendingRun: {
          runId,
          profileId: state.pendingRun?.profileId || event.data.profile_id,
          status: 'running',
          startedAt: state.pendingRun?.startedAt || event.timestamp,
        },
      };
    }

    case 'message.delta': {
      const delta =
        event.data.delta ?? event.data.text ?? event.data.content ?? '';
      const runId = event.run_id;

      const existingMsgIndex = state.transcript.findIndex(
        (m) => m.runId === runId && m.role === 'assistant'
      );

      let nextTranscript = [...state.transcript];
      if (existingMsgIndex >= 0) {
        const curMsg = nextTranscript[existingMsgIndex];
        nextTranscript[existingMsgIndex] = {
          ...curMsg,
          content: curMsg.content + delta,
          status: 'streaming',
        };
      } else {
        nextTranscript.push({
          id: `msg_asst_${runId}`,
          runId,
          role: 'assistant',
          content: delta,
          timestamp: event.timestamp,
          status: 'streaming',
          toolCallIds: [],
          workerIds: [],
        });
      }

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        connectionStatus: 'streaming',
        transcript: nextTranscript,
      };
    }

    case 'message.completed': {
      const finalContent =
        event.data.content ?? event.data.text ?? undefined;
      const runId = event.run_id;

      const nextTranscript = state.transcript.map((m) => {
        if (m.runId === runId && m.role === 'assistant') {
          return {
            ...m,
            content: finalContent !== undefined ? finalContent : m.content,
          };
        }
        return m;
      });

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        transcript: nextTranscript,
      };
    }

    case 'tool.called':
    case 'tool.invoked': {
      const toolId =
        event.data.tool_call_id || event.data.id || `tool_${event.id}`;
      const toolName =
        event.data.tool_name || event.data.name || event.data.tool || 'unknown_tool';
      const args = event.data.arguments || event.data.args || {};

      const newToolActivity: ToolActivityState = {
        toolId,
        toolName,
        args,
        status: 'executing',
        startedAt: event.timestamp,
      };

      const nextToolActivities = {
        ...state.toolActivities,
        [toolId]: newToolActivity,
      };

      // Associate tool call with the current assistant message
      const nextTranscript = state.transcript.map((m) => {
        if (m.runId === event.run_id && m.role === 'assistant') {
          const currentTools = m.toolCallIds || [];
          if (!currentTools.includes(toolId)) {
            return { ...m, toolCallIds: [...currentTools, toolId] };
          }
        }
        return m;
      });

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        toolActivities: nextToolActivities,
        transcript: nextTranscript,
      };
    }

    case 'tool.result':
    case 'tool.completed': {
      const toolId =
        event.data.tool_call_id || event.data.id || Object.keys(state.toolActivities).pop() || '';
      const existing = state.toolActivities[toolId];

      const durationMs = existing?.startedAt
        ? Math.max(0, new Date(event.timestamp).getTime() - new Date(existing.startedAt).getTime())
        : undefined;
      const nestedResult = event.data.result && typeof event.data.result === 'object'
        ? event.data.result
        : undefined;
      const resultFailed = event.data.is_error === true
        || nestedResult?.is_error === true
        || !!event.data.error
        || !!nestedResult?.error;
      const resultError = typeof event.data.error === 'string'
        ? event.data.error
        : event.data.error?.message
          || (typeof nestedResult?.error === 'string'
            ? nestedResult.error
            : nestedResult?.error?.message)
          || (resultFailed ? 'Tool execution failed' : undefined);

      const nextToolActivities = {
        ...state.toolActivities,
        [toolId]: {
          ...existing,
          toolId,
          toolName: existing?.toolName || event.data.tool_name || 'tool',
          args: existing?.args || {},
          status: resultFailed ? 'failed' as const : 'completed' as const,
          output: event.data.result ?? event.data.output,
          error: resultError,
          completedAt: event.timestamp,
          durationMs,
        },
      };

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        toolActivities: nextToolActivities,
      };
    }

    case 'tool.failed': {
      const toolId =
        event.data.tool_call_id || event.data.id || Object.keys(state.toolActivities).pop() || '';
      const existing = state.toolActivities[toolId];

      const durationMs = existing?.startedAt
        ? Math.max(0, new Date(event.timestamp).getTime() - new Date(existing.startedAt).getTime())
        : undefined;

      const nextToolActivities = {
        ...state.toolActivities,
        [toolId]: {
          ...existing,
          toolId,
          toolName: existing?.toolName || event.data.tool_name || 'tool',
          args: existing?.args || {},
          status: 'failed' as const,
          error: event.data.error || event.data.message || 'Tool execution failed',
          completedAt: event.timestamp,
          durationMs,
        },
      };

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        toolActivities: nextToolActivities,
      };
    }

    case 'worker.dispatched': {
      const workerId =
        event.data.worker_id || event.data.id || `worker_${event.id}`;
      const stage = event.data.stage || 'dispatch';

      const newWorkerActivity: WorkerActivityState = {
        workerId,
        stage,
        status: 'running',
        progress: event.data.progress ?? 0,
        startedAt: event.timestamp,
      };

      const nextWorkerActivities = {
        ...state.workerActivities,
        [workerId]: newWorkerActivity,
      };

      const nextTranscript = state.transcript.map((m) => {
        if (m.runId === event.run_id && m.role === 'assistant') {
          const currentWorkers = m.workerIds || [];
          if (!currentWorkers.includes(workerId)) {
            return { ...m, workerIds: [...currentWorkers, workerId] };
          }
        }
        return m;
      });

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        workerActivities: nextWorkerActivities,
        transcript: nextTranscript,
      };
    }

    case 'worker.completed': {
      const workerId =
        event.data.worker_id || event.data.id || Object.keys(state.workerActivities).pop() || '';
      const existing = state.workerActivities[workerId];

      const nextWorkerActivities = {
        ...state.workerActivities,
        [workerId]: {
          ...existing,
          workerId,
          stage: existing?.stage || event.data.stage || 'stage',
          status: (event.data.status === 'failed' ? 'failed' : 'completed') as 'completed' | 'failed',
          output: event.data.output ?? event.data.result,
          error: event.data.error,
          progress: 100,
          completedAt: event.timestamp,
        },
      };

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        workerActivities: nextWorkerActivities,
      };
    }

    case 'approval.required':
      return { ...state, eventSequenceCursor: nextSeq,
        approvals: { ...state.approvals, [event.data.id || event.id]: event.data },
        pendingRun: state.pendingRun ? { ...state.pendingRun, status: 'waiting_for_approval' } : null };
    case 'approval.resolved': {
      const approvals = { ...state.approvals };
      delete approvals[event.data.id || event.data.approval_id];
      return { ...state, approvals, eventSequenceCursor: nextSeq,
        pendingRun: state.pendingRun ? { ...state.pendingRun, status: 'running' } : null };
    }
    case 'run.completed': {
      const receipt: RunReceipt = {
        context_receipt: event.data.context_receipt,
        evidence_records: event.data.evidence_records || event.data.evidence,
        usage: event.data.usage,
      };

      const finalAssistant = Array.isArray(event.data.messages)
        ? [...event.data.messages].reverse().find(
            (m: any) => m?.role === 'assistant' && typeof m.content === 'string'
          )
        : undefined;
      const finalContent = finalAssistant?.content;
      const terminalStatus = (
        event.data.status !== undefined && event.data.status !== 'completed'
        || event.data.outcome === 'incomplete'
        || finalAssistant?.outcome === 'incomplete'
      ) ? 'incomplete' : 'completed';
      let foundAssistant = false;
      let nextTranscript = state.transcript.map((m) => {
        if (m.runId === event.run_id && m.role === 'assistant') {
          foundAssistant = true;
          return {
            ...m,
            status: terminalStatus as ChatMessage['status'],
            content: m.content || finalContent || '',
            receipt,
            evidence: receipt.evidence_records,
          };
        }
        return m;
      });
      if (!foundAssistant && finalContent) {
        nextTranscript = [...nextTranscript, {
          id: `msg_asst_${event.run_id}`,
          runId: event.run_id,
          role: 'assistant',
          content: finalContent,
          timestamp: event.timestamp,
          status: terminalStatus as ChatMessage['status'],
          toolCallIds: [],
          workerIds: [],
          receipt,
        }];
      }

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        connectionStatus: 'idle',
        pendingRun: null,
        terminalReceipt: receipt,
        transcript: nextTranscript,
      };
    }

    case 'run.failed': {
      const structuredError: StructuredError = {
        code: event.data.error?.code || 'RUN_FAILED',
        message:
          event.data.error?.message ||
          event.data.message ||
          'Run execution failed',
        retryable: !!event.data.error?.retryable,
        category: event.data.error?.category || 'RUNTIME',
        details: event.data.error?.details || event.data.details,
      };

      const nextTranscript = state.transcript.map((m) => {
        if (m.runId === event.run_id && m.role === 'assistant') {
          return {
            ...m,
            status: 'failed' as const,
            error: structuredError,
          };
        }
        return m;
      });

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        connectionStatus: 'error',
        pendingRun: null,
        error: structuredError,
        transcript: nextTranscript,
      };
    }

    case 'run.cancelled': {
      const nextTranscript = state.transcript.map((m) => {
        if (m.runId === event.run_id && m.role === 'assistant') {
          return {
            ...m,
            status: 'cancelled' as const,
          };
        }
        return m;
      });

      return {
        ...state,
        eventSequenceCursor: nextSeq,
        connectionStatus: 'idle',
        pendingRun: null,
        transcript: nextTranscript,
      };
    }

    default:
      return {
        ...state,
        unknownEvents: [...state.unknownEvents, event],
        eventSequenceCursor: nextSeq,
      };
  }
}
