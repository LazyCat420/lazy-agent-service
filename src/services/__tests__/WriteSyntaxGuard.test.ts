import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkSyntax,
  captureWriteSyntaxGuard,
  enforceWriteSyntaxGuard,
} from "../WriteSyntaxGuard.ts";

describe("checkSyntax", () => {
  it("accepts valid JSON", () => {
    expect(checkSyntax("config.json", '{"ok": true, "n": 2}')).toBeNull();
  });

  it("rejects invalid JSON with the parser error", () => {
    const error = checkSyntax("config.json", '{"ok":');
    expect(typeof error).toBe("string");
    expect(error!.length).toBeGreaterThan(0);
  });

  it("accepts valid TypeScript", () => {
    expect(checkSyntax("a.ts", 'const x: string = "1";\nexport default x;\n')).toBeNull();
  });

  it("rejects invalid TS/JS-family syntax via transpileModule diagnostics", () => {
    expect(checkSyntax("a.ts", "function {")).toMatch(/Identifier expected/);
    expect(checkSyntax("a.mjs", "const const const")).toBeTruthy();
    expect(checkSyntax("a.cts", "class {")).toBeTruthy();
  });

  it("does not flag type errors (syntax-level only)", () => {
    expect(checkSyntax("a.ts", "const x: string = 1;\n")).toBeNull();
  });

  it("returns null for unguarded extensions", () => {
    expect(checkSyntax("notes.txt", "<<< not code >>>")).toBeNull();
  });
});

describe("write guard integration (mocked write tool)", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "write-guard-"));
    file = path.join(dir, "config.json");
    fs.writeFileSync(file, '{"valid": true}\n');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reverts an invalid .json write and returns a rejection observation", () => {
    const capture = captureWriteSyntaxGuard({ path: file }, "write");
    expect(capture).toEqual({ filePath: file, previous: '{"valid": true}\n' });

    // The mocked write tool commits an invalid write...
    fs.writeFileSync(file, '{"broken":');
    const observation = { ok: true, path: file, bytes_written: 10 };

    // ...and the chokepoint guard reverts it and rejects the observation.
    const result = enforceWriteSyntaxGuard(capture, observation);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Write rejected:");
    expect(result as string).toContain(file);
    expect(result as string).toContain("Fix the syntax and retry.");
    expect(fs.readFileSync(file, "utf8")).toBe('{"valid": true}\n');
  });

  it("passes a valid write through unchanged", () => {
    const capture = captureWriteSyntaxGuard({ path: file }, "write");
    fs.writeFileSync(file, '{"updated": 1}\n');
    const observation = { ok: true, path: file };
    expect(enforceWriteSyntaxGuard(capture, observation)).toBe(observation);
    expect(fs.readFileSync(file, "utf8")).toBe('{"updated": 1}\n');
  });

  it("passes error observations through without guarding", () => {
    const capture = captureWriteSyntaxGuard({ path: file }, "write");
    fs.writeFileSync(file, '{"broken":');
    const observation = { error: "disk full", is_error: true };
    expect(enforceWriteSyntaxGuard(capture, observation)).toBe(observation);
  });

  it("captures nothing for non-write effects, unguarded extensions, or unavailable paths", () => {
    expect(captureWriteSyntaxGuard({ path: file }, "read")).toBeNull();
    expect(captureWriteSyntaxGuard({ path: file }, "destructive")).toBeNull();
    expect(captureWriteSyntaxGuard({}, "write")).toBeNull();

    const txt = path.join(dir, "notes.txt");
    fs.writeFileSync(txt, "not code <<<");
    expect(captureWriteSyntaxGuard({ path: txt }, "write")).toBeNull();

    expect(captureWriteSyntaxGuard({ path: path.join(dir, "missing.json") }, "write")).toBeNull();
  });

  it("reverts an invalid TS write for a locally available file", () => {
    const tsFile = path.join(dir, "mod.ts");
    fs.writeFileSync(tsFile, "export const ok = 1;\n");
    const capture = captureWriteSyntaxGuard({ filePath: tsFile }, "write");
    fs.writeFileSync(tsFile, "function {\n");
    const result = enforceWriteSyntaxGuard(capture, { ok: true });
    expect(result).toContain("does not parse");
    expect(fs.readFileSync(tsFile, "utf8")).toBe("export const ok = 1;\n");
  });
});
