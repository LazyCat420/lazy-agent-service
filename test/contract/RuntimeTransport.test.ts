import { afterEach, describe, it, expect, vi } from "vitest";
import { RuntimeClient } from "../../src/client/RuntimeClient.ts";
import { GlobalCapabilityExecutor } from "../../src/services/GlobalCapabilityExecutor.ts";
import { CapabilityRegistry } from "../../src/services/CapabilityRegistry.ts";

afterEach(() => vi.unstubAllGlobals());
describe("Transport and capability failure contracts", () => {
  for (const separator of ["\n", "\r\n"]) it(`handles fragmented ${JSON.stringify(separator)} framing`, async () => {
    const frame = (id: string, type: string, data: any) => `data: ${JSON.stringify({ id, run_id: "run", type, timestamp: new Date().toISOString(), data })}${separator}${separator}`;
    const delta = frame("a", "message.delta", { delta: "News ☀" });
    const bytes = new TextEncoder().encode(`: heartbeat${separator}${separator}` + delta + delta + frame("b", "run.completed", {}));
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(controller) { for (const b of bytes) controller.enqueue(new Uint8Array([b])); controller.close(); } })));
    const events = [];
    for await (const event of new RuntimeClient("http://runtime.example").streamRun({ profile_id: "test", input: "news" })) events.push(event);
    expect(events.map(e => e.id)).toEqual(["a", "b"]);
    expect(events[0].data.delta).toBe("News ☀");
  });
  it("rejects premature EOF", async () => {
    vi.stubGlobal("fetch", async () => new Response(": heartbeat\n\n"));
    await expect((async () => { for await (const _ of new RuntimeClient("http://runtime.example").streamRun({ profile_id: "test", input: "news" })) {} })()).rejects.toThrow("terminal");
  });
  it("never advertises or fabricates unimplemented evidence", async () => {
    for (const id of ["global.document.summarize", "global.media.transcribe", "global.media.describe_image"]) {
      expect(CapabilityRegistry.listCapabilities().some(c => c.id === id)).toBe(false);
      expect((await GlobalCapabilityExecutor.execute(id, {})).success).toBe(false);
    }
  });
});

const transportFrame = (id: string, type: string, runId = "run") => `data: ${JSON.stringify({ id, run_id: runId, type, timestamp: new Date().toISOString(), data: {} })}\r\n\r\n`;
it("cancels a known run when the consumer breaks, but never after terminal", async () => {
  for (const terminal of [false, true]) {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/cancel") ? Response.json({}) : new Response(transportFrame("a", terminal ? "run.completed" : "run.started")));
    vi.stubGlobal("fetch", fetcher);
    for await (const _ of new RuntimeClient("http://runtime.example").streamRun({ profile_id: "test", input: "news" })) break;
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/cancel"))).toHaveLength(terminal ? 0 : 1);
  }
});
it("replay validates run binding and deduplicates persisted event frames", async () => {
  const client = new RuntimeClient("http://runtime.example");
  vi.stubGlobal("fetch", async () => new Response(transportFrame("a", "run.started") + transportFrame("a", "run.started")));
  const events = []; for await (const event of client.replayEvents("run")) events.push(event);
  expect(events).toHaveLength(1);
  vi.stubGlobal("fetch", async () => new Response(transportFrame("b", "run.completed", "other-run")));
  await expect((async () => { for await (const _ of client.replayEvents("run")) {} })()).rejects.toThrow("another run");
});
