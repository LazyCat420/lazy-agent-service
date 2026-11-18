// Serves an express app on 127.0.0.1 for a test and sends it raw HTTP requests.
// Requests go through node:http rather than fetch because fetch lower-cases header names
// before they reach the wire, which would hide header-casing behaviour.
import http from "node:http";
import type { Express } from "express";

export interface LoopbackReply {
  status: number;
  /** Response body parsed as JSON. */
  body: unknown;
}

export interface LoopbackRequest {
  method?: string;
  /** Sent with the names spelt exactly as given. */
  headers?: Record<string, string>;
  /** Sent as a JSON body with content-type application/json. */
  json?: unknown;
}

export interface LoopbackApp {
  request(path: string, options?: LoopbackRequest): Promise<LoopbackReply>;
  close(): Promise<void>;
}

export async function serveOnLoopback(app: Express): Promise<LoopbackApp> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback server has no port");
  const { port } = address;

  return {
    request(path, options = {}) {
      const payload = options.json === undefined ? undefined : JSON.stringify(options.json);
      const headers = { ...options.headers, ...(payload === undefined ? {} : { "content-type": "application/json" }) };
      return new Promise<LoopbackReply>((resolve, reject) => {
        const outgoing = http.request(
          { host: "127.0.0.1", port, path, method: options.method ?? (payload === undefined ? "GET" : "POST"), headers, agent: false },
          (incoming) => {
            const parts: Buffer[] = [];
            incoming.on("data", (part: Buffer) => parts.push(part));
            incoming.on("error", reject);
            incoming.on("end", () => {
              try {
                resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString()) });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        outgoing.on("error", reject);
        outgoing.end(payload);
      });
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
