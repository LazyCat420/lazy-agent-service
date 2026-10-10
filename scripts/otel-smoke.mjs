// Smoke check for src/telemetry/otel.ts: does a real express + fetch call
// produce spans at the collector, and is /health left out?
//
//   pnpm run build:runtime && node scripts/otel-smoke.mjs
//   SMOKE_TRACING=0 node scripts/otel-smoke.mjs   (control: must fail)
//
// Starts a fake OTLP collector, then a child process that loads
// dist/src/telemetry/otel.js with --import exactly as production does.
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bodies = [];
const collector = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.url === "/v1/traces") bodies.push(Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "application/x-protobuf" }).end();
  });
});
await new Promise((r) => collector.listen(0, "127.0.0.1", r));
const collectorPort = collector.address().port;

// The traced app: an express route that makes an outgoing fetch, plus /health.
// /health is hit over a raw socket, like Docker's wget: the check is that the
// INCOMING request is skipped (an outgoing fetch to it would rightly be traced).
const app = `
import express from "express";
import net from "node:net";
const app = express();
app.get("/health", (_q, r) => { console.log("HEALTH_HIT"); r.json({ ok: true }); });
app.get("/work", async (_q, r) => {
  const res = await fetch("http://127.0.0.1:${collectorPort}/downstream");
  r.json({ downstream: res.status });
});
const server = app.listen(0, "127.0.0.1", async () => {
  const base = "http://127.0.0.1:" + server.address().port;
  await new Promise((done) => {
    const s = net.connect(server.address().port, "127.0.0.1", () =>
      s.end("GET /health HTTP/1.1\\r\\nHost: x\\r\\nConnection: close\\r\\n\\r\\n"));
    s.on("data", () => {}).on("close", done);
  });
  await fetch(base + "/work");
  setTimeout(() => process.exit(0), 6500); // let the batch processor flush (5 s)
});
`;

const child = spawn(
  process.execPath,
  ["--import", "./dist/src/telemetry/otel.js", "--input-type=module", "-e", app],
  {
    cwd: root,
    env: {
      ...process.env,
      OTEL_TRACING_ENABLED: process.env.SMOKE_TRACING ?? "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
      OTEL_SERVICE_NAME: "otel-smoke",
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let childOut = "";
child.stdout.on("data", (d) => { childOut += d; process.stdout.write(d); });
const code = await new Promise((r) => child.on("exit", r));
collector.close();

// OTLP protobuf keeps strings as plain bytes, so names can be found directly.
const raw = Buffer.concat(bodies).toString("latin1");
const checks = {
  "child exited cleanly": code === 0,
  "spans reached the collector": bodies.length > 0,
  "service name is set": raw.includes("otel-smoke"),
  "express route span": raw.includes("/work"),
  "outgoing fetch span": raw.includes("/downstream"),
  "health check was served": childOut.includes("HEALTH_HIT"),
  "health checks not traced": !raw.includes("/health"),
};
let failed = 0;
for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
