import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { INITIAL_CHAT_STATE, type ChatState } from '../src/types.js';
import { ingestTurnEvent, type WireTurnEvent } from '../src/turnTransport.js';
import {
  toPresentationSnapshot,
  renderActivityIndicator,
  THINKING_DOTS_CLASS,
  THINKING_DOTS_CSS,
  type ActivityFeedEntry,
} from '../src/presentation.js';

function loadFixture(name: string): WireTurnEvent[] {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/turn-events/${name}.json`, import.meta.url), 'utf8'),
  ) as WireTurnEvent[];
}

function foldUpTo(events: WireTurnEvent[], count: number): ChatState {
  let state = INITIAL_CHAT_STATE;
  for (const event of events.slice(0, count)) state = ingestTurnEvent(state, event);
  return state;
}

// Minimal DOM stand-ins: renderActivityIndicator only touches the surface
// implemented here (createElement, appendChild, replaceChildren,
// setAttribute, textContent, className, children, ownerDocument).
interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  children: FakeElement[];
  ownerDocument: FakeDocument;
  attributes: Record<string, string>;
  appendChild(child: FakeElement): FakeElement;
  replaceChildren(...children: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
}

interface FakeDocument {
  createElement(tagName: string): FakeElement;
}

function makeFakeDocument(): FakeDocument {
  const doc: FakeDocument = {
    createElement(tagName: string): FakeElement {
      const element: FakeElement = {
        tagName,
        className: '',
        textContent: '',
        children: [],
        ownerDocument: doc,
        attributes: {},
        appendChild(child: FakeElement) {
          element.children.push(child);
          return child;
        },
        replaceChildren(...next: FakeElement[]) {
          element.children = next;
        },
        setAttribute(name: string, value: string) {
          element.attributes[name] = value;
        },
      };
      return element;
    },
  };
  return doc;
}

const ACTIVITY_ROW_CLASS = 'agent-chat-activity-row';

function describeFeed(el: FakeElement): string[] {
  return (
    el.children[0]?.children
      .filter((node) => node.className === ACTIVITY_ROW_CLASS)
      .map((row) => row.textContent ?? '') ?? []
  );
}

describe('activityFeed derivation', () => {
  const events = loadFixture('happy-path');

  it('shows a thinking row while streaming with no active tool', () => {
    const snapshot = toPresentationSnapshot(foldUpTo(events, 3));
    const thinking = snapshot.activityFeed.filter((row) => row.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].state).toBe('active');
  });

  it('marks the tool active while calling and done with duration after', () => {
    const calling = toPresentationSnapshot(foldUpTo(events, 5));
    const activeTool = calling.activityFeed.filter((row) => row.kind === 'tool');
    expect(activeTool).toHaveLength(1);
    expect(activeTool[0].state).toBe('active');
    expect(activeTool[0].label).toContain('read_file');

    const finished = toPresentationSnapshot(foldUpTo(events, 6));
    const toolRow = finished.activityFeed.find((row) => row.kind === 'tool');
    expect(toolRow?.state).toBe('done');
    expect(toolRow?.durationMs).toBe(4200);
    expect(toolRow?.detail).toBe('Reading a.ts');
  });

  it('is chronological and empty of active rows once the turn completes', () => {
    const snapshot = toPresentationSnapshot(foldUpTo(events, 7));
    const ats = snapshot.activityFeed.map((row) => row.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(snapshot.activityFeed.every((row) => row.state !== 'active')).toBe(true);
    expect(snapshot.isThinking).toBe(false);
  });
});

describe('renderActivityIndicator', () => {
  const events = loadFixture('happy-path');

  it('exports the dots class and CSS snippet', () => {
    expect(THINKING_DOTS_CLASS).toBe('agent-chat-thinking-dots');
    expect(THINKING_DOTS_CSS).toContain('agent-chat-thinking-dots');
    expect(THINKING_DOTS_CSS).toContain('@keyframes');
  });

  it('mounts once and updates rows in place across snapshots', () => {
    const doc = makeFakeDocument();
    const el: FakeElement = {
      tagName: 'div',
      className: '',
      textContent: '',
      children: [],
      ownerDocument: doc,
      attributes: {},
      appendChild(child: FakeElement) {
        el.children.push(child);
        return child;
      },
      replaceChildren(...next: FakeElement[]) {
        el.children = next;
      },
      setAttribute(name: string, value: string) {
        el.attributes[name] = value;
      },
    };

    const thinkingSnapshot = toPresentationSnapshot(foldUpTo(events, 3));
    renderActivityIndicator(el as unknown as HTMLElement, thinkingSnapshot);
    expect(el.children).toHaveLength(1);
    const root = el.children[0];
    expect(root.className).toContain('agent-chat-activity-indicator');
    // Dots mount while thinking.
    expect(root.children.some((c) => c.className === THINKING_DOTS_CLASS)).toBe(true);
    const thinkingRows = describeFeed(el);
    expect(thinkingRows[0]).toContain('Thinking');

    const toolSnapshot = toPresentationSnapshot(foldUpTo(events, 5));
    renderActivityIndicator(el as unknown as HTMLElement, toolSnapshot);
    expect(el.children).toHaveLength(1); // no duplicate mount
    const rows = describeFeed(el);
    // The tool is active: it leads the feed; no thinking row while it runs.
    expect(rows[0]).toContain('read_file');
    expect(rows).toHaveLength(1);

    const doneSnapshot = toPresentationSnapshot(foldUpTo(events, 6));
    renderActivityIndicator(el as unknown as HTMLElement, doneSnapshot);
    const doneRows = describeFeed(el);
    // The stream is still open: thinking is the latest entry, the finished
    // tool row follows with its wire duration.
    const toolRow = doneRows.find((row) => row.includes('read_file'));
    expect(toolRow).toBeDefined();
    expect(toolRow).toContain('4200');
  });

  it('clears the dots once the turn is no longer thinking', () => {
    const doc = makeFakeDocument();
    const el: FakeElement = {
      tagName: 'div',
      className: '',
      textContent: '',
      children: [],
      ownerDocument: doc,
      attributes: {},
      appendChild(child: FakeElement) {
        el.children.push(child);
        return child;
      },
      replaceChildren(...next: FakeElement[]) {
        el.children = next;
      },
      setAttribute(name: string, value: string) {
        el.attributes[name] = value;
      },
    };

    const finalSnapshot = toPresentationSnapshot(foldUpTo(loadFixture('happy-path'), 7));
    renderActivityIndicator(el as unknown as HTMLElement, finalSnapshot);
    expect(el.children[0].children.some((c) => c.className === THINKING_DOTS_CLASS)).toBe(false);
  });
});

describe('ActivityFeedEntry shape', () => {
  it('carries the documented fields', () => {
    const entry: ActivityFeedEntry = {
      id: 'call_1',
      at: 1000,
      kind: 'tool',
      label: 'Tool read_file completed',
      detail: 'Reading a.ts',
      state: 'done',
      durationMs: 4200,
    };
    expect(entry.state).toBe('done');
  });
});
