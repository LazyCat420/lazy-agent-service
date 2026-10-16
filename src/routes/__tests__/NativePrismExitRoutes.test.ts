// Prism-exit contract (ch. 05-own-harness-cutover, 2026-10-15):
// with PRISM_ENABLED=false, trading-service / lazycat-sdk point prism_client.url
// at THIS service bare (http://<host>:5591) and every call they make must land
// on a NATIVE route here — never forwarded to prism :7777 via /prism-proxy.
//
// Pinned: for each endpoint the callers reach natively, the corresponding
// router must export the method+path. If a router drops one of these, the
// prism exit silently breaks and callers start 404ing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Router } from "express";
import { describe, expect, it } from "vitest";

import agentRouter from "../AgentRoutes.ts";
import chatRouter from "../ChatRoutes.ts";
import configRouter from "../ConfigRoutes.ts";
import conversationsRouter from "../ConversationsRoutes.ts";
import customAgentsRouter from "../CustomAgentsRoutes.ts";
import embedRouter from "../EmbedRoutes.ts";

interface RouteLayer {
  route?: { path?: string; methods?: Record<string, boolean> };
}

function routesOf(router: Router): string[] {
  const layers = router.stack as RouteLayer[];
  return layers
    .map((layer) => {
      const route = layer.route;
      if (!route?.path) return null;
      const methods = Object.entries(route.methods ?? {})
        .filter(([, on]) => on)
        .map(([m]) => m.toUpperCase());
      return methods.length ? `${methods.join("|")} ${route.path}` : null;
    })
    .filter((entry): entry is string => entry !== null);
}

function expectRoute(router: Router, method: string, path: string) {
  const all = routesOf(router);
  const hit = all.some(
    (entry) => entry.split(" ").includes(method) && entry.endsWith(` ${path}`),
  );
  expect(hit, `expected ${method} ${path} in [${all.join(", ")}]`).toBe(true);
}

describe("prism-exit native route coverage", () => {
  it("POST /agent and POST /agent/stop exist", () => {
    expectRoute(agentRouter, "POST", "/");
    expectRoute(agentRouter, "POST", "/stop");
  });

  it("custom agents GET/POST/PUT exist (registration + music-player PUT /:id)", () => {
    expectRoute(customAgentsRouter, "GET", "/");
    expectRoute(customAgentsRouter, "POST", "/");
    expectRoute(customAgentsRouter, "PUT", "/:id");
  });

  it("config catalog (model→provider resolve) and /config/agents exist", () => {
    expectRoute(configRouter, "GET", "/");
    expectRoute(configRouter, "GET", "/agents");
  });

  it("GET /conversations exists", () => {
    expectRoute(conversationsRouter, "GET", "/");
  });

  it("POST /embed exists", () => {
    expectRoute(embedRouter, "POST", "/");
  });

  it("POST /chat exists (youtube-wallgarden)", () => {
    expectRoute(chatRouter, "POST", "/");
  });

  it("GET /config honours ?includeLocal=true (lazycat-sdk provider resolve)", () => {
    const source = readFileSync(fileURLToPath(new URL("../ConfigRoutes.ts", import.meta.url)), "utf8");
    expect(source).toContain('includeLocal === "true"');
    expect(source).toContain("textToText:");
  });
});
