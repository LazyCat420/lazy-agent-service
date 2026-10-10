// Throwaway smoke server: serves public/chat and mocks the turn SSE +
// conversation snapshot endpoints. NOT part of the service.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const turnEvents = [
  { type: "hello", seq: 1, protocolVersion: 1 },
  { type: "chunk", seq: 2, content: "Let me check that for you…" },
  { type: "tool_execution", seq: 3, status: "calling", timestamp: 1000, tool: { id: "call_1", name: "read_file", args: { path: "config.json" } } },
  { type: "tool_execution", seq: 4, status: "done", tool: { id: "call_1", name: "read_file", args: { path: "config.json" }, result: { ok: true }, durationMilliseconds: 1200 } },
  { type: "sub_agent_status", seq: 5, subAgentId: "w1", message: "phase", label: "summarizing" },
  { type: "sub_agent_status", seq: 6, subAgentId: "w1", message: "complete", usage: { tokens: 20 } },
  { type: "chunk", seq: 7, content: " The config looks good." },
  {
    type: "done", seq: 8,
    usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 },
    totalTime: 2.5, provider: "mock", model: "mock-1",
  },
];

// Drop mode: SSE ends without a terminal event (recovery test).
let dropMode = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/__mode") {
    dropMode = url.searchParams.get("drop") === "1";
    res.writeHead(200).end(`dropMode=${dropMode}`);
    return;
  }
  if (req.method === "POST" && (url.pathname === "/chat" || url.pathname === "/agent")) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let i = 0;
    req.on("close", () => console.log(`[smoke] client closed after ${i} events (dropMode=${dropMode})`));
    const timer = setInterval(() => {
      if (dropMode && i === 3) { clearInterval(timer); res.end(); return; } // drop mid-turn
      if (i < turnEvents.length) {
        res.write(`data: ${JSON.stringify(turnEvents[i++])}\n\n`);
      } else {
        clearInterval(timer);
        res.end();
      }
    }, 150);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/conversations/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "conv_smoke",
      messages: [
        { role: "user", content: "What about the config?", timestamp: new Date().toISOString() },
        { role: "assistant", content: "The config looks good.", timestamp: new Date().toISOString() },
      ],
    }));
    return;
  }
  const file = url.pathname === "/chat" || url.pathname === "/chat/" ? "/index.html" : url.pathname.replace(/^\/chat/, "");
  try {
    const body = await readFile(join(ROOT, "public/chat", file));
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(8899, () => console.log("smoke server on :8899"));
