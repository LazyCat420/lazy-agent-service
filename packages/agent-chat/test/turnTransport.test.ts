import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { INITIAL_CHAT_STATE, type ChatState } from '../src/types.js';
import {
  buildTurnPayload,
  ingestTurnEvent,
  ingestStreamClosed,
  type TurnPayloadInputs,
  type WireTurnEvent,
} from '../src/turnTransport.js';

function loadFixture(name: string): WireTurnEvent[] {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/turn-events/${name}.json`, import.meta.url), 'utf8'),
  ) as WireTurnEvent[];
}

function fold(events: WireTurnEvent[], state: ChatState = INITIAL_CHAT_STATE): ChatState {
  let next = state;
  for (const event of events) next = ingestTurnEvent(next, event);
  return next;
}

describe('buildTurnPayload', () => {
  const base: TurnPayloadInputs = {
    isNoAgent: false,
    conversationId: 'conv_1',
    traceId: 'trace_1',
    agentId: 'agent_1',
    agentProject: 'prism',
    activeRuleNames: ['rule-a'],
    permissionMode: 'auto',
    planFirst: true,
    maxIterations: 25,
    maxSubAgentIterations: 10,
    maxRecursionDepth: 3,
    disabledTools: ['dangerous_tool'],
    settings: {
      provider: 'anthropic',
      model: 'claude-x',
      maxTokens: 8192,
      temperature: 0.2,
      thinkingEnabled: true,
    },
    messages: [{ role: 'user', content: 'hi' }],
  };

  it('produces the /agent body with the contract field names', () => {
    const { path, payload } = buildTurnPayload({ ...base, isNoAgent: false });
    expect(path).toBe('/agent');
    expect(payload).toMatchObject({
      provider: 'anthropic',
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      functionCallingEnabled: true,
      disabledTools: ['dangerous_tool'],
      maxTokens: 8192,
      temperature: 0.2,
      thinkingEnabled: true,
      project: 'prism',
      conversationId: 'conv_1',
      traceId: 'trace_1',
      agent: 'agent_1',
      activeRuleNames: ['rule-a'],
      permissionMode: 'auto',
      planFirst: true,
      maxIterations: 25,
      maxSubAgentIterations: 10,
      maxRecursionDepth: 3,
    });
  });

  it('produces the /chat body for direct chat', () => {
    const { path, payload } = buildTurnPayload({
      ...base,
      isNoAgent: true,
      settings: { ...base.settings, systemPrompt: 'be brief' },
    });
    expect(path).toBe('/chat');
    expect(payload).toMatchObject({
      provider: 'anthropic',
      model: 'claude-x',
      maxTokens: 8192,
      temperature: 0.2,
      conversationId: 'conv_1',
      traceId: 'trace_1',
      conversationMeta: { systemPrompt: 'be brief' },
    });
    const messages = payload.messages;
    expect(messages?.[0]).toEqual({ role: 'system', content: 'be brief' });
    expect('agent' in payload).toBe(false);
  });
});

describe('ingestTurnEvent over the happy-path fixture', () => {
  const events = loadFixture('happy-path');

  it('builds the transcript, completes the tool and clears pendingRun', () => {
    const state = fold(events);

    const assistant = state.transcript.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe('Hello world');
    expect(assistant[0].status).toBe('completed');

    const tool = state.toolActivities['call_1'];
    expect(tool).toBeDefined();
    expect(tool?.toolName).toBe('read_file');
    expect(tool?.status).toBe('completed');
    expect(tool?.durationMs).toBe(4200);
    expect(tool?.output).toEqual({ text: 'export const a = 1;' });

    expect(state.pendingRun).toBeNull();
    expect(state.connectionStatus).toBe('idle');
    expect(state.unrecognizedEvents).toBe(0);
    expect(state.terminalReceipt?.usage?.total_tokens).toBe(120);
  });
});

describe('ingestTurnEvent over the failure fixture', () => {
  it('maps the wire error event to a failed run', () => {
    const state = fold(loadFixture('failure'));

    expect(state.pendingRun).toBeNull();
    expect(state.connectionStatus).toBe('error');
    expect(state.error?.code).toBe('internal');
    expect(state.error?.message).toBe('the harness crashed');
    expect(state.error?.retryable).toBe(true);
    expect(state.transcript.find((m) => m.role === 'assistant')?.status).toBe('failed');
  });
});

describe('ingestTurnEvent over the disconnect fixture', () => {
  it('keeps pendingRun set when the stream ends without a terminal event', () => {
    let state = fold(loadFixture('disconnect'));
    expect(state.pendingRun).not.toBeNull();
    expect(state.connectionStatus).toBe('streaming');

    state = ingestStreamClosed(state);
    // The turn may still be running server-side: pendingRun stays, the
    // connection is marked errored with a retryable STREAM_CLOSED error.
    expect(state.pendingRun).not.toBeNull();
    expect(state.connectionStatus).toBe('error');
    expect(state.error?.code).toBe('STREAM_CLOSED');
    expect(state.error?.retryable).toBe(true);
  });
});

describe('ingestTurnEvent over the approval fixture', () => {
  it('raises then resolves the approval and completes the tool', () => {
    const events = loadFixture('approval');
    const midState = fold(events.slice(0, 2));
    expect(Object.keys(midState.approvals)).toContain('call_7');
    expect(midState.pendingRun?.status).toBe('waiting_for_approval');

    const state = fold(events);
    expect(state.approvals).toEqual({});
    expect(state.toolActivities['call_7']?.status).toBe('completed');
    expect(state.toolActivities['call_7']?.durationMs).toBe(300);
    expect(state.pendingRun).toBeNull();
  });
});

describe('ingestTurnEvent with unknown events', () => {
  it('passes unknown types through as a no-op and counts them', () => {
    const state = fold([
      { type: 'hello', seq: 1, protocolVersion: 1 },
      { type: 'mystery_event', seq: 2, payload: { anything: true } },
    ]);
    expect(state.unrecognizedEvents).toBe(1);
    expect(state.transcript).toEqual([]);
    expect(state.toolActivities).toEqual({});
  });

  it('does not count recognized wire events that carry no state', () => {
    const state = fold([
      { type: 'hello', seq: 1, protocolVersion: 1 },
      { type: 'thinking', seq: 2, content: 'hmm' },
      { type: 'status', seq: 3, message: 'compaction_started' },
      { type: 'tool_output', seq: 4, toolCallId: null, name: 'sh', event: 'stdout', data: 'x' },
    ]);
    expect(state.unrecognizedEvents).toBe(0);
  });
});
