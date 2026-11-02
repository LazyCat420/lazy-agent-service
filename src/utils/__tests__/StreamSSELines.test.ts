import { describe, expect, it } from "vitest";
import { streamSSELines } from "../openai-compat.ts";

function readerOf(chunks: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  }).getReader();
}

async function collect(gen: AsyncGenerator<string>) {
  const out: string[] = [];
  for await (const l of gen) out.push(l);
  return out;
}

describe("streamSSELines", () => {
  it("re-joins lines split across chunks and drops the trailing partial", async () => {
    const lines = await collect(streamSSELines(readerOf(["data: a\nda", "ta: b\npartial"])));
    expect(lines).toEqual(["data: a", "data: b"]);
  });
  it("stops immediately when the signal is already aborted", async () => {
    const c = new AbortController();
    c.abort();
    expect(await collect(streamSSELines(readerOf(["data: a\n"]), c.signal))).toEqual([]);
  });
});
