import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

describe("Contract Fixtures Schema Conformance Tests", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const contractsDir = path.resolve(testDir, "..", "..", "docs", "contracts");
  const fixturesDir = path.join(contractsDir, "fixtures");
  const schemaPath = path.join(contractsDir, "run-contract-v1.json");
  const globalCapsPath = path.join(contractsDir, "global-capabilities-v1.json");

  it("ensures run-contract-v1.json v1.1.0 schema exists and defines all canonical models", () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    expect(schema.title).toBe("AgentRuntimeContractV1");
    expect(schema.version).toBe("1.1.0");
    expect(schema.definitions.CreateRunRequest).toBeDefined();
    expect(schema.definitions.RunEvent).toBeDefined();
    expect(schema.definitions.RunResult).toBeDefined();
    expect(schema.definitions.ToolEffect).toBeDefined();
    expect(schema.definitions.ToolCall).toBeDefined();
    expect(schema.definitions.ToolResult).toBeDefined();
    expect(schema.definitions.EvidenceRecord).toBeDefined();
    expect(schema.definitions.ContextReceipt).toBeDefined();
  });

  it("ensures global-capabilities-v1.json exists and registers all 6 global capabilities", () => {
    expect(fs.existsSync(globalCapsPath)).toBe(true);
    const capsDoc = JSON.parse(fs.readFileSync(globalCapsPath, "utf-8"));
    expect(capsDoc.version).toBe("1.1.0");
    expect(capsDoc.capabilities).toHaveLength(6);

    const capIds = capsDoc.capabilities.map((c: any) => c.id);
    expect(capIds).toContain("global.web.search");
    expect(capIds).toContain("global.web.read_page");
    expect(capIds).toContain("global.data.transform");
    expect(capIds).toContain("global.data.sort");
    expect(capIds).toContain("global.data.filter");
    expect(capIds).toContain("global.data.extract");

    for (const cap of capsDoc.capabilities) {
      expect(cap.owner).toBe("lazy-agent-service");
      expect(cap.effect).toBe("read");
      expect(cap.timeout_ms).toBeGreaterThan(0);
      expect(cap.parameters).toBeDefined();
      expect(cap.parameters.type).toBe("object");
    }
  });

  it("validates all 10 fixtures exist and follow canonical contract structure", () => {
    const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(10);

    const requiredFixtures = [
      "successful-no-tool-run.json",
      "streaming-chat-run.json",
      "successful-tool-call-run.json",
      "denied-tool-call-run.json",
      "retryable-provider-failure-run.json",
      "malformed-provider-event-run.json",
      "cancellation-run.json",
      "deadline-timeout-run.json",
      "worker-partial-failure-run.json",
      "idempotency-race-replay-run.json",
    ];

    for (const reqFile of requiredFixtures) {
      expect(files).toContain(reqFile);
      const content = JSON.parse(fs.readFileSync(path.join(fixturesDir, reqFile), "utf-8"));
      expect(content.contract_version).toBe("1.1.0");
      expect(content.fixture_id).toBeDefined();
      expect(content.description).toBeDefined();
      expect(content.request).toBeDefined();
      expect(content.events).toBeInstanceOf(Array);
      expect(content.result).toBeDefined();
      expect(content.result.run_id).toBeDefined();
      expect(content.result.status).toBeDefined();
      expect(["admitted", "running", "completed", "failed", "cancelled", "timed_out"]).toContain(
        content.result.status,
      );

      for (const evt of content.events) {
        expect(evt.id).toBeDefined();
        expect(evt.run_id).toBeDefined();
        expect(evt.type).toBeDefined();
        expect(evt.timestamp).toBeDefined();
        expect(evt.data).toBeDefined();
      }
    }
  });
});
