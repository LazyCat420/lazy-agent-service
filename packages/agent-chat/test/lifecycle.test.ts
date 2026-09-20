import { describe, it, expect } from 'vitest';
import { ChatClientController, INITIAL_CHAT_STATE, parseRunEvent, readSSE, reduceChatEvent, replayEvents, toPresentationSnapshot, type RunEvent } from '../src/index.js';

const event = (id: string, type: string, data = {}, run_id = 'run-one'): RunEvent =>
  ({ id, type, data, run_id, timestamp: new Date(0).toISOString() });

describe('canonical delivery and lifecycle', () => {
  it('deduplicates replay without losing a second run whose sequence restarts', () => {
    let state = reduceChatEvent(INITIAL_CHAT_STATE, event('1', 'run.started'));
    const delta = event('2', 'message.delta', { delta: 'hello' });
    state = reduceChatEvent(state, delta);
    expect(reduceChatEvent(state, delta)).toBe(state);
    state = reduceChatEvent(state, event('3', 'run.completed'));
    expect(reduceChatEvent(state, event('4', 'message.delta', { delta: 'late' }))).toBe(state);
    state = reduceChatEvent(state, { ...event('1', 'run.started', {}, 'run-two'), seq: 1 });
    expect(state.pendingRun?.runId).toBe('run-two');
    expect(state.transcript[0].content).toBe('hello');
  });

  it('keeps cancellation pending and accepts completion winning the race', () => {
    const client = new ChatClientController();
    client.submitUserMessage('hello', { runId: 'run-one' });
    expect(client.submitUserMessage('duplicate')).toBe('');
    client.ingestEvent(event('1', 'run.started'));
    client.cancel();
    expect(client.getState().cancellationRequested).toBe(true);
    expect(client.getState().pendingRun).not.toBeNull();
    client.ingestEvent(event('2', 'run.completed'));
    expect(client.getState().transcript[1].status).toBe('completed');
    expect(client.getState().cancellationRequested).toBe(false);
  });

  it('distinguishes progress from approval and clears pending work on failure', () => {
    let state = reduceChatEvent(INITIAL_CHAT_STATE, event('1', 'run.started'));
    state = reduceChatEvent(state, event('2', 'tool.invoked', { tool_call_id: 'call' }));
    expect(state.approvals).toEqual({});
    state = reduceChatEvent(state, event('3', 'approval.required', { id: 'approval' }));
    expect(toPresentationSnapshot(state).statusBanner?.text).toBe('Approval required');
    state = reduceChatEvent(state, event('4', 'run.failed', { error: { code: 'DEADLINE_EXCEEDED' } }));
    expect(toPresentationSnapshot(state).canSend).toBe(true);
    expect(toPresentationSnapshot(state).activeActivities).toEqual([]);
    expect(state.approvals).toEqual({});
  });

  it('preserves unknown events and incomplete outcomes; unknown usage stays unknown', () => {
    let state = reduceChatEvent(INITIAL_CHAT_STATE, event('1', 'run.started'));
    state = reduceChatEvent(state, parseRunEvent(event('2', 'future.event')));
    expect(state.unknownEvents).toHaveLength(1);
    state = reduceChatEvent(state, event('3', 'run.completed', { outcome: 'incomplete', usage: {} }));
    expect(state.transcript[0].status).toBe('incomplete');
    expect(toPresentationSnapshot(state).usageSummary?.totalTokens).toBeNull();
  });

  it('reads fragmented UTF-8 and multiline SSE and rejects truncated frames', async () => {
    const bytes = new TextEncoder().encode('data: {"text":\r\ndata: "☃"}\r\n\r\n');
    const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    const result = [];
    for await (const item of readSSE(body)) result.push(item);
    expect(result).toEqual([{ text: '☃' }]);
    await expect(async () => { for await (const _ of readSSE(new Response('data: {}').body!)) {} }).rejects.toThrow('Incomplete');
  });

  it('reconnects with the opaque cursor using GET, never resubmitting execution', async () => {
    const original = event('next', 'message.delta', { delta: 'continued' });
    const fetcher = async (_: any, init: any) => {
      expect(init.method).toBe('GET');
      expect(init.headers.get('Last-Event-ID')).toBe('previous');
      return new Response(`data: ${JSON.stringify(original)}\n\n`);
    };
    expect(await replayEvents('/runs/run-one/events', 'run-one', 'previous', {}, fetcher as typeof fetch)).toEqual([original]);
  });

  it('rejects replay frames bound to another run', async () => {
    const foreign = event('next', 'message.delta', { delta: 'wrong run' }, 'run-two');
    const fetcher = async () => new Response(`data: ${JSON.stringify(foreign)}\n\n`);
    await expect(replayEvents(
      '/runs/run-one/events', 'run-one', undefined, {}, fetcher as typeof fetch
    )).rejects.toThrow('another run');
  });

  it('ignores another run while an active run owns global UI state', () => {
    let state = reduceChatEvent(INITIAL_CHAT_STATE, event('1', 'run.started'));
    state = reduceChatEvent(state, event('2', 'approval.required', { id: 'approval-one' }));
    state = { ...state, cancellationRequested: true };

    const unchanged = reduceChatEvent(
      state,
      event('foreign-terminal', 'run.completed', { status: 'completed' }, 'run-two')
    );
    expect(unchanged).toBe(state);
    expect(unchanged.pendingRun?.runId).toBe('run-one');
    expect(unchanged.connectionStatus).toBe('streaming');
    expect(unchanged.approvals).toHaveProperty('approval-one');
    expect(unchanged.cancellationRequested).toBe(true);
  });

  it('keeps streamed text and falls back only to the final current assistant message', () => {
    let streamed = reduceChatEvent(INITIAL_CHAT_STATE, event('1', 'run.started'));
    streamed = reduceChatEvent(streamed, event('2', 'message.delta', { delta: 'streamed answer' }));
    streamed = reduceChatEvent(streamed, event('3', 'run.completed', {
      status: 'completed',
      messages: [
        { role: 'assistant', content: 'historical answer', outcome: 'incomplete' },
        { role: 'user', content: 'current question' },
        { role: 'assistant', content: 'terminal answer' },
      ],
    }));
    expect(streamed.transcript[0].content).toBe('streamed answer');
    expect(streamed.transcript[0].status).toBe('completed');

    const withoutPlaceholder = reduceChatEvent(
      INITIAL_CHAT_STATE,
      event('terminal-only', 'run.completed', {
        status: 'completed',
        messages: [
          { role: 'assistant', content: 'historical answer', outcome: 'incomplete' },
          { role: 'assistant', content: 'final answer' },
        ],
      })
    );
    expect(withoutPlaceholder.transcript).toHaveLength(1);
    expect(withoutPlaceholder.transcript[0].content).toBe('final answer');
    expect(withoutPlaceholder.transcript[0].status).toBe('completed');
  });

  it('renders error-valued tool results as failed', () => {
    let state = reduceChatEvent(INITIAL_CHAT_STATE, event('1', 'run.started'));
    state = reduceChatEvent(state, event('2', 'tool.invoked', {
      tool_call_id: 'tool-one', tool_name: 'lookup',
    }));
    state = reduceChatEvent(state, event('3', 'tool.result', {
      tool_call_id: 'tool-one',
      result: { is_error: true, error: { message: 'lookup failed' } },
    }));
    expect(state.toolActivities['tool-one'].status).toBe('failed');
    expect(state.toolActivities['tool-one'].error).toBe('lookup failed');
  });

  it('keeps current incomplete evidence despite a completed run status', () => {
    let state = reduceChatEvent(INITIAL_CHAT_STATE, event('1', 'run.started'));
    state = reduceChatEvent(state, event('2', 'run.completed', {
      status: 'completed',
      messages: [
        { role: 'assistant', content: 'historical complete answer' },
        { role: 'assistant', content: 'partial current answer', outcome: 'incomplete' },
      ],
    }));
    expect(state.transcript[0].content).toBe('partial current answer');
    expect(state.transcript[0].status).toBe('incomplete');
  });
});
