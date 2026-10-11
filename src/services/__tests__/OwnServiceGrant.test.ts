import { describe, expect, it } from "vitest";
import { isOwnServiceTool } from "../AgenticToolResolver.ts";

describe("capability-id action grants stay on this service (audit 284366b)", () => {
  it("accepts bare and own-namespace names, refuses other MCP servers", () => {
    expect(isOwnServiceTool("scrape_url")).toBe(true);
    expect(isOwnServiceTool("mcp__lazy-agent-service__scrape_url")).toBe(true);
    expect(isOwnServiceTool("mcp__lazy-tool-service__scrape_url")).toBe(true);
    expect(isOwnServiceTool("mcp__someone-elses-server__scrape_url")).toBe(false);
  });
});
