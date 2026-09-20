import type { RunEvent } from './types.js';

/** Validate the wire envelope without discarding future event names. */
export function parseRunEvent(value: unknown): RunEvent {
  const event = value as RunEvent;
  if (!event || typeof event !== 'object' ||
      typeof event.id !== 'string' || !event.id ||
      typeof event.run_id !== 'string' || !event.run_id ||
      typeof event.type !== 'string' || !event.type ||
      typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp)) ||
      !event.data || typeof event.data !== 'object' || Array.isArray(event.data) ||
      (event.seq !== undefined && (!Number.isSafeInteger(event.seq) || event.seq < 1))) {
    throw new Error('Invalid runtime event envelope');
  }
  return event;
}

/** Incremental SSE framing, including split UTF-8, CRLF and multiline data. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line && data.length) {
          const payload = data.join('\n');
          data = [];
          if (payload !== '[DONE]') yield JSON.parse(payload);
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) {
        if (buffer.trim() || data.length) throw new Error('Incomplete SSE frame');
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Replay delivery only. The caller supplies its authorized application proxy. */
export async function replayEvents(
  url: string, cursor: string | undefined, init: RequestInit = {}, fetcher: typeof fetch = fetch,
): Promise<RunEvent[]> {
  const headers = new Headers(init.headers);
  if (cursor) headers.set('Last-Event-ID', cursor);
  const response = await fetcher(url, { ...init, method: 'GET', headers });
  if (!response.ok || !response.body) throw new Error(`Replay failed: HTTP ${response.status}`);
  const events: RunEvent[] = [];
  for await (const event of readSSE(response.body)) events.push(parseRunEvent(event));
  return events;
}
