/**
 * tool_schemas.json has exactly one generator: scripts/export_tool_schemas.py.
 * These tests keep the committed flat file in step with the shards and pin the
 * rules other repos rely on (trading-service / trading-client call the exporter
 * with --out and filter on owner_app). See trading-client ch.47 (two-writer
 * problem, fixed 2026-10-22).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const EXPORTER = path.join(ROOT, "scripts", "export_tool_schemas.py");
const tmp = mkdtempSync(path.join(tmpdir(), "tool-schemas-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const run = (...args: string[]) => spawnSync("python3", [EXPORTER, ...args], { cwd: ROOT, encoding: "utf8" });

describe("export_tool_schemas.py (single generator)", () => {
  it("committed tool_schemas.json matches the shards (--check)", () => {
    const r = run("--check");
    expect(r.stderr + r.stdout).toContain("up to date");
    expect(r.status).toBe(0);
  });

  it("--out writes only the given path, byte-identical to the committed copy", () => {
    const before = readFileSync(path.join(ROOT, "tool_schemas.json"), "utf8");
    const out = path.join(tmp, "tool_schemas.json");
    execFileSync("python3", [EXPORTER, "--out", out], { cwd: ROOT });
    expect(readFileSync(out, "utf8")).toBe(before);
    expect(readFileSync(path.join(ROOT, "tool_schemas.json"), "utf8")).toBe(before);
  });

  it("every entry carries owner_app and the list is sorted by (owner_app, name)", () => {
    const tools = JSON.parse(readFileSync(path.join(ROOT, "tool_schemas.json"), "utf8")) as Array<{ name: string; owner_app?: string }>;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => !t.owner_app).map((t) => t.name)).toEqual([]);
    const keys = tools.map((t) => `${t.owner_app}\u0000${t.name}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("advertises --out to callers and rejects unknown flags", () => {
    expect(run("--supports-out").status).toBe(0);
    const bad = run("--definitely-not-a-flag");
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("unknown argument");
  });
});
