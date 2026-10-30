/**
 * Characterization of the admin conversation-list helpers.
 *
 * Pins collection scope selection, merged ordering (both directions) and the
 * per-document request-metric enrichment, including the agent cost overlay.
 * No database or HTTP server involved.
 */
import { describe, expect, it } from "vitest";
import type { Document } from "mongodb";
import {
  enrichConversationDocument,
  mergeConversationLists,
  resolveListScope,
} from "../admin/AdminConversationRoutes.ts";

describe("admin conversation list — resolveListScope", () => {
  const filter = { project: "p" };

  it("reads both collections for an unfiltered listing", () => {
    const scope = resolveListScope({}, filter, -1);
    expect(scope).toEqual({
      shouldFetchDirectConversations: true,
      shouldFetchAgentConversations: true,
      agentFilter: filter,
      sortKey: "updatedAt",
      sortDirection: -1,
    });
  });

  it("reads only direct conversations for type=direct or agent=none", () => {
    for (const query of [{ type: "direct" }, { agent: "NONE" }]) {
      const scope = resolveListScope(query, filter, 1);
      expect(scope.shouldFetchDirectConversations).toBe(true);
      expect(scope.shouldFetchAgentConversations).toBe(false);
    }
  });

  it("reads only agent conversations when a specific agent is selected", () => {
    const scope = resolveListScope({ agent: "atlas" }, filter, 1);
    expect(scope.shouldFetchDirectConversations).toBe(false);
    expect(scope.shouldFetchAgentConversations).toBe(true);
    expect(scope.agentFilter).toEqual({ project: "p", agent: "atlas" });
  });

  it("honours an explicit sort key", () => {
    expect(resolveListScope({ sort: "createdAt" }, filter, 1).sortKey).toBe("createdAt");
  });
});

describe("admin conversation list — mergeConversationLists", () => {
  const scope = {
    shouldFetchDirectConversations: true,
    shouldFetchAgentConversations: true,
    agentFilter: {},
    sortKey: "updatedAt",
    sortDirection: -1 as const,
  };

  it("tags and orders both sources newest-first", () => {
    const merged = mergeConversationLists(
      {
        directConversations: [{ id: "d1", updatedAt: "2026-01-02" }] as unknown as Document[],
        agentConversations: [{ id: "a1", updatedAt: "2026-01-03" }] as unknown as Document[],
      },
      scope,
    );
    expect(merged.map((item) => `${item.type}:${item.id}`)).toEqual(["agent:a1", "direct:d1"]);
  });

  it("reverses for ascending order and treats a missing sort value as empty", () => {
    const merged = mergeConversationLists(
      {
        directConversations: [{ id: "d1" }, { id: "d2", updatedAt: "2026-01-01" }] as unknown as Document[],
        agentConversations: [],
      },
      { ...scope, sortDirection: 1 },
    );
    expect(merged.map((item) => item.id)).toEqual(["d1", "d2"]);
  });
});

describe("admin conversation list — enrichConversationDocument", () => {
  const requestsFor = (documentId: string, requests: Document[]) =>
    new Map<string, Document[]>([[documentId, requests]]);

  it("aggregates request metrics and distinct models/tools", () => {
    const requests = [
      {
        model: "m1",
        inputTokens: 10,
        outputTokens: 5,
        totalTime: 2,
        estimatedCost: 0.01,
        tokensPerSec: 20,
        toolDisplayNames: ["Search", "Search"],
        toolApiNames: ["web_search"],
      },
      {
        model: "m2",
        inputTokens: 30,
        outputTokens: 15,
        totalTime: 4,
        estimatedCost: 0.02,
        tokensPerSec: 0,
        toolDisplayNames: [],
        toolApiNames: ["read_page"],
      },
    ] as Document[];

    const enriched = enrichConversationDocument(
      { id: "d1", type: "direct", totalCost: 0 },
      requestsFor("d1", requests),
    );

    expect(enriched).toMatchObject({
      id: "d1",
      type: "direct",
      requestCount: 2,
      inputTokens: 40,
      outputTokens: 20,
      totalLatency: 6,
      avgTokensPerSec: 20,
      models: ["m1", "m2"],
      toolDisplayNames: ["Search"],
      toolApiNames: ["web_search", "read_page"],
      totalCost: 0,
    });
  });

  it("overlays the larger aggregated cost on agent conversations only", () => {
    const requests = [{ estimatedCost: 0.5 }] as Document[];

    const agent = enrichConversationDocument(
      { id: "a1", type: "agent", totalCost: 0.2 },
      requestsFor("a1", requests),
    );
    expect(agent.totalCost).toBe(0.5);

    const direct = enrichConversationDocument(
      { id: "d1", type: "direct", totalCost: 0.2 },
      requestsFor("d1", requests),
    );
    expect(direct.totalCost).toBe(0.2);
  });

  it("returns zeroed metrics when a document has no request rows", () => {
    const enriched = enrichConversationDocument({ id: "lonely", totalCost: 0 }, new Map());
    expect(enriched).toMatchObject({
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      avgTokensPerSec: null,
      totalLatency: 0,
      models: [],
      toolDisplayNames: [],
      toolApiNames: [],
    });
  });
});
