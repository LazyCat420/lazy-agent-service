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
    expect(await replayEvents('/runs/run-one/events', 'previous', {}, fetcher as typeof fetch)).toEqual([original]);
  });
});
