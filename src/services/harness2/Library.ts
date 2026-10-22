/**
 * Per-domain experience library R — port of harness2/core/library.py.
 *
 *   <root>/<domain>/INDEX.md
 *   <root>/<domain>/harnesses/<task>/harness/<rel>   the full adopted tree
 *   <root>/<domain>/harnesses/<task>/EXPERIENCE.md   why picked + lesson + stored time
 *
 * Retrieval is by construction: a domain directory only holds same-domain entries. The
 * whole tree is carried, never a summary.
 */
import fs from "node:fs";
import path from "node:path";
import { assertNoGraderVerdicts, onSurface, renderTree, skillNames, ALWAYS_ON, type Tree } from "./HarnessTree.ts";

export interface Experience {
  cue: string;
  lesson: string;
  evidence: string;
  confidence?: string;
  edits?: string;
}

export const DEFAULT_LIBRARY_ROOT = path.resolve(process.cwd(), "runtime-data", "harness2");

/** The library root: the caller's, else HARNESS2_LIBRARY_PATH, else runtime-data/harness2. */
export const libraryRootOf = (root?: string) => root || process.env.HARNESS2_LIBRARY_PATH || DEFAULT_LIBRARY_ROOT;

export function hasExperience(exp: Partial<Experience> | null | undefined): exp is Experience {
  return Boolean(exp) && (["cue", "lesson", "evidence"] as const).every((key) => typeof exp![key] === "string" && exp![key]!.trim());
}

/** Directory-safe name. Leading dots are replaced, so "..", "." and ".x" never resolve outside. */
export const slug = (s: string) =>
  s.trim().replace(/[/\\]/g, "__").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^\.+/, "_") || "unknown";

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

  constructor(readonly domain: string, root?: string) {
    this.dir = path.join(libraryRootOf(root), slug(domain));
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

  /** When an entry was stored: its `stored:` line, else EXPERIENCE.md's mtime; 0 when unknown. */
  storedAt(name: string): number {
    const exp = path.join(this.dir, "harnesses", name, "EXPERIENCE.md");
    if (!fs.existsSync(exp)) return 0;
    const stamp = /^- stored: (\S+)$/m.exec(fs.readFileSync(exp, "utf8"))?.[1];
    return (stamp && Date.parse(stamp)) || fs.statSync(exp).mtimeMs;
  }

  /** Entries oldest first (ties by name): the order the context cap evicts in. */
  entriesByAge(): string[] {
    return this.entries()
      .map((name) => ({ name, at: this.storedAt(name) }))
      .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
      .map((e) => e.name);
  }

  /** Upstream `forget`: drop these tasks' entries and rebuild INDEX.md; returns the names removed. */
  forget(taskIds: string[]): string[] {
    const removed = taskIds.map(slug).filter((name) => fs.existsSync(path.join(this.dir, "harnesses", name)));
    for (const name of removed) fs.rmSync(path.join(this.dir, "harnesses", name), { recursive: true, force: true });
    if (removed.length) this.rebuildIndex();
    return removed;
  }

  treeOf(taskId: string): Tree {
    return readTree(path.join(this.entryDir(taskId), "harness"));
  }

  /** Store one adopted harness + why; returns null (and writes nothing) without an experience. */
  add(taskId: string, harness: Tree, opts: { why?: string; label?: string; experience?: Partial<Experience> | null }): string | null {
    const exp = opts.experience;
    if (!hasExperience(exp)) return null;
    assertNoGraderVerdicts(harness);
    // Raw text, not JSON: JSON.stringify escapes the quotes inside a marker such as "pass_rate".
    const text = [exp.cue, exp.lesson, exp.evidence, exp.confidence, exp.edits, opts.why].filter(Boolean).join("\n");
    assertNoGraderVerdicts({ "EXPERIENCE.md": text });
    const d = this.entryDir(taskId);
    fs.rmSync(path.join(d, "harness"), { recursive: true, force: true });
    for (const [rel, text] of Object.entries(harness)) {
      const abs = path.join(d, "harness", rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, "utf8");
    }
    const lines = [
      `# ${taskId}`,
      "",
      `- adopted: \`${opts.label || "?"}\``,
      `- components: ${inventory(harness)}`,
      `- stored: ${new Date().toISOString()}`,
      "",
    ];
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

  /** INDEX.md text for these entries, in the given order. */
  indexText(names: string[], note = ""): string {
    const rows = [
      `# Library — ${this.domain}`,
      "",
      "Each entry is an earlier task in THIS domain whose harness was chosen, stored with its FULL component tree " +
        "and why it was picked. Browse this index, then use the entries relevant to the matter in front of you.",
      "",
    ];
    if (note) rows.push(note, "");
    if (!names.length) rows.push("_(empty — this is the first task in this domain)_");
    for (const name of names) {
      const exp = path.join(this.dir, "harnesses", name, "EXPERIENCE.md");
      const cue = fs.existsSync(exp) ? /^- \*\*cue\*\*: (.*)$/m.exec(fs.readFileSync(exp, "utf8"))?.[1] : undefined;
      rows.push(`## \`harnesses/${name}/\``, `- harness: ${inventory(readTree(path.join(this.dir, "harnesses", name, "harness")))}`);
      if (cue) rows.push(`- cue:     ${cue}`);
      rows.push("");
    }
    return rows.join("\n");
  }

  rebuildIndex(): string {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.index, this.indexText(this.entriesByAge()), "utf8");
    return this.index;
  }

  /**
   * The library as proposer evidence, or "" when it holds no experience for this task (upstream
   * `context_dir`). `exclude` drops entries, such as the current task's own, from the index and the
   * blocks (upstream `retain`: only earlier tasks). Entries are oldest first, and the oldest are
   * dropped past the cap.
   */
  contextText(opts: { exclude?: string[] } = {}): string {
    const skip = new Set((opts.exclude ?? []).map(slug));
    let names = this.entriesByAge().filter((n) => !skip.has(n) && fs.existsSync(path.join(this.dir, "harnesses", n, "EXPERIENCE.md")));
    if (!names.length) return "";
    const block = (name: string) => {
      const d = path.join(this.dir, "harnesses", name);
      return `## Entry ${name}\n\n${fs.readFileSync(path.join(d, "EXPERIENCE.md"), "utf8")}\n### Adopted harness\n\n${renderTree(readTree(path.join(d, "harness")))}`;
    };
    const blocks = names.map(block);
    let dropped = 0;
    const render = () => {
      const note = dropped ? `_${dropped} older entr${dropped === 1 ? "y was" : "ies were"} left out to fit the context cap._` : "";
      return `${this.indexText(names, note)}\n\n${blocks.join("\n\n")}`;
    };
    while (blocks.length > 1 && render().length > CONTEXT_CHAR_CAP) {
      blocks.shift();
      names = names.slice(1);
      dropped++;
    }
    return render();
  }
}
