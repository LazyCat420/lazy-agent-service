import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityRegistry } from "../../src/services/CapabilityRegistry.ts";
import { GlobalCapabilityExecutor } from "../../src/services/GlobalCapabilityExecutor.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";

describe("CapabilityRegistry & GlobalCapabilityExecutor Contract Tests", () => {
  beforeEach(() => {
    CapabilityRegistry.reset();
  });

  it("registers canonical global capabilities on initialization", () => {
    const capabilities = CapabilityRegistry.listCapabilities();
    expect(capabilities.length).toBeGreaterThanOrEqual(15);

    const ids = capabilities.map((c) => c.id);
    expect(ids).toContain("global.web.search");
    expect(ids).toContain("global.web.read_page");
    expect(ids).toContain("global.data.transform");
    expect(ids).toContain("global.data.sort");
    expect(ids).toContain("global.data.filter");
    expect(ids).toContain("global.data.extract");

    for (const cap of capabilities) {
      expect(cap.effect).toBe("read");
      expect(cap.owner).toBe("lazy-agent-service");
      expect(cap.timeout_ms).toBeGreaterThan(0);
    }
  });

  it("validates valid global and app-namespaced capabilities in profile whitelist", () => {
    const validWhitelist = [
      "global.web.search",
      "global.data.sort",
      "html_notes.notes.create",
      "html_notes.canvas.upsert_widget",
      "trading.orders.submit",
      "mcp__lazy-tool-service__news_search",
    ];

    const validation = CapabilityRegistry.validateProfileCapabilities(validWhitelist);
    expect(validation.valid).toBe(true);
    expect(validation.unauthorized).toHaveLength(0);
  });

  it("rejects nonexistent global capabilities and malformed tool identifiers", () => {
    const invalidWhitelist = [
      "global.web.search",
      "global.nonexistent_hack_tool",
      "malformed-no-dot-or-prefix",
      "global.execute_arbitrary_code",
    ];

    const validation = CapabilityRegistry.validateProfileCapabilities(invalidWhitelist);
    expect(validation.valid).toBe(false);
    expect(validation.unauthorized).toContain("global.nonexistent_hack_tool");
    expect(validation.unauthorized).toContain("malformed-no-dot-or-prefix");
    expect(validation.unauthorized).toContain("global.execute_arbitrary_code");
  });

  it("ProfileRegistry rejects profile manifest granting nonexistent capability", () => {
    const badProfileData = {
      profile_id: "malicious-profile",
      version: "1.0.0",
      role: "attacker",
      system_prompt: "Exploit system",
      model_constraints: {
        default_model: "llama-3-8b",
        allowed_models: ["llama-3-8b"],
        allowed_providers: ["vllm-shim"],
      },
      tool_policy: {
        mode: "STRICT_WHITELIST",
        whitelist: ["global.unauthorized_privileged_call"],
      },
      budget_limits: {
        max_tokens: 1000,
        max_tool_calls: 5,
        max_duration_ms: 10000,
      },
      retention_class: "EPHEMERAL",
    };

    expect(() => {
      ProfileRegistry.validateProfileSchema(badProfileData);
    }).toThrow(/grants nonexistent or unauthorized capability: global\.unauthorized_privileged_call/);
  });

  describe("Pure Data Capabilities Execution", () => {
    it("executes global.data.sort deterministically ascending and descending", async () => {
      const items = [
        { name: "C", score: 30 },
        { name: "A", score: 90 },
        { name: "B", score: 50 },
      ];

      const ascRes = await GlobalCapabilityExecutor.execute("global.data.sort", {
        items,
        key: "score",
        direction: "asc",
      });
      expect(ascRes.success).toBe(true);
      expect((ascRes.result as any).items.map((i: any) => i.score)).toEqual([30, 50, 90]);

      const descRes = await GlobalCapabilityExecutor.execute("global.data.sort", {
        items,
        key: "score",
        direction: "desc",
      });
      expect(descRes.success).toBe(true);
      expect((descRes.result as any).items.map((i: any) => i.score)).toEqual([90, 50, 30]);
    });

    it("executes global.data.filter with comparison operators", async () => {
      const items = [
        { ticker: "AAPL", price: 150, sector: "tech" },
        { ticker: "XOM", price: 110, sector: "energy" },
        { ticker: "MSFT", price: 300, sector: "tech" },
      ];

      const filterRes = await GlobalCapabilityExecutor.execute("global.data.filter", {
        items,
        predicate: { field: "sector", op: "eq", value: "tech" },
      });
      expect(filterRes.success).toBe(true);
      expect((filterRes.result as any).count).toBe(2);
      expect((filterRes.result as any).items.map((i: any) => i.ticker)).toEqual(["AAPL", "MSFT"]);

      const priceRes = await GlobalCapabilityExecutor.execute("global.data.filter", {
        items,
        predicate: { field: "price", op: "gt", value: 120 },
      });
      expect(priceRes.success).toBe(true);
      expect((priceRes.result as any).count).toBe(2);
      expect((priceRes.result as any).items.map((i: any) => i.ticker)).toEqual(["AAPL", "MSFT"]);
    });

    it("executes global.data.transform for picking, renaming, and aggregations", async () => {
      const items = [
        { id: 1, old_val: 10, sensitive: "secret" },
        { id: 2, old_val: 20, sensitive: "secret" },
        { id: 3, old_val: 30, sensitive: "secret" },
      ];

      const transformRes = await GlobalCapabilityExecutor.execute("global.data.transform", {
        input: items,
        operations: [
          { op: "pick", fields: ["id", "old_val"] },
          { op: "rename", mapping: { old_val: "score" } },
          { op: "aggregate", aggregate_key: "score", aggregate_type: "sum" },
        ],
      });

      expect(transformRes.success).toBe(true);
      const res = transformRes.result as any;
      expect(res.operations_applied).toBe(3);
      expect(res.output.score).toBe(60);
      expect(res.output.aggregate_type).toBe("sum");
      expect(res.output.count).toBe(3);
    });

    it("executes global.data.extract with regex patterns", async () => {
      const text = "Contact support at help@company.com or sales@company.org. Order ref #12345.";
      const extractRes = await GlobalCapabilityExecutor.execute("global.data.extract", {
        text,
        patterns: {
          emails: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
          order_ids: "#\\d+",
        },
      });

      expect(extractRes.success).toBe(true);
      const entities = (extractRes.result as any).entities;
      expect(entities.emails).toContain("help@company.com");
      expect(entities.emails).toContain("sales@company.org");
      expect(entities.order_ids).toContain("#12345");
    });

    it("fails safely when given unknown capability ID", async () => {
      const res = await GlobalCapabilityExecutor.execute("global.unknown_action", {});
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("UNKNOWN_CAPABILITY");
    });
  });
});
