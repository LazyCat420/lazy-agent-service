import { describe, it, expect } from 'vitest';
import {
  INITIAL_CHAT_STATE,
  RunEvent,
  reduceChatEvent,
  toPresentationSnapshot,
  ChatClientController,
} from '../src/index.js';

describe('Chat State Reducer & Presentation Suite', () => {
  const sampleRunId = 'run_abc123';
  const now = new Date().toISOString();

  it('handles canonical run admission and start lifecycle', () => {
    let state = INITIAL_CHAT_STATE;

    const admittedEvent: RunEvent = {
      id: 'evt_1',
      run_id: sampleRunId,
      type: 'run.admitted',
      timestamp: now,
      data: { profile_id: 'html_notes_canvas_v1' },
      seq: 1,
    };

    state = reduceChatEvent(state, admittedEvent);
    expect(state.connectionStatus).toBe('connecting');
    expect(state.pendingRun?.runId).toBe(sampleRunId);
    expect(state.pendingRun?.status).toBe('admitted');
    expect(state.eventSequenceCursor).toBe(1);

    const startedEvent: RunEvent = {
      id: 'evt_2',
      run_id: sampleRunId,
      type: 'run.started',
      timestamp: now,
      data: { profile_id: 'html_notes_canvas_v1' },
      seq: 2,
    };

    state = reduceChatEvent(state, startedEvent);
    expect(state.connectionStatus).toBe('streaming');
    expect(state.pendingRun?.status).toBe('running');
    expect(state.transcript.length).toBe(1);
    expect(state.transcript[0].role).toBe('assistant');
    expect(state.transcript[0].status).toBe('streaming');
  });

  it('accumulates message.delta tokens into assistant message content', () => {
    let state = INITIAL_CHAT_STATE;

    state = reduceChatEvent(state, {
      id: 'evt_1',
      run_id: sampleRunId,
      type: 'run.started',
      timestamp: now,
      data: {},
      seq: 1,
    });

    state = reduceChatEvent(state, {
      id: 'evt_2',
      run_id: sampleRunId,
      type: 'message.delta',
      timestamp: now,
      data: { delta: 'Here is your ' },
      seq: 2,
    });

    state = reduceChatEvent(state, {
      id: 'evt_3',
      run_id: sampleRunId,
      type: 'message.delta',
      timestamp: now,
      data: { delta: 'researched widget.' },
      seq: 3,
    });

    expect(state.transcript[0].content).toBe('Here is your researched widget.');
    expect(state.transcript[0].status).toBe('streaming');
  });

  it('tracks tool.invoked, execution, and tool.completed states', () => {
    let state = INITIAL_CHAT_STATE;

    state = reduceChatEvent(state, {
      id: 'evt_1',
      run_id: sampleRunId,
      type: 'run.started',
      timestamp: now,
      data: {},
      seq: 1,
    });

    state = reduceChatEvent(state, {
      id: 'evt_2',
      run_id: sampleRunId,
      type: 'tool.invoked',
      timestamp: now,
      data: {
        tool_call_id: 'call_canvas_1',
        tool_name: 'canvas_add_widget',
        arguments: { widget_type: 'data_card', widget_id: 'card-1' },
      },
      seq: 2,
    });

    expect(state.toolActivities['call_canvas_1']).toBeDefined();
    expect(state.toolActivities['call_canvas_1'].status).toBe('executing');
    expect(state.transcript[0].toolCallIds).toContain('call_canvas_1');

    state = reduceChatEvent(state, {
      id: 'evt_3',
      run_id: sampleRunId,
      type: 'tool.completed',
      timestamp: now,
      data: {
        tool_call_id: 'call_canvas_1',
        result: { status: 'ok', committed: true },
      },
      seq: 3,
    });

    expect(state.toolActivities['call_canvas_1'].status).toBe('completed');
    expect(state.toolActivities['call_canvas_1'].output).toEqual({
      status: 'ok',
      committed: true,
    });
  });

  it('tracks worker dispatch and completion', () => {
    let state = INITIAL_CHAT_STATE;

    state = reduceChatEvent(state, {
      id: 'evt_1',
      run_id: sampleRunId,
      type: 'run.started',
      timestamp: now,
      data: {},
      seq: 1,
    });

    state = reduceChatEvent(state, {
      id: 'evt_2',
      run_id: sampleRunId,
      type: 'worker.dispatched',
      timestamp: now,
      data: {
        worker_id: 'worker_news_01',
        stage: 'scraping_news',
        progress: 10,
      },
      seq: 2,
    });

    expect(state.workerActivities['worker_news_01']).toBeDefined();
    expect(state.workerActivities['worker_news_01'].status).toBe('running');
    expect(state.workerActivities['worker_news_01'].stage).toBe('scraping_news');

    state = reduceChatEvent(state, {
      id: 'evt_3',
      run_id: sampleRunId,
      type: 'worker.completed',
      timestamp: now,
      data: {
        worker_id: 'worker_news_01',
        output: { headlines: 5 },
      },
      seq: 3,
    });

    expect(state.workerActivities['worker_news_01'].status).toBe('completed');
    expect(state.workerActivities['worker_news_01'].progress).toBe(100);
  });

  it('finalizes run.completed with receipts and evidence records', () => {
    let state = INITIAL_CHAT_STATE;

    state = reduceChatEvent(state, {
      id: 'evt_1',
      run_id: sampleRunId,
      type: 'run.started',
      timestamp: now,
      data: {},
      seq: 1,
    });

    state = reduceChatEvent(state, {
      id: 'evt_2',
      run_id: sampleRunId,
      type: 'run.completed',
      timestamp: now,
      data: {
        context_receipt: { checkpoint: 'v1' },
        evidence_records: [{ evidence_id: 'ev_1', score: 0.95 }],
        usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165, duration_ms: 450 },
      },
      seq: 2,
    });

    expect(state.connectionStatus).toBe('idle');
    expect(state.pendingRun).toBeNull();
    expect(state.terminalReceipt).toBeDefined();
    expect(state.terminalReceipt?.usage?.total_tokens).toBe(165);
    expect(state.transcript[0].status).toBe('completed');
    expect(state.transcript[0].receipt?.context_receipt).toEqual({ checkpoint: 'v1' });

    const snapshot = toPresentationSnapshot(state);
    expect(snapshot.messages[0].hasReceipt).toBe(true);
    expect(snapshot.messages[0].evidenceCount).toBe(1);
    expect(snapshot.usageSummary?.totalTokens).toBe(165);
  });

  it('handles run.failed with structured errors', () => {
    let state = INITIAL_CHAT_STATE;

    state = reduceChatEvent(state, {
      id: 'evt_1',
      run_id: sampleRunId,
      type: 'run.started',
      timestamp: now,
      data: {},
      seq: 1,
    });

    state = reduceChatEvent(state, {
      id: 'evt_2',
      run_id: sampleRunId,
      type: 'run.failed',
      timestamp: now,
      data: {
        error: {
          code: 'TOOL_PERMISSION_DENIED',
          message: 'Tool execution was denied by policy',
          retryable: false,
          category: 'POLICY',
        },
      },
      seq: 2,
    });

    expect(state.connectionStatus).toBe('error');
    expect(state.error?.code).toBe('TOOL_PERMISSION_DENIED');
    expect(state.transcript[0].status).toBe('failed');

    const snapshot = toPresentationSnapshot(state);
    expect(snapshot.statusBanner?.type).toBe('error');
    expect(snapshot.statusBanner?.text).toContain('TOOL_PERMISSION_DENIED');
  });

  it('handles cancellation properly', () => {
    let state = INITIAL_CHAT_STATE;

    state = reduceChatEvent(state, {
      id: 'evt_1',
      run_id: sampleRunId,
      type: 'run.started',
      timestamp: now,
      data: {},
      seq: 1,
    });

    state = reduceChatEvent(state, {
      id: 'evt_2',
      run_id: sampleRunId,
      type: 'run.cancelled',
      timestamp: now,
      data: {},
      seq: 2,
    });

    expect(state.connectionStatus).toBe('idle');
    expect(state.pendingRun).toBeNull();
    expect(state.transcript[0].status).toBe('cancelled');
  });

  it('manages optimistic flow in ChatClientController', () => {
    const controller = new ChatClientController();
    let latestSnapshot = controller.getSnapshot();

    const unsub = controller.subscribe((snap) => {
      latestSnapshot = snap;
    });

    controller.submitUserMessage('Can you summarize Apple stock news?', { runId: sampleRunId });

    expect(latestSnapshot.messages.length).toBe(1);
    expect(latestSnapshot.messages[0].role).toBe('user');
    expect(latestSnapshot.messages[0].content).toBe('Can you summarize Apple stock news?');
    expect(latestSnapshot.canSend).toBe(false); // isThinking / connecting

    controller.ingestEvent({
      id: 'evt_1',
      run_id: sampleRunId,
      type: 'run.started',
      timestamp: now,
      data: {},
      seq: 1,
    });

    controller.ingestEvent({
      id: 'evt_2',
      run_id: sampleRunId,
      type: 'message.delta',
      timestamp: now,
      data: { delta: 'Apple reported strong earnings.' },
      seq: 2,
    });

    expect(latestSnapshot.messages.length).toBe(2);
    expect(latestSnapshot.messages[1].role).toBe('assistant');
    expect(latestSnapshot.messages[1].content).toBe('Apple reported strong earnings.');

    unsub();
  });
});
