import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("Contract Fixtures Schema Conformance Tests", () => {
  const fixturesDir = path.resolve(process.cwd(), "docs", "contracts", "fixtures");
  const schemaPath = path.resolve(process.cwd(), "docs", "contracts", "run-contract-v1.json");

  it("ensures run-contract-v1.json schema exists and parses", () => {
    expect(fs.existsSync(schemaPath)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
    expect(schema.title).toBe("AgentRuntimeContractV1");
    expect(schema.definitions.CreateRunRequest).toBeDefined();
    expect(schema.definitions.RunEvent).toBeDefined();
    expect(schema.definitions.RunResult).toBeDefined();
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
      expect(content.contract_version).toBe("1.0.0");
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
