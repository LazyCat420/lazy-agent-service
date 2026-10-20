/**
 * Per-domain experience library R — port of harness2/core/library.py.
 *
 *   <root>/<domain>/INDEX.md
 *   <root>/<domain>/harnesses/<task>/harness/<rel>   the full adopted tree
 *   <root>/<domain>/harnesses/<task>/EXPERIENCE.md   why picked + lesson
 *
 * Retrieval is by construction: a domain directory only holds same-domain entries. The
 * whole tree is carried, never a summary.
 */
import fs from "node:fs";
import path from "node:path";
import { assertNoGraderVerdicts, onSurface, skillNames, ALWAYS_ON, type Tree } from "./HarnessTree.ts";

export interface Experience {
  cue: string;
  lesson: string;
  evidence: string;
  confidence?: string;
  edits?: string;
}

export const DEFAULT_LIBRARY_ROOT = path.resolve(process.cwd(), "runtime-data", "harness2");

export function hasExperience(exp: Partial<Experience> | null | undefined): exp is Experience {
  return Boolean(exp) && (["cue", "lesson", "evidence"] as const).every((key) => typeof exp![key] === "string" && exp![key]!.trim());
}

const slug = (s: string) => s.replace(/[/\\]/g, "__").replace(/[^A-Za-z0-9_.-]+/g, "-") || "unknown";

/** Upper bound on library text handed to one proposer stage. */
const CONTEXT_CHAR_CAP = 60_000;

function inventory(tree: Tree): string {
  const skills = skillNames(tree).length;
  const onChars = ALWAYS_ON.reduce((n, rel) => n + (tree[rel]?.length || 0), 0);
  return `${skills ? `${skills} skills` : "always-on edits only"}; ${onChars.toLocaleString("en-US")} always-on chars`;
}

function readTree(dir: string): Tree {
  const tree: Tree = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else {
        const rel = path.relative(dir, abs).split(path.sep).join("/");
        if (onSurface(rel)) tree[rel] = fs.readFileSync(abs, "utf8");
      }
    }
  };
  walk(dir);
  return tree;
}

export class Library {
  readonly dir: string;

  constructor(readonly domain: string, root: string = process.env.HARNESS2_LIBRARY_PATH || DEFAULT_LIBRARY_ROOT) {
    this.dir = path.join(root, slug(domain.trim() || "unknown"));
  }

  get index(): string {
    return path.join(this.dir, "INDEX.md");
  }

  entryDir(taskId: string): string {
    return path.join(this.dir, "harnesses", slug(taskId));
  }

  entries(): string[] {
    const d = path.join(this.dir, "harnesses");
    return fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  }

  treeOf(taskId: string): Tree {
    return readTree(path.join(this.entryDir(taskId), "harness"));
  }

  /** Store one adopted harness + why; returns null (and writes nothing) without an experience. */
  add(taskId: string, harness: Tree, opts: { why?: string; label?: string; experience?: Partial<Experience> | null }): string | null {
    const exp = opts.experience;
    if (!hasExperience(exp)) return null;
    assertNoGraderVerdicts(harness);
    assertNoGraderVerdicts({ "EXPERIENCE.md": JSON.stringify(exp) + (opts.why || "") });
    const d = this.entryDir(taskId);
    fs.rmSync(path.join(d, "harness"), { recursive: true, force: true });
    for (const [rel, text] of Object.entries(harness)) {
      const abs = path.join(d, "harness", rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, "utf8");
    }
    const lines = [`# ${taskId}`, "", `- adopted: \`${opts.label || "?"}\``, `- components: ${inventory(harness)}`, ""];
    if (opts.why?.trim()) lines.push("## Why this was chosen", opts.why.trim(), "");
    if (exp.edits?.trim()) lines.push("## What each edit did", exp.edits.trim(), "");
    lines.push("## Transferable lesson");
    for (const f of ["cue", "lesson", "evidence", "confidence"] as const) {
      if (exp[f]?.trim()) lines.push(`- **${f}**: ${exp[f]!.trim().replace(/\n+/g, " ")}`);
    }
    fs.writeFileSync(path.join(d, "EXPERIENCE.md"), lines.join("\n") + "\n", "utf8");
    this.rebuildIndex();
    return d;
  }

  rebuildIndex(): string {
    const rows = [
      `# Library — ${this.domain}`,
      "",
      "Each entry is an earlier task in THIS domain whose harness was chosen, stored with its FULL component tree " +
        "and why it was picked. Browse this index, then use the entries relevant to the matter in front of you.",
      "",
    ];
    const names = this.entries();
    if (!names.length) rows.push("_(empty — this is the first task in this domain)_");
    for (const name of names) {
      const exp = path.join(this.dir, "harnesses", name, "EXPERIENCE.md");
      const cue = fs.existsSync(exp) ? /^- \*\*cue\*\*: (.*)$/m.exec(fs.readFileSync(exp, "utf8"))?.[1] : undefined;
      rows.push(`## \`harnesses/${name}/\``, `- harness: ${inventory(readTree(path.join(this.dir, "harnesses", name, "harness")))}`);
      if (cue) rows.push(`- cue:     ${cue}`);
      rows.push("");
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.index, rows.join("\n"), "utf8");
    return this.index;
  }

  /**
   * The library as proposer evidence, or "" when the domain has no experience yet
   * (upstream `context_dir`). Entries are newest-last; the oldest are dropped past the cap.
   */
  contextText(): string {
    const names = this.entries().filter((n) => fs.existsSync(path.join(this.dir, "harnesses", n, "EXPERIENCE.md")));
    if (!names.length || !fs.existsSync(this.index)) return "";
    const blocks = names.map((name) => {
      const d = path.join(this.dir, "harnesses", name);
      const tree = readTree(path.join(d, "harness"));
      const files = Object.keys(tree).sort().map((rel) => `<file path="${rel}">\n${tree[rel]}\n</file>`).join("\n");
      return `## Entry ${name}\n\n${fs.readFileSync(path.join(d, "EXPERIENCE.md"), "utf8")}\n### Adopted harness\n\n${files}`;
    });
    const head = fs.readFileSync(this.index, "utf8");
    while (blocks.length > 1 && head.length + blocks.join("\n\n").length > CONTEXT_CHAR_CAP) blocks.shift();
    return `${head}\n\n${blocks.join("\n\n")}`;
  }
}
