#!/usr/bin/env python3
"""Render documentation/chapters/*.md into a single self-contained index.html.

Stdlib only, on purpose. This script is meant to be copied verbatim into any
repo in the workspace, and a docs build that needs `pip install` first is a
docs build that quietly stops happening.

Usage:
    python3 documentation/build_docs.py            # write index.html
    python3 documentation/build_docs.py --check    # exit 1 if index.html is stale
    python3 documentation/build_docs.py --status   # front matter as JSON

Chapters are ordered by filename; the leading NN- is a sort key and is stripped
from the display title. The title comes from the file's first H1.

A chapter FILES ITSELF. Open it with a front-matter block and there is nothing
else to edit — no manifest, no renumbering, no HTML:

    ---
    part: Plans
    status: approved
    updated: 2026-08-10
    review-by: 2026-09-09
    ---

    # What this plan does

That is the whole contract. `part` decides where it lands on the page; `status`
and the dates are what the daily audit reads to decide what has gone stale.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

DOCS_DIR = Path(__file__).resolve().parent
CHAPTERS_DIR = DOCS_DIR / "chapters"
OUTPUT = DOCS_DIR / "index.html"
# Benchmark write-ups: detail moved out of a chapter to keep it under its size
# cap. Rendered after the last chapter as an appendix, never counted as
# chapters. A project with no bench/ directory renders exactly as before.
BENCH_DIR = DOCS_DIR / "bench"
BENCH_PART = "Benchmark write-ups"

# The ticket ledger. One file per PROJECT, not per repo: the trading cycle spans
# trading-client, trading-service, lazy-agent-service and scraper-service, and a
# single cycle bug can need all four. `owner` on each ticket says which repo it
# belongs to. Other projects (games, html-notes, music-player) carry their own
# ledger next to their own chapters; nothing is shared between projects.
TICKETS = DOCS_DIR / "tickets.jsonl"
LEDGER_CHAPTER = "11-tickets.md"

# The two graph sources rendered as views 1 and 2. They are validated by
# check_graphs.py; the builder only renders them and maps tickets onto their
# nodes, so a graph edit never needs an HTML edit.
EXEC_GRAPH = DOCS_DIR / "execution_graph.json"
DATA_GRAPH = DOCS_DIR / "data_flow_graph.json"

# The workspace project bar. `active_slug` is this repo's own entry, so the bar
# can mark "Trading Cycle" as the page you are already on.
PROJECTS_JSON = DOCS_DIR / "_projects.json"
ACTIVE_PROJECT = "trading-cycle"

# Where a `repo:path` covers entry is resolved from. Relative to the repo root
# that holds this documentation/ tree.
REPO_ROOTS = {
    "trading-client": ".",
    "trading-service": "../trading-service",
    "scraper-service": "../../../agents/scraper-service",
    "lazy-agent-service": "../../../agents/lazy-agent-service",
    "spark-console": "../../../agents/spark-console",
    "tts-service": "../../../agents/tts-service",
    "prism-service": "../../../prism-service",
}
OPEN_STATUSES = {"open", "in_progress", "blocked"}
CLOSED_STATUSES = {"verified", "closed"}
SEVERITY_ORDER = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}

# This same builder is copied into every project's documentation/ tree, so it
# must not assume it is rendering the trading cycle's page. `--docs-dir`
# repoints every path above; `--project` (or the _projects.json match below)
# says which project bar entry to mark active.
WORKSPACE_PROJECTS = "finance/trading/trading-client/documentation/_projects.json"


def _use_docs_dir(docs_dir: Path) -> None:
    """Point every DOCS_DIR-derived path at another project's documentation/."""
    global DOCS_DIR, CHAPTERS_DIR, BENCH_DIR, OUTPUT, TICKETS, EXEC_GRAPH, DATA_GRAPH
    global PROJECTS_JSON, _DOCS_DIR
    DOCS_DIR = docs_dir
    CHAPTERS_DIR = DOCS_DIR / "chapters"
    BENCH_DIR = DOCS_DIR / "bench"
    OUTPUT = DOCS_DIR / "index.html"
    TICKETS = DOCS_DIR / "tickets.jsonl"
    EXEC_GRAPH = DOCS_DIR / "execution_graph.json"
    DATA_GRAPH = DOCS_DIR / "data_flow_graph.json"
    PROJECTS_JSON = DOCS_DIR / "_projects.json"
    _DOCS_DIR = DOCS_DIR


def _sun_root() -> Path | None:
    """The workspace root, i.e. the nearest ancestor directory named sun/."""
    for candidate in (DOCS_DIR, *DOCS_DIR.parents):
        if candidate.name == "sun":
            return candidate
    return None


def _detect_project() -> str | None:
    """Slug of the project whose index.html this build produces.

    The manifest is looked for in this documentation/ tree first, then in the
    workspace's own trading-client documentation/ tree, and the page path is
    matched against each entry's `source_html`."""
    manifests = [DOCS_DIR / "_projects.json"]
    root = _sun_root()
    if root is not None:
        manifests.append(root / WORKSPACE_PROJECTS)
    target = (DOCS_DIR / "index.html").resolve()
    for manifest in manifests:
        if not manifest.is_file() or root is None:
            continue
        try:
            projects = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(projects, list):
            continue
        for p in projects:
            if not isinstance(p, dict) or not p.get("slug") or not p.get("source_html"):
                continue
            if (root / p["source_html"]).resolve() == target:
                return p["slug"]
    return None


# ---------------------------------------------------------------- inline pass

_DOCS_DIR = Path(__file__).resolve().parent
_IMAGE_TYPES = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}


def _img_src(src: str) -> str:
    """A local figure under documentation/ becomes a data URI. The served page
    is one file (/documentation returns index.html; nothing under artifacts/
    is routed), so a relative src 404s there. Anything remote, missing, or
    outside documentation/ is left as written."""
    if "://" in src or src.startswith(("/", "data:")):
        return src
    path = (_DOCS_DIR / src).resolve()
    mime = _IMAGE_TYPES.get(path.suffix.lower())
    if not mime or _DOCS_DIR not in path.parents or not path.is_file():
        return src
    import base64
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


_BENCH_LINK = re.compile(r"^(?:\.\./|documentation/)?bench/([^/#]+)\.md(?:#(.+))?$")


def _bench_id(stem: str) -> str:
    return f"bench-{_slug(stem)}"


def _href(target: str) -> str:
    """A link to a rendered bench write-up becomes its anchor on this page;
    every other target is returned unchanged."""
    m = _BENCH_LINK.match(target)
    if not m or not (BENCH_DIR / f"{m.group(1)}.md").is_file():
        return target
    section = _bench_id(m.group(1))
    return f"#{section}-{m.group(2)}" if m.group(2) else f"#{section}"


def _inline(text: str) -> str:
    """Inline markdown → HTML. Code spans are extracted FIRST and restored last
    so that emphasis/link syntax inside `code` is never interpreted."""
    spans: list[str] = []

    def _stash(m: re.Match) -> str:
        spans.append(m.group(1))
        return f"\x00{len(spans) - 1}\x00"

    text = re.sub(r"`([^`]+)`", _stash, text)
    text = html.escape(text, quote=False)

    # Images before links — same leading bracket, different meaning.
    text = re.sub(
        r"!\[([^\]]*)\]\(([^)\s]+)\)",
        lambda m: f'<img src="{html.escape(_img_src(html.unescape(m.group(2))), quote=True)}" alt="{m.group(1)}">',
        text,
    )
    text = re.sub(
        r"\[([^\]]+)\]\(([^)\s]+)\)",
        lambda m: f'<a href="{html.escape(_href(m.group(2)), quote=True)}">{m.group(1)}</a>',
        text,
    )
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<em>\1</em>", text)
    text = re.sub(r"~~([^~]+)~~", r"<del>\1</del>", text)

    def _restore(m: re.Match) -> str:
        return f"<code>{html.escape(spans[int(m.group(1))], quote=False)}</code>"

    return re.sub(r"\x00(\d+)\x00", _restore, text)


def _slug(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", re.sub(r"<[^>]+>", "", text)).strip().lower()
    return re.sub(r"[-\s]+", "-", s) or "section"


# ----------------------------------------------------------------- block pass

def _table(rows: list[str]) -> str:
    def cells(line: str) -> list[str]:
        return [c.strip() for c in line.strip().strip("|").split("|")]

    head, body = cells(rows[0]), [cells(r) for r in rows[2:]]
    aligns = []
    for spec in cells(rows[1]):
        left, right = spec.startswith(":"), spec.endswith(":")
        aligns.append("center" if left and right else "right" if right else "left")

    def row(cs: list[str], tag: str) -> str:
        out = []
        for i, c in enumerate(cs):
            a = aligns[i] if i < len(aligns) else "left"
            style = f' style="text-align:{a}"' if a != "left" else ""
            out.append(f"<{tag}{style}>{_inline(c)}</{tag}>")
        return "<tr>" + "".join(out) + "</tr>"

    return (
        '<div class="scroll-x"><table><thead>'
        + row(head, "th")
        + "</thead><tbody>"
        + "".join(row(r, "td") for r in body)
        + "</tbody></table></div>"
    )


def render_markdown(md: str, toc: list[dict] | None = None, id_prefix: str = "") -> str:
    """Markdown subset → HTML: headings, lists, tables, fenced code, quotes,
    horizontal rules, raw HTML blocks (used for inline SVG figures).
    `id_prefix` namespaces heading ids (bench write-ups repeat chapter headings)."""
    lines = md.replace("\r\n", "\n").split("\n")
    out: list[str] = []
    i = 0
    list_stack: list[str] = []

    def close_lists(to: int = 0) -> None:
        while len(list_stack) > to:
            out.append(f"</{list_stack.pop()}>")

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # Fenced code — verbatim, never inline-processed.
        if stripped.startswith("```"):
            close_lists()
            lang = stripped[3:].strip()
            buf: list[str] = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            cls = f' class="lang-{html.escape(lang, quote=True)}"' if lang else ""
            out.append(
                '<div class="scroll-x"><pre><code' + cls + ">"
                + html.escape("\n".join(buf), quote=False)
                + "</code></pre></div>"
            )
            continue

        # Raw HTML block (inline SVG figures live here) — passed through as-is.
        if stripped.startswith(("<figure", "<svg", "<div", "<details", "<section")):
            close_lists()
            buf = [line]
            tag = re.match(r"<(\w+)", stripped).group(1)
            depth = len(re.findall(rf"<{tag}\b", line)) - len(re.findall(rf"</{tag}>", line))
            while depth > 0 and i + 1 < len(lines):
                i += 1
                buf.append(lines[i])
                depth += len(re.findall(rf"<{tag}\b", lines[i]))
                depth -= len(re.findall(rf"</{tag}>", lines[i]))
            out.append("\n".join(buf))
            i += 1
            continue

        if not stripped:
            close_lists()
            i += 1
            continue

        if re.fullmatch(r"(-{3,}|\*{3,}|_{3,})", stripped):
            close_lists()
            out.append("<hr>")
            i += 1
            continue

        m = re.match(r"(#{1,6})\s+(.*)", stripped)
        if m:
            close_lists()
            level, text = len(m.group(1)), _inline(m.group(2).strip())
            anchor = id_prefix + _slug(m.group(2))
            if toc is not None and level == 2:
                toc.append({"id": anchor, "text": re.sub(r"<[^>]+>", "", text)})
            out.append(f'<h{level} id="{anchor}">{text}</h{level}>')
            i += 1
            continue

        # Table: header row + delimiter row.
        if (
            "|" in line
            and i + 1 < len(lines)
            and re.fullmatch(r"\s*\|?[\s:|-]+\|[\s:|-]*", lines[i + 1])
            and "-" in lines[i + 1]
        ):
            close_lists()
            buf = [lines[i], lines[i + 1]]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                buf.append(lines[i])
                i += 1
            out.append(_table(buf))
            continue

        if stripped.startswith(">"):
            close_lists()
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            out.append(f"<blockquote>{render_markdown(chr(10).join(buf))}</blockquote>")
            continue

        m = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)", line)
        if m:
            indent, marker, content = len(m.group(1)) // 2, m.group(2), m.group(3)
            kind = "ul" if marker in "-*+" else "ol"

            # Lazy continuation: a wrapped list item keeps flowing on the next
            # line without a marker. Without this the item is cut in half — the
            # list closes, the tail becomes a stray paragraph, and a fresh list
            # opens after it. Prose is wrapped at ~80 columns throughout these
            # chapters, so almost every multi-clause bullet hits this.
            i += 1
            parts = [content]
            while i < len(lines):
                nxt = lines[i]
                if not nxt.strip():
                    break
                if re.match(r"^\s*([-*+]|\d+[.)])\s+", nxt):
                    break
                if re.match(
                    r"\s*(#{1,6}\s|```|>|---|<(figure|svg|div|details|section))", nxt
                ):
                    break
                parts.append(nxt.strip())
                i += 1

            while len(list_stack) > indent + 1:
                out.append(f"</{list_stack.pop()}>")
            if len(list_stack) == indent + 1 and list_stack[-1] != kind:
                out.append(f"</{list_stack.pop()}>")
            while len(list_stack) < indent + 1:
                list_stack.append(kind)
                out.append(f"<{kind}>")
            out.append(f"<li>{_inline(' '.join(parts))}</li>")
            continue

        # Paragraph — consume until a blank line or a block-level starter.
        close_lists()
        buf = [stripped]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(
            r"\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s|<(figure|svg|div|details|section))", lines[i]
        ):
            buf.append(lines[i].strip())
            i += 1
        out.append(f"<p>{_inline(' '.join(buf))}</p>")

    close_lists()
    return "\n".join(out)


# --------------------------------------------------------------- page assembly

CSS = """
:root{
  --ground:#f6f7f9; --panel:#ffffff; --panel-2:#eef1f5;
  --ink:#1b2027; --ink-soft:#5a6472; --rule:#d8dee7;
  --accent:#0f6f6c; --accent-soft:#e2f0ef;
  --ok:#1f7a4d; --warn:#8a6100; --bad:#a32b25;
  --ok-bg:#e4f2ea; --warn-bg:#fbf0d8; --bad-bg:#f9e5e3;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.04);
}
@media (prefers-color-scheme:dark){
  :root{
    --ground:#111419; --panel:#181c23; --panel-2:#1f242c;
    --ink:#e5e9ef; --ink-soft:#9aa5b4; --rule:#2b323c;
    --accent:#5ec8c0; --accent-soft:#16302f;
    --ok:#6ed49b; --warn:#e8bb5c; --bad:#f2867e;
    --ok-bg:#14291f; --warn-bg:#2c2413; --bad-bg:#2e1a19;
    --shadow:none;
  }
}
:root[data-theme="dark"]{
  --ground:#111419; --panel:#181c23; --panel-2:#1f242c;
  --ink:#e5e9ef; --ink-soft:#9aa5b4; --rule:#2b323c;
  --accent:#5ec8c0; --accent-soft:#16302f;
  --ok:#6ed49b; --warn:#e8bb5c; --bad:#f2867e;
  --ok-bg:#14291f; --warn-bg:#2c2413; --bad-bg:#2e1a19;
  --shadow:none;
}
:root[data-theme="light"]{
  --ground:#f6f7f9; --panel:#ffffff; --panel-2:#eef1f5;
  --ink:#1b2027; --ink-soft:#5a6472; --rule:#d8dee7;
  --accent:#0f6f6c; --accent-soft:#e2f0ef;
  --ok:#1f7a4d; --warn:#8a6100; --bad:#a32b25;
  --ok-bg:#e4f2ea; --warn-bg:#fbf0d8; --bad-bg:#f9e5e3;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.04);
}

*{box-sizing:border-box}
body{
  margin:0; background:var(--ground); color:var(--ink);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-size:16px; line-height:1.65; -webkit-font-smoothing:antialiased;
}
.masthead{
  border-bottom:1px solid var(--rule); background:var(--panel);
  padding:2.2rem 1.5rem 1.6rem;
}
.masthead-inner{max-width:1180px;margin:0 auto;display:flex;flex-wrap:wrap;gap:1rem;align-items:baseline;justify-content:space-between}
.masthead h1{
  font-family:ui-serif,Charter,"Bitstream Charter",Georgia,serif;
  font-size:1.9rem;font-weight:600;margin:0;letter-spacing:-.01em;text-wrap:balance;
}
.masthead .sub{color:var(--ink-soft);font-size:.9rem;margin:.35rem 0 0}
.stamp{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.75rem;
  color:var(--ink-soft);background:var(--panel-2);border:1px solid var(--rule);
  border-radius:999px;padding:.3rem .7rem;white-space:nowrap;
}
/* Freshness — "updated 5 minutes ago", computed in the browser so it stays
   true long after the build. Empty until the script fills it, so a page opened
   with JS off shows nothing rather than a stale or broken label. */
.freshness{display:none}
.freshness:not(:empty){
  display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.68rem;letter-spacing:.02em;color:var(--ink-soft);
  border:1px solid var(--rule);border-radius:999px;padding:.12rem .5rem;
  margin:0 0 .9rem;vertical-align:middle;
}
.freshness.lede:not(:empty){margin:0 .5rem 0 0;border:0;padding:0}
/* Anything changed in the last day is what a returning reader is looking for. */
.freshness.recent:not(:empty){
  color:var(--accent);border-color:var(--accent);background:var(--accent-soft);font-weight:600;
}
.freshness.badge:not(:empty){
  font-size:0.65rem; background:var(--accent); color:var(--panel);
  padding:0.12rem 0.45rem; border-radius:4px; font-weight:700; border:none;
  margin-left:auto; line-height:1; vertical-align:middle; letter-spacing:0.04em;
}
/* Status — the lifecycle a chapter is in. A plan that says "approved" and a
   plan that says "shipped" are different documents, and a reader who cannot
   tell them apart at a glance will act on the wrong one. */
.statusbar{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 1.1rem}
.status,.meta-pill{
  display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:.66rem;letter-spacing:.04em;text-transform:uppercase;font-weight:700;
  border-radius:4px;padding:.16rem .45rem;line-height:1.35;white-space:nowrap;
}
.meta-pill{
  text-transform:none;font-weight:500;letter-spacing:.02em;
  color:var(--ink-soft);background:var(--panel-2);border:1px solid var(--rule);
}
.status.s-ok{color:var(--ok);background:var(--ok-bg);border:1px solid var(--ok)}
.status.s-warn{color:var(--warn);background:var(--warn-bg);border:1px solid var(--warn)}
.status.s-bad{color:var(--bad);background:var(--bad-bg);border:1px solid var(--bad)}
.status.s-muted{color:var(--ink-soft);background:var(--panel-2);border:1px solid var(--rule)}
/* Overdue is set by the browser, never baked into the build — see _status_bar. */
.meta-pill.overdue{color:var(--bad);background:var(--bad-bg);border-color:var(--bad);font-weight:700}
nav.toc .status{
  margin-left:auto;font-size:.58rem;padding:.08rem .3rem;letter-spacing:.02em;
  border-radius:3px;
}
nav.toc a.chapter .status + .freshness.badge{margin-left:.25rem}
.shell{max-width:1180px;margin:0 auto;padding:2rem 1.5rem 5rem;display:grid;grid-template-columns:220px minmax(0,1fr);gap:2.6rem;align-items:start}
/* The sidebar scrolls ITSELF. It is `position:sticky`, so without a height
   bound it grows past the bottom of the window and the only way to reach its
   last entries is to scroll the article — which moves the thing you were
   trying to navigate away from you. With nine chapters and their sub-headings
   the list is comfortably taller than a laptop screen, so this was the normal
   case, not an edge one.
   `overscroll-behavior:contain` stops a scroll that reaches the end of the
   list from continuing into the page behind it. */
nav.toc{
  position:sticky;top:1.5rem;font-size:.86rem;
  max-height:calc(100vh - 3rem);overflow-y:auto;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:var(--rule) transparent;
  padding-right:.3rem;
}
nav.toc::-webkit-scrollbar{width:8px}
nav.toc::-webkit-scrollbar-track{background:transparent}
nav.toc::-webkit-scrollbar-thumb{background:var(--rule);border-radius:4px}
nav.toc:hover::-webkit-scrollbar-thumb{background:var(--ink-soft)}
nav.toc h2{
  font-size:.7rem;text-transform:uppercase;letter-spacing:.09em;
  color:var(--ink-soft);margin:0 0 .7rem;font-weight:600;
  font-family:system-ui,sans-serif;border:0;padding:0;
}
nav.toc ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.1rem}
nav.toc a{
  display:block;padding:.32rem .6rem;border-radius:6px;color:var(--ink-soft);
  text-decoration:none;border-left:2px solid transparent;
}
nav.toc a:hover{color:var(--ink);background:var(--panel-2)}
nav.toc a.chapter{color:var(--ink);font-weight:550;display:flex;gap:.5rem;align-items:baseline}
nav.toc a.sub{padding-left:2.05rem;font-size:.82rem}
/* Part headings group the chapters. Not links — a part is a shelf, not a page,
   and a heading that looks clickable but is not is worse than a plain one. */
nav.toc li.part{
  font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;font-weight:700;
  color:var(--ink-soft);font-family:system-ui,sans-serif;
  margin:1.15rem 0 .35rem;padding:0 .6rem;
}
nav.toc li.part:first-child{margin-top:0}
nav.toc li.part{cursor:default}
/* Part dividers in the body. Deliberately NOT a panel like a chapter — a part
   is a label on the pile, and dressing it as a card makes it read as content. */
.part-divider{margin:2.6rem 0 1.1rem;padding:0 .2rem}
.part-divider:first-child{margin-top:0}
.part-divider h2{
  font-size:.78rem;text-transform:uppercase;letter-spacing:.13em;font-weight:700;
  color:var(--accent);font-family:system-ui,sans-serif;
  margin:0 0 .3rem;padding:0 0 .55rem;border-bottom:1px solid var(--rule);
}
.part-divider p{margin:.55rem 0 0;color:var(--ink-soft);font-size:.9rem}
nav.toc a.chapter .num{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.74rem;
  color:var(--ink-soft);font-weight:600;min-width:1.05em;text-align:right;flex:none;
}
nav.toc a.chapter:hover .num{color:var(--accent)}
/* Body eyebrow: which part am I in, and which chapter is this. Carries the
   sidebar's context to readers who cannot see the sidebar. */
p.eyebrow{
  font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;font-weight:700;
  color:var(--ink-soft);font-family:system-ui,sans-serif;margin:0 0 .5rem;
}
p.eyebrow .sep{margin:0 .45rem;opacity:.5}
main{min-width:0}
section.chapter{
  background:var(--panel);border:1px solid var(--rule);border-radius:10px;
  padding:1.9rem 2.1rem;margin-bottom:1.5rem;box-shadow:var(--shadow);
}
main h1,main h2,main h3,main h4{
  font-family:ui-serif,Charter,"Bitstream Charter",Georgia,serif;
  letter-spacing:-.01em;text-wrap:balance;
}
main h1{font-size:1.55rem;margin:0 0 1.1rem;padding-bottom:.6rem;border-bottom:1px solid var(--rule);font-weight:600}
main h2{font-size:1.18rem;margin:2.1rem 0 .7rem;font-weight:600}
main h3{font-size:1rem;margin:1.5rem 0 .5rem;font-weight:650}
main h4{font-size:.92rem;margin:1.2rem 0 .4rem;font-weight:650;color:var(--ink-soft)}
main p,main li{max-width:70ch}
main p{margin:0 0 .95rem}
main ul,main ol{margin:0 0 1rem;padding-left:1.35rem;display:flex;flex-direction:column;gap:.3rem}
main li{margin:0}
a{color:var(--accent)}
a:focus-visible,nav.toc a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
code{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.87em;
  background:var(--panel-2);border:1px solid var(--rule);border-radius:4px;padding:.08em .35em;
}
pre{
  background:var(--panel-2);border:1px solid var(--rule);border-radius:8px;
  padding:.9rem 1.05rem;margin:0 0 1rem;overflow-x:auto;
}
pre code{background:none;border:0;padding:0;font-size:.83rem;line-height:1.6}
.scroll-x{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;width:100%;font-size:.89rem;margin:0 0 1rem;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--rule);padding:.55rem .7rem;text-align:left;vertical-align:top}
th{
  font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;
  color:var(--ink-soft);font-weight:600;border-bottom:1.5px solid var(--rule);white-space:nowrap;
}
tbody tr:last-child td{border-bottom:0}
blockquote{
  margin:0 0 1rem;padding:.7rem 1.1rem;border-left:3px solid var(--accent);
  background:var(--accent-soft);border-radius:0 6px 6px 0;color:var(--ink);
}
blockquote p:last-child{margin-bottom:0}
hr{border:0;border-top:1px solid var(--rule);margin:1.8rem 0}
figure{margin:1.4rem 0;padding:1.1rem;background:var(--panel-2);border:1px solid var(--rule);border-radius:8px;overflow-x:auto}
figure svg{max-width:100%;height:auto;display:block;margin:0 auto;color:var(--ink)}
figcaption{margin-top:.8rem;font-size:.82rem;color:var(--ink-soft);text-align:center;max-width:none}
.status-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:.8rem;margin:0 0 1.4rem}
.tile{border:1px solid var(--rule);border-radius:8px;padding:.8rem .9rem;background:var(--panel);border-left-width:3px}
.tile .label{font-size:.7rem;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-soft);font-weight:600}
.tile .value{font-size:1.32rem;font-weight:650;margin-top:.15rem;font-variant-numeric:tabular-nums;font-family:ui-serif,Charter,Georgia,serif}
.tile .note{font-size:.78rem;color:var(--ink-soft);margin-top:.15rem}
.tile.ok{border-left-color:var(--ok)} .tile.ok .value{color:var(--ok)}
.tile.warn{border-left-color:var(--warn)} .tile.warn .value{color:var(--warn)}
.tile.bad{border-left-color:var(--bad)} .tile.bad .value{color:var(--bad)}
.pill{
  display:inline-block;font-size:.7rem;font-weight:650;letter-spacing:.04em;
  text-transform:uppercase;padding:.16rem .5rem;border-radius:999px;
  border:1px solid transparent;white-space:nowrap;vertical-align:.06em;
}
.pill.ok{background:var(--ok-bg);color:var(--ok);border-color:var(--ok)}
.pill.warn{background:var(--warn-bg);color:var(--warn);border-color:var(--warn)}
.pill.bad{background:var(--bad-bg);color:var(--bad);border-color:var(--bad)}
.pill.info{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
@media (max-width:900px){
  .shell{grid-template-columns:1fr;gap:1.4rem;padding:1.2rem 1rem 3rem}
  /* Narrow screens stack the nav above the article, so it is no longer sticky
     and must NOT keep a viewport height cap — that would put a second scroll
     region at the top of the page. */
  nav.toc{
    position:static;border-bottom:1px solid var(--rule);padding-bottom:1rem;
    max-height:none;overflow:visible;
  }
  nav.toc ol{flex-direction:row;flex-wrap:wrap;gap:.3rem}
  section.chapter{padding:1.3rem 1.15rem}
}
@media print{
  body{background:#fff}
  nav.toc,.stamp{display:none}
  .shell{display:block;max-width:none;padding:0}
  section.chapter{border:0;box-shadow:none;page-break-inside:avoid;padding:0 0 1.5rem}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

/* ------------------------------------------------------- 4-view client
   Views 1-3 are graph/ticket surfaces rendered outside `main`, so they carry
   their own heading scale. View 4 is the chapter shell and keeps its layout. */
.view-switcher{
  display:flex;flex-wrap:wrap;gap:.4rem;padding:.75rem 1.5rem;
  background:var(--panel);border-bottom:1px solid var(--rule);
}
.view-tab{
  font:inherit;font-size:.82rem;font-weight:550;cursor:pointer;
  padding:.42rem .85rem;border-radius:8px;
  border:1px solid var(--rule);background:var(--panel-2);color:var(--ink-soft);
}
.view-tab:hover{color:var(--ink);border-color:var(--ink-soft)}
.view-tab.active{background:var(--accent);border-color:var(--accent);color:#fff}
.view-tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.doc-view{display:none}
.doc-view.active{display:block}
.doc-view:not(#view-ref){max-width:1180px;margin:0 auto;padding:2rem 1.5rem 5rem}
.doc-view h1{
  font-family:ui-serif,Charter,"Bitstream Charter",Georgia,serif;
  font-size:1.55rem;font-weight:600;letter-spacing:-.01em;
  margin:0 0 .55rem;padding-bottom:.6rem;border-bottom:1px solid var(--rule);
}
.doc-view h2{
  font-family:ui-serif,Charter,"Bitstream Charter",Georgia,serif;
  font-size:1.18rem;font-weight:600;margin:1.9rem 0 .7rem;
}
.stat-chart{margin:1rem 0 1.6rem;padding:.8rem 1rem;background:var(--panel);border:1px solid var(--rule);border-radius:10px}.stat-chart figcaption{font-size:.8rem;color:var(--ink-soft);margin-top:.3rem}
.view-lede{color:var(--ink-soft);max-width:78ch;margin:0 0 1.4rem}
.muted{color:var(--ink-soft)}
.pill.muted{background:var(--panel-2);color:var(--ink-soft);border-color:var(--rule)}
button.pill{font-family:inherit;cursor:pointer}
/* Graph canvases: the SVG scales to the column, so a wide diagram stays legible
   on a laptop without a second scroll region. */
.graph-canvas svg{width:100%;height:auto;display:block;color:var(--ink);min-width:640px}
.graph-node .gn-box{fill:var(--panel);stroke:var(--rule);stroke-width:1.5}
.graph-node:hover .gn-box{stroke-width:2.5}
.graph-node.gn-bad .gn-box{stroke:var(--bad)}
.graph-node.gn-warn .gn-box{stroke:var(--warn)}
.graph-node.gn-ok .gn-box{stroke:var(--ok)}
.gn-stage{font-size:8.5px;font-weight:650;fill:var(--ink)}
.gn-repo{font-size:7.5px;fill:var(--ink-soft);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.gn-pill{fill:var(--panel-2);stroke:none}
.gn-bad .gn-pill{fill:var(--bad-bg)}
.gn-warn .gn-pill{fill:var(--warn-bg)}
.gn-ok .gn-pill{fill:var(--ok-bg)}
.gn-pill-text{font-size:7.5px;font-weight:650;fill:var(--ink-soft)}
.gn-bad .gn-pill-text{fill:var(--bad)}
.gn-warn .gn-pill-text{fill:var(--warn)}
.gn-ok .gn-pill-text{fill:var(--ok)}
.edges .edge{fill:none;stroke-width:1.4}
.edge-control{stroke:var(--accent)}
.edge-parallel{stroke:var(--accent);stroke-dasharray:6 4;stroke-width:1.6}
.edge-async{stroke:var(--ink-soft);stroke-dasharray:2 4;stroke-width:1.1;opacity:.85}
.mk-control path,.mk-parallel path{fill:var(--accent)}
.mk-async path{fill:var(--ink-soft)}
.col-rule{stroke:var(--rule);stroke-dasharray:3 5;stroke-width:1}
.layer-head{
  font-size:8.5px;font-weight:700;fill:var(--accent);
  text-transform:uppercase;letter-spacing:.06em;
}
.store-node .st-box{fill:var(--panel);stroke:var(--rule);stroke-width:1.5}
.store-node:hover .st-box{stroke:var(--accent);stroke-width:2.2}
.st-id{font-size:9px;font-weight:650;fill:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.st-kind,.st-join{font-size:7px;fill:var(--ink-soft);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.st-pill{fill:var(--panel-2)}
.st-pill.st-warn{fill:var(--warn-bg)}
.st-pill.st-ok{fill:var(--ok-bg)}
.st-pill-text{font-size:7px;font-weight:650;fill:var(--ink-soft)}
.st-pill.st-warn + .st-pill-text{fill:var(--warn)}
.actor-node .act-box{fill:var(--accent-soft);stroke:var(--accent);stroke-width:1}
.actor-node:hover .act-box{stroke-width:2.2}
.act-label{font-size:6.8px;fill:var(--accent);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.flow-edge{fill:none;stroke:var(--ink-soft);stroke-width:1.1;opacity:.85}
.mk-flow path{fill:var(--ink-soft)}
/* Stage cards: one per node, ordered by stage, so a reader can go straight to
   the stage they care about instead of hunting inside the diagram. */
.node-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:.9rem;margin:0 0 1.6rem}
.node-card{
  background:var(--panel);border:1px solid var(--rule);border-left-width:3px;
  border-radius:8px;padding:.9rem 1rem;box-shadow:var(--shadow);
}
.node-card.gn-bad{border-left-color:var(--bad)}
.node-card.gn-warn{border-left-color:var(--warn)}
.node-card.gn-ok{border-left-color:var(--ok)}
.node-card-head{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin:0 0 .65rem}
.node-card-head h3{
  flex:1 1 100%;margin:0;font-size:.9rem;font-weight:650;
  font-family:ui-serif,Charter,Georgia,serif;
}
.node-badge{font-family:inherit;cursor:pointer}
.node-facts{margin:0;display:grid;gap:.35rem;font-size:.8rem}
.node-facts div{display:grid;grid-template-columns:118px minmax(0,1fr);gap:.5rem;align-items:baseline}
.node-facts dt{
  color:var(--ink-soft);font-size:.66rem;text-transform:uppercase;
  letter-spacing:.05em;font-weight:650;
}
.node-facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.node-facts dd.covers code{font-size:.7rem;margin:0 .25rem .25rem 0;display:inline-block}
/* Ticket hub: filters are one row on a desktop and wrap on a phone; the table
   hides rows with `hidden`, never re-renders, so the DOM is the source of truth. */
.ticket-filters{
  display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-end;
  background:var(--panel);border:1px solid var(--rule);border-radius:8px;
  padding:.8rem .9rem;margin:0 0 1rem;
}
.ticket-filters label{
  display:flex;flex-direction:column;gap:.2rem;
  font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;
  color:var(--ink-soft);font-weight:650;
}
.ticket-filters label.wide{flex:1 1 260px}
.ticket-filters select,.ticket-filters input{
  font:inherit;font-size:.82rem;padding:.3rem .45rem;
  border:1px solid var(--rule);border-radius:6px;
  background:var(--panel);color:var(--ink);
}
.ticket-filters button{
  font:inherit;font-size:.8rem;padding:.36rem .85rem;cursor:pointer;
  border:1px solid var(--rule);border-radius:6px;
  background:var(--panel-2);color:var(--ink);
}
#flt-count{font-size:.75rem;color:var(--ink-soft);margin-left:auto;font-family:ui-monospace,Menlo,monospace}
#tickets-table{font-size:.8rem}
#tickets-table td{vertical-align:top}
.tck-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:650;font-size:.75rem;margin-right:.25rem}
.tck-node{font-family:ui-monospace,Menlo,monospace;cursor:pointer}
.tck-title{font-weight:550;margin-bottom:.15rem}
.tck-area{font-size:.7rem;margin-top:.15rem}
.tck-res{font-size:.75rem;max-width:36ch}
.tck-res code{font-size:.72rem}
tr.tck-row[hidden]{display:none}
@media (max-width:900px){
  .view-switcher{padding:.6rem 1rem}
  .doc-view:not(#view-ref){padding:1.2rem 1rem 3rem}
  .node-facts div{grid-template-columns:1fr}
  .ticket-filters label{flex:1 1 100%}
}
"""

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
{project_bar}
<header class="masthead">
  <div class="masthead-inner">
    <div>
      <h1>{title}</h1>
      <p class="sub">{subtitle}</p>
    </div>
    <span class="stamp"><span class="freshness lede" data-ts="{newest}"></span>generated {stamp} · do not edit by hand</span>
  </div>
</header>
{tabs}
{view_exec}
{view_data}
{view_tickets}
<section class="doc-view" id="view-ref">
<div class="shell">
  <nav class="toc" aria-label="Contents">
    <h2>Contents</h2>
    <ol>{nav}</ol>
  </nav>
  <main>{body}</main>
</div>
</section>
<script>
/* Relative "updated N ago" labels. Rendered at VIEW time, not build time: a
   relative string baked into static HTML is wrong the moment it is written,
   and the generation stamp answers a different question ("when did the builder
   run") from the one a reader has ("is this current"). */
(function () {{
  var UNITS = [
    ["year", 31536000], ["month", 2592000], ["week", 604800],
    ["day", 86400], ["hour", 3600], ["minute", 60]
  ];
  function ago(seconds) {{
    for (var i = 0; i < UNITS.length; i++) {{
      var n = Math.floor(seconds / UNITS[i][1]);
      if (n >= 1) return n + " " + UNITS[i][0] + (n === 1 ? "" : "s") + " ago";
    }}
    return "just now";
  }}
  function paint() {{
    var now = Date.now();
    var nodes = document.querySelectorAll(".freshness[data-ts]");
    for (var i = 0; i < nodes.length; i++) {{
      var raw = nodes[i].getAttribute("data-ts");
      var when = raw ? new Date(raw) : null;
      if (!when || isNaN(when.getTime())) continue;
      var seconds = (now - when.getTime()) / 1000;
      if (seconds < 0) seconds = 0;
      var isRecent = seconds < 86400 * 2; /* 2 days */
      nodes[i].classList.toggle("recent", isRecent);
      
      if (nodes[i].classList.contains("badge")) {{
         nodes[i].textContent = isRecent ? "UPDATED" : "";
         if (!isRecent) nodes[i].style.display = "none";
      }} else if (nodes[i].classList.contains("lede")) {{
         nodes[i].textContent = "last commit " + ago(seconds) + " · ";
      }} else {{
         nodes[i].textContent = "last commit " + ago(seconds);
      }}
      nodes[i].title = when.toLocaleString();
    }}
    /* A review date that has passed is the whole point of writing one down.
       Decided here, not at build time — the page is rebuilt when a chapter
       CHANGES, which is never the case for the chapters that go stale. */
    var due = document.querySelectorAll(".meta-pill.review[data-review]");
    for (var j = 0; j < due.length; j++) {{
      var by = new Date(due[j].getAttribute("data-review") + "T23:59:59");
      if (isNaN(by.getTime())) continue;
      var late = now > by.getTime();
      due[j].classList.toggle("overdue", late);
      if (late) {{
        var days = Math.floor((now - by.getTime()) / 86400000);
        due[j].textContent = "review overdue by " + days + " day" + (days === 1 ? "" : "s");
      }}
    }}
  }}
  paint();
  /* A page left open overnight must not still claim "updated 2 minutes ago". */
  setInterval(paint, 60000);
}})();
</script>
<script>
/* 4-view client. One file, four surfaces. The hash addresses a view
   (#view-exec …), and a chapter anchor is an address INSIDE view 4, so a
   deep link like #decisions switches to Reference and scrolls to it instead
   of dead-ending on a hidden section. */
(function () {{
  var VIEWS = ["exec", "data", "tickets", "ref"];
  var ACTIVE_STATUSES = ["open", "in_progress", "blocked"];

  function byId(id) {{ return document.getElementById(id); }}

  function setHash(hash) {{
    try {{
      if (location.hash !== hash) history.replaceState(null, "", hash);
    }} catch (e) {{
      /* file:// pages refuse replaceState in some browsers; the view still
         switches, only the address bar does not follow. */
      location.hash = hash;
    }}
  }}

  function switchDocView(name) {{
    if (VIEWS.indexOf(name) < 0) return;
    var views = document.querySelectorAll(".doc-view");
    for (var i = 0; i < views.length; i++) {{
      views[i].classList.toggle("active", views[i].id === "view-" + name);
    }}
    var tabs = document.querySelectorAll(".view-tab");
    for (var j = 0; j < tabs.length; j++) {{
      tabs[j].classList.toggle("active", tabs[j].getAttribute("data-view") === name);
    }}
    setHash("#view-" + name);
  }}

  function filterTicketsByNode(nodeId) {{
    switchDocView("tickets");
    var sel = byId("flt-node");
    if (sel) sel.value = nodeId || "";
    applyTicketFilters();
  }}

  function applyTicketFilters() {{
    var node = byId("flt-node") ? byId("flt-node").value : "";
    var status = byId("flt-status") ? byId("flt-status").value : "";
    var sev = byId("flt-sev") ? byId("flt-sev").value : "";
    var owner = byId("flt-owner") ? byId("flt-owner").value : "";
    var qEl = byId("flt-q");
    var q = qEl ? qEl.value.trim().toLowerCase() : "";
    var rows = document.querySelectorAll("#tickets-table tr.tck-row");
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {{
      var row = rows[i];
      var ok = true;
      if (node && row.getAttribute("data-node") !== node) ok = false;
      var st = row.getAttribute("data-status");
      if (ok && status) {{
        if (status === "active") ok = ACTIVE_STATUSES.indexOf(st) >= 0;
        else ok = st === status;
      }}
      if (ok && sev && row.getAttribute("data-sev") !== sev) ok = false;
      if (ok && owner && row.getAttribute("data-owner") !== owner) ok = false;
      if (ok && q && row.textContent.toLowerCase().indexOf(q) < 0) ok = false;
      row.hidden = !ok;
      if (ok) shown++;
    }}
    var count = byId("flt-count");
    if (count) count.textContent = "Showing " + shown + " of " + rows.length + " tickets";
  }}

  function resetTicketFilters() {{
    ["flt-node", "flt-status", "flt-sev", "flt-owner"].forEach(function (id) {{
      var el = byId(id);
      if (el) el.value = "";
    }});
    var q = byId("flt-q");
    if (q) q.value = "";
    applyTicketFilters();
  }}

  function applyHash() {{
    var h = location.hash || "";
    if (h.indexOf("#view-") === 0 && VIEWS.indexOf(h.slice(6)) >= 0) {{
      switchDocView(h.slice(6));
      return;
    }}
    if (h.length > 1) {{
      var target = byId(h.slice(1));
      if (target && target.closest(".doc-view")) {{
        var ownerView = target.closest(".doc-view");
        var name = ownerView.id.replace(/^view-/, "");
        switchDocView(name);
        /* Keep the deep link: switchDocView rewrote the hash to #view-<name>. */
        setHash(h);
        target.scrollIntoView({{ block: "start" }});
        return;
      }}
    }}
    switchDocView("exec");
  }}

  window.switchDocView = switchDocView;
  window.filterTicketsByNode = filterTicketsByNode;
  window.applyTicketFilters = applyTicketFilters;
  window.resetTicketFilters = resetTicketFilters;

  window.addEventListener("hashchange", applyHash);
  applyHash();
}})();
</script>
</body>
</html>
"""


def _last_touched(path: Path) -> str:
    """ISO-8601 timestamp for when this chapter last actually changed.

    A generation stamp says when the BUILDER ran, which is not the question a
    reader has — they want to know whether what they are reading is current.
    Uncommitted edits win over the commit date (the file on disk is the newer
    truth); otherwise the last commit that touched the file. Falls back to
    mtime so this works in a tarball with no git.
    """
    try:
        dirty = subprocess.run(
            ["git", "-C", str(DOCS_DIR), "status", "--porcelain", "--", str(path)],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        if not dirty:
            out = subprocess.run(
                ["git", "-C", str(DOCS_DIR), "log", "-1", "--format=%cI", "--", str(path)],
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
            if out:
                return out
    except Exception:
        pass
    return datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()


# ---------------------------------------------------------------- front matter
#
# A chapter may open with a `---` block. It is deliberately NOT parsed as YAML:
# this script is stdlib-only so it can be copied into any repo without an
# install step, and every field we need is a `key: value` scalar.
#
#     ---
#     part: Plans
#     status: approved
#     updated: 2026-08-10
#     ---
#
# `part` is the field that matters mechanically — it is how a chapter files
# ITSELF. Writing a chapter is writing one file: no manifest to edit, no
# renumbering, no HTML. The rest is metadata the page renders as a badge and the
# daily audit reads to decide what has gone stale.

FRONT_KEYS = {"part", "status", "updated", "review-by", "owner", "supersedes", "type", "covers", "last-verified"}

# The lifecycle, and the tone each state renders in. `approved` and
# `in-progress` are the two the staleness check cares about: they are claims
# about the FUTURE, and a claim about the future rots. `shipped`, `superseded`
# and `abandoned` are claims about the past and never go stale.
STATUS_TONE = {
    "approved": "warn",
    "in-progress": "warn",
    "draft": "warn",
    "blocked": "bad",
    "shipped": "ok",
    "verified": "ok",
    "superseded": "muted",
    "superseded-in-part": "muted",
    "abandoned": "muted",
    "reference": "muted",
}

LIVE_STATUSES = {"approved", "in-progress", "blocked"}


def parse_front(md: str) -> tuple[dict, str]:
    """Split a leading ``---`` block off a chapter. Returns (meta, body).

    A chapter with no block parses to ``({}, md)``, so this is backwards
    compatible with every chapter already written.
    """
    if not md.startswith("---"):
        return {}, md
    m = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", md, re.S)
    if not m:
        return {}, md
    meta: dict[str, str] = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip().lower()] = value.strip().strip("'\"")
    return meta, md[m.end():]


def _check_front(name: str, meta: dict) -> None:
    """Reject a front-matter block that is subtly wrong rather than absent.

    A MISSPELLED key is the dangerous case: `stat:` instead of `status:` reads
    as a chapter with no status, which silently drops it out of the staleness
    audit forever. Absent is fine; wrong is not.
    """
    unknown = sorted(set(meta) - FRONT_KEYS)
    if unknown:
        raise SystemExit(
            f"{name}: unknown front-matter key(s): {', '.join(unknown)}.\n"
            f"Known keys: {', '.join(sorted(FRONT_KEYS))}."
        )
    status = meta.get("status")
    if status and status not in STATUS_TONE:
        raise SystemExit(
            f"{name}: status '{status}' is not one of "
            f"{', '.join(sorted(STATUS_TONE))}."
        )
    for key in ("updated", "review-by"):
        value = meta.get(key)
        if value and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise SystemExit(f"{name}: {key} must be YYYY-MM-DD, got '{value}'.")


def _status_bar(meta: dict) -> str:
    """Render the front matter as a row of pills under the chapter title.

    ``review-by`` is emitted as ``data-review`` rather than a pre-computed
    verdict: a page built in June cannot know that its July review date has
    passed, and this page is rebuilt only when a chapter changes — which is
    precisely when nobody is looking at the ones that went stale. The browser
    decides, so the label is true whenever it is read. Same reasoning as the
    freshness marks.
    """
    pills = []
    status = (meta.get("status") or "").strip()
    if status:
        tone = STATUS_TONE.get(status, "muted")
        pills.append(
            f'<span class="status s-{tone}">{html.escape(status)}</span>'
        )
    if meta.get("owner"):
        pills.append(f'<span class="meta-pill">{html.escape(meta["owner"])}</span>')
    if meta.get("updated"):
        pills.append(
            f'<span class="meta-pill">updated {html.escape(meta["updated"])}</span>'
        )
    if meta.get("review-by"):
        pills.append(
            f'<span class="meta-pill review" data-review="'
            f'{html.escape(meta["review-by"], quote=True)}">'
            f'review by {html.escape(meta["review-by"])}</span>'
        )
    if meta.get("supersedes"):
        pills.append(
            f'<span class="meta-pill">supersedes {html.escape(meta["supersedes"])}</span>'
        )
    if not pills:
        return ""
    return f'<p class="statusbar">{"".join(pills)}</p>'


def _load_parts(records: list[dict]) -> list[dict]:
    """Group chapters into named parts.

    A chapter normally declares its OWN part in front matter (``part: Plans``).
    That is the point: adding a chapter is adding one file, and the page
    reorganises itself around it. ``chapters/_parts.json`` stays supported and,
    when present, fixes the ORDER of the parts and carries their blurbs; it may
    also list chapters explicitly to pin their order within a part, which is how
    the hand-curated repos already read.

    Still **fail-closed**: a chapter that declares no ``part:`` and appears in no
    manifest is a hard build error naming the file, not a silent omission. On
    2026-08-07 a chapter was written, built, deployed and verified present in
    the served bytes while the operator could not find it on the page, and
    hunting that took longer than writing the chapter. A document whose
    navigation can disagree with its own contents is not a document. The same
    applies in reverse: a part listing a file that does not exist fails rather
    than rendering a dead entry.
    """
    import json

    by_name = {r["path"].name: r for r in records}
    manifest = CHAPTERS_DIR / "_parts.json"

    # A repo with no manifest and no front matter anywhere renders as one flat
    # list, exactly as it did before parts existed. This is checked FIRST: the
    # orphan rejection below is what a repo OPTS IN to by naming a part even
    # once, and reaching it here would make the kit uncopyable into a repo that
    # only wants a pile of chapters (braindeadbot-client is one today).
    if not manifest.exists() and not any(r["meta"].get("part") for r in records):
        return [{"part": None, "blurb": "", "chapters": records}]

    spec: list[dict] = []
    if manifest.exists():
        try:
            spec = json.loads(manifest.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise SystemExit(f"{manifest.name} is not valid JSON: {e}")

    grouped: list[dict] = []
    index: dict[str, dict] = {}
    claimed: set[str] = set()

    for entry in spec:
        picked = []
        for filename in entry.get("chapters", []):
            if filename not in by_name:
                raise SystemExit(
                    f"{manifest.name} lists '{filename}' under "
                    f"'{entry.get('part')}', but no such chapter exists."
                )
            if filename in claimed:
                raise SystemExit(f"{manifest.name} lists '{filename}' twice.")
            picked.append(by_name[filename])
            claimed.add(filename)
        group = {
            "part": entry.get("part"),
            "blurb": entry.get("blurb", ""),
            "chapters": picked,
        }
        grouped.append(group)
        if group["part"]:
            index[group["part"].casefold()] = group

    # Everything the manifest did not claim files itself by front matter. A part
    # the manifest never named is created at the end rather than rejected —
    # inventing a part must not require also editing a second file.
    orphans = []
    for record in records:
        name = record["path"].name
        if name in claimed:
            continue
        part = (record["meta"].get("part") or "").strip()
        if not part:
            orphans.append(name)
            continue
        group = index.get(part.casefold())
        if group is None:
            group = {"part": part, "blurb": "", "chapters": []}
            grouped.append(group)
            index[part.casefold()] = group
        group["chapters"].append(record)

    if orphans:
        raise SystemExit(
            "These chapters declare no part, so they would render with no way "
            "to navigate to them:\n  "
            + "\n  ".join(orphans)
            + "\n\nGive each a front-matter block naming its part:\n"
            "  ---\n  part: Plans\n  status: approved\n  updated: YYYY-MM-DD\n  ---"
        )

    return [g for g in grouped if g["chapters"]]


# ------------------------------------------------------------- ticket ledger

def _load_tickets() -> list[dict]:
    """Read the JSONL ledger. A malformed line is skipped and reported by
    check_tickets.py, which is the file that owns schema validation — the
    builder must still render the rest of the board rather than fail the build."""
    if not TICKETS.exists():
        return []
    out = []
    for line in TICKETS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and rec.get("id"):
            out.append(rec)
    return out


def _repo_root(repo: str) -> Path | None:
    """Repo root for a `repo:path` covers entry, or None.

    The built-in REPO_ROOTS table covers the trading cycle's repos. Any other
    project's docs live next to repos that table cannot know about, so the
    workspace layout is searched by name before giving up."""
    root = REPO_ROOTS.get(repo)
    if root:
        candidate = (DOCS_DIR.parent / root).resolve()
        if candidate.is_dir():
            return candidate
    sun_root = _sun_root()
    if sun_root is None:
        return None
    candidates = [
        sun_root / repo,
        sun_root / "games" / repo,
        sun_root / "agents" / repo,
        sun_root / "apps" / repo,
        sun_root / "apps/media" / repo,
        sun_root / "apps/braindeadbot" / repo,
        sun_root / "apps/obsidian" / repo,
        sun_root / "hardware" / repo,
        sun_root / "finance/trading" / repo,
    ]
    if repo in (DOCS_DIR.parent.name, ACTIVE_PROJECT):
        candidates.append(DOCS_DIR.parent)
    for candidate in candidates:
        if candidate.is_dir():
            return candidate.resolve()
    return None


def _repo_last_date(entry: str) -> str | None:
    """Last commit date for a `repo:path` covers entry, or None."""
    repo, sep, path = entry.partition(":")
    if not sep:
        repo, path = "trading-client", entry
    root = _repo_root(repo)
    if root is None:
        return None
    try:
        res = subprocess.run(
            ["git", "-C", str(root), "log", "-1", "--format=%cs", "--", path],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return (res.stdout or "").strip() or None


def _ticket_flags(t: dict, today: str, dates: dict) -> list[str]:
    """STALE = an open ticket nobody has looked at since review_by.
    REGRESSED = a closed ticket whose covered code moved after it was verified."""
    flags = []
    status = t.get("status", "")
    review_by = t.get("review_by") or ""
    if status in OPEN_STATUSES and review_by and review_by < today:
        flags.append("STALE")
    if status in CLOSED_STATUSES:
        verified = t.get("verified_by") or {}
        verified_on = verified.get("last_run") or ""
        if verified_on:
            for entry in t.get("covers") or []:
                last = dates.get(entry) or _repo_last_date(entry)
                dates[entry] = last
                if last and last > verified_on:
                    flags.append("REGRESSED")
                    break
    return flags


def _cell(value: object, limit: int = 120) -> str:
    text = str(value if value is not None else "").replace("|", "\\|").strip()
    return text[:limit] + ("…" if len(text) > limit else "")


def _ticket_board(tickets: list[dict], dates: dict | None = None) -> str:
    """Markdown for the ledger chapter. Generated — never hand-edited."""
    today = datetime.now(timezone.utc).date().isoformat()
    if not tickets:
        return ("# Ticket ledger\n\n"
                "No `tickets.jsonl` yet. Tickets are recorded there, one JSON object per line, "
                "and this page is generated from it by `build_docs.py`.\n")

    if dates is None:
        dates = {}
    by_status: dict[str, int] = {}
    by_sev: dict[str, dict[str, int]] = {}
    for t in tickets:
        st = t.get("status", "?")
        sev = t.get("severity", "?")
        by_status[st] = by_status.get(st, 0) + 1
        bucket = by_sev.setdefault(sev, {"open": 0, "closed": 0})
        if st in OPEN_STATUSES:
            bucket["open"] += 1
        elif st in CLOSED_STATUSES:
            bucket["closed"] += 1

    open_rows = [t for t in tickets if t.get("status") in OPEN_STATUSES]
    closed_rows = [t for t in tickets if t.get("status") in CLOSED_STATUSES]
    other_rows = [t for t in tickets if t.get("status") not in OPEN_STATUSES | CLOSED_STATUSES]

    out = ["# Ticket ledger", "",
           "Generated from `documentation/tickets.jsonl`. Closed tickets stay in the file: "
           "that history is how a problem is looked up again months later.", ""]

    out += ["## Totals", "", "| status | count |", "|---|---|"]
    for st in sorted(by_status):
        out.append(f"| {st} | {by_status[st]} |")
    out += ["", "| severity | open | closed |", "|---|---|---|"]
    for sev in sorted(by_sev, key=lambda s: SEVERITY_ORDER.get(s, 9)):
        out.append(f"| {sev} | {by_sev[sev]['open']} | {by_sev[sev]['closed']} |")

    out += ["", f"## Open work ({len(open_rows)})", ""]
    if not open_rows:
        out += ["Nothing open.", ""]
    for sev in sorted({t.get("severity", "?") for t in open_rows},
                      key=lambda s: SEVERITY_ORDER.get(s, 9)):
        rows = [t for t in open_rows if t.get("severity") == sev]
        rows.sort(key=lambda t: (t.get("area", ""), t.get("id", "")))
        out += [f"### {sev} ({len(rows)})", "",
                "| id | title | status | area | owner | age (d) | flags |",
                "|---|---|---|---|---|---|---|"]
        for t in rows:
            opened = t.get("opened") or ""
            try:
                age = (datetime.fromisoformat(today) - datetime.fromisoformat(opened)).days
            except ValueError:
                age = ""
            flags = " ".join(_ticket_flags(t, today, dates)) or "—"
            out.append(
                f"| {_cell(t.get('id'), 12)} | {_cell(t.get('title'))} | {_cell(t.get('status'), 20)} "
                f"| {_cell(t.get('area'), 20)} | {_cell(t.get('owner'), 24)} | {age} | {flags} |"
            )
        out.append("")

    out += ["", f"## Closed and verified ({len(closed_rows)})", ""]
    if closed_rows:
        out += ["| id | title | severity | closed | verified by |", "|---|---|---|---|---|"]
        for t in sorted(closed_rows, key=lambda t: t.get("id", "")):
            closed_by = t.get("closed_by") or {}
            verified = t.get("verified_by") or {}
            out.append(
                f"| {_cell(t.get('id'), 12)} | {_cell(t.get('title'))} | {_cell(t.get('severity'), 4)} "
                f"| {_cell(closed_by.get('date'), 12)} | {_cell(verified.get('cmd'), 70)} |"
            )
        out.append("")
    else:
        out += ["Nothing closed yet.", ""]

    if other_rows:
        out += [f"## Won't fix / regressed ({len(other_rows)})", "",
                "| id | title | status | reason |", "|---|---|---|---|"]
        for t in other_rows:
            reason = (t.get("closed_by") or {}).get("note") or ""
            out.append(f"| {_cell(t.get('id'), 12)} | {_cell(t.get('title'))} | "
                       f"{_cell(t.get('status'), 20)} | {_cell(reason)} |")
        out.append("")

    out += ["## Legend", "",
            "- **P0** cycle halts or the money path is wrong · **P1** wrong desk data or a broken gate · "
            "**P2** degraded coverage or a wrong dashboard · **P3** debt and cleanup.",
            "- **STALE** open ticket past its `review_by` date — nobody has looked at it since.",
            "- **REGRESSED** closed ticket whose covered code changed after it was verified.",
            "- **age** days since the ticket was opened.", ""]
    return "\n".join(out)


def _read_chapters() -> list[dict]:
    """Parse every chapter once into {path, meta, body}. Front matter is split
    off here so it is never rendered as prose — a chapter that shows its own
    `---` block at the top reads as a bug to whoever opens the page."""
    records = []
    for path in sorted(CHAPTERS_DIR.glob("*.md")):
        if path.name.startswith("_"):
            continue  # _parts.json and friends are configuration, not chapters
        md = path.read_text(encoding="utf-8")
        meta, body = parse_front(md)
        _check_front(path.name, meta)
        records.append({"path": path, "meta": meta, "body": body})
    return records


# ------------------------------------------------------- graph views
#
# The page is a 4-view client: execution graph, data state-flow, live tickets,
# reference. Views 1-3 are rendered here from the two graph JSONs and the
# ledger; view 4 is the chapter body this builder already produced. Nothing in
# this section is hand-written HTML — every count and badge comes from a file.

CLOSED_ALL = CLOSED_STATUSES | {"wontfix", "wont-fix"}

# One column per stage; the column width comes from the graph's own stage count.
EXEC_W, EXEC_H = 1360, 440
EXEC_BOX_W, EXEC_BOX_H, EXEC_GAP = 120, 96, 16

# Data-flow layer 0..5, six columns.
DATA_LAYERS = {
    0: "External & Collectors",
    1: "Cycle Control & Ledger",
    2: "Desk & Telemetry",
    3: "Decisions",
    4: "Execution & Lots",
    5: "Grading & Calibration",
}
DATA_COLS = len(DATA_LAYERS)
DATA_W, DATA_H = 1280, 460
DATA_STORE_W, DATA_STORE_H = 150, 84
DATA_ACTOR_W, DATA_ACTOR_H = 40, 16

AREA_NODE = {
    "board": "board", "gate": "gatekeeper", "preflight": "preflight",
    "grading": "grading", "execution": "execution", "collectors": "collectors",
    "scraper": "collectors", "las-harness": "las_bridge", "context": "phase0",
    "agents": "junior", "infra": "trigger", "dashboard": "trigger",
}

TITLE_NODE = (
    (("debate", "bull", "bear"), "debate"),
    (("fundamental",), "fa"),
    (("quant", "equation", "garch"), "qa"),
    (("valuation",), "va"),
    (("regime",), "regime"),
    (("junior",), "junior"),
    (("phase 0", "phase0", "whiteboard", "ledger"), "phase0"),
    (("board",), "board"),
    (("gatekeeper",), "gatekeeper"),
)


def _load_graph(path: Path) -> dict:
    """A missing or malformed graph is a hard build error: a view that silently
    renders empty is worse than a build that says why it cannot."""
    if not path.exists():
        raise SystemExit(f"{path.name} is missing; views 1-2 are rendered from it.")
    try:
        graph = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path.name} is not valid JSON: {e}")
    if not isinstance(graph, dict):
        raise SystemExit(f"{path.name} must contain a JSON object.")
    return graph


def _ticket_node(t: dict, nodes: list[dict]) -> str:
    """Every ticket lands on exactly one execution node.

    Explicit `node:` wins; then a shared `covers` entry (the node that covers
    the most of them); then a title keyword; then the ticket's area. The point
    is that no ticket is invisible on the graph: an unmapped ticket would be a
    red badge nobody can see, which is the failure mode this page exists to
    prevent.
    """
    ids = {n.get("id") for n in nodes}
    explicit = t.get("node")
    if explicit in ids:
        return explicit

    covers = set(t.get("covers") or [])
    if covers:
        best, best_hits = None, 0
        for n in nodes:
            hits = len(covers & set(n.get("covers") or []))
            if hits > best_hits:
                best, best_hits = n.get("id"), hits
        if best:
            return best

    title = (t.get("title") or "").casefold()
    for keys, node_id in TITLE_NODE:
        if any(k in title for k in keys) and node_id in ids:
            return node_id

    fallback = AREA_NODE.get(t.get("area", ""), "trigger")
    return fallback if fallback in ids else (nodes[0].get("id") if nodes else "")


def _node_stats(tickets: list[dict], nodes: list[dict]) -> dict[str, dict[str, int]]:
    """Per-node health: open tickets, open P0/P1, and closed history."""
    stats = {n["id"]: {"open": 0, "p0p1": 0, "closed": 0} for n in nodes}
    for t in tickets:
        nid = _ticket_node(t, nodes)
        bucket = stats.get(nid)
        if bucket is None:
            continue
        status = t.get("status", "")
        if status in OPEN_STATUSES:
            bucket["open"] += 1
            if t.get("severity") in ("P0", "P1"):
                bucket["p0p1"] += 1
        elif status in CLOSED_ALL:
            bucket["closed"] += 1
    return stats


def _health_tone(stat: dict[str, int]) -> str:
    if stat["p0p1"]:
        return "bad"
    if stat["open"]:
        return "warn"
    return "ok"


def _health_label(stat: dict[str, int]) -> str:
    if stat["p0p1"]:
        return f'{stat["p0p1"]} P0/P1 · {stat["open"]} open'
    if stat["open"]:
        return f'{stat["open"]} open'
    return "0 open ✓"


def _short_label(label: str) -> str:
    """'Trigger — Command Enqueue & Dispatch' → 'Trigger'."""
    return (label or "").split(" — ")[0].strip()


def _exec_positions(nodes: list[dict]) -> dict[str, tuple[float, float, float, float]]:
    """One column per stage, boxes centred vertically inside their column."""
    by_stage: dict[int, list[dict]] = {}
    for n in nodes:
        by_stage.setdefault(int(n.get("stage", 0)), []).append(n)
    n_cols = max(1, max((int(n.get("stage", 0)) for n in nodes), default=0) + 1)
    col_w = EXEC_W / n_cols
    pos = {}
    for stage, group in by_stage.items():
        group.sort(key=lambda n: n["id"])
        total = len(group) * EXEC_BOX_H + (len(group) - 1) * EXEC_GAP
        top = max(16.0, (EXEC_H - total) / 2)
        x = stage * col_w + (col_w - EXEC_BOX_W) / 2
        for i, n in enumerate(group):
            pos[n["id"]] = (x, top + i * (EXEC_BOX_H + EXEC_GAP), EXEC_BOX_W, EXEC_BOX_H)
    return pos


def _exec_edge_path(a: tuple[float, ...], b: tuple[float, ...]) -> str:
    """Route an edge so it never runs through a box: same column connects
    vertically, forward columns curve left-to-right, and a back edge (grading →
    trigger) loops under the whole diagram."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    if abs(ax - bx) < 1:
        cx, cy = ax + aw / 2, ay + ah / 2
        if ay < by:
            return f"M{cx:.1f} {ay + ah:.1f} L{cx:.1f} {by:.1f}"
        return f"M{cx:.1f} {ay:.1f} L{cx:.1f} {by + bh:.1f}"
    if bx > ax:
        x1, y1 = ax + aw, ay + ah / 2
        x2, y2 = bx, by + bh / 2
        dx = (x2 - x1) * 0.45
        return (f"M{x1:.1f} {y1:.1f} C{x1 + dx:.1f} {y1:.1f} "
                f"{x2 - dx:.1f} {y2:.1f} {x2:.1f} {y2:.1f}")
    x1, y1 = ax + aw / 2, ay + ah
    x2, y2 = bx + bw / 2, by + bh
    floor = EXEC_H - 10
    return (f"M{x1:.1f} {y1:.1f} L{x1:.1f} {floor} "
            f"L{x2:.1f} {floor} L{x2:.1f} {y2:.1f}")


def _exec_svg(nodes: list[dict], edges: list[dict],
              stats: dict[str, dict[str, int]]) -> str:
    pos = _exec_positions(nodes)
    markers = "".join(
        f'<marker id="arrow-{kind}" class="mk-{kind}" viewBox="0 0 8 8" refX="8" '
        f'refY="4" markerWidth="7" markerHeight="7" orient="auto">'
        f'<path d="M0,0 L8,4 L0,8 z"/></marker>'
        for kind in ("control", "parallel", "async")
    )
    edge_svg = []
    for e in edges:
        src, dst = e.get("from"), e.get("to")
        if src not in pos or dst not in pos:
            continue
        kind = e.get("kind") if e.get("kind") in ("control", "parallel", "async") else "control"
        edge_svg.append(
            f'<path class="edge edge-{kind}" d="{_exec_edge_path(pos[src], pos[dst])}" '
            f'marker-end="url(#arrow-{kind})"><title>{html.escape(src)} → {html.escape(dst)}: '
            f'{html.escape(e.get("label") or "")}</title></path>'
        )
    node_svg = []
    for n in sorted(nodes, key=lambda n: (int(n.get("stage", 0)), n["id"])):
        x, y, w, h = pos[n["id"]]
        stat = stats[n["id"]]
        tone = _health_tone(stat)
        health = _health_label(stat)
        short = _short_label(n.get("label", ""))[:15]
        nid = n["id"]
        node_svg.append(
            f'<g class="graph-node gn-{tone}" data-node="{html.escape(nid, quote=True)}" '
            f'onclick="window.filterTicketsByNode(\'{html.escape(nid, quote=True)}\')" '
            f'style="cursor:pointer">'
            f'<title>Stage {n.get("stage")} · {html.escape(n.get("label", ""))} — '
            f'{html.escape(n.get("repo", ""))} — {html.escape(health)}</title>'
            f'<rect class="gn-box" x="{x:.1f}" y="{y:.1f}" width="{w}" height="{h}" rx="9"/>'
            f'<text class="gn-stage" x="{x + 9:.1f}" y="{y + 21:.1f}">S{n.get("stage")} · '
            f'{html.escape(short)}</text>'
            f'<text class="gn-repo" x="{x + 9:.1f}" y="{y + 37:.1f}">'
            f'{html.escape(n.get("repo", ""))}</text>'
            f'<rect class="gn-pill" x="{x + 9:.1f}" y="{y + h - 26:.1f}" '
            f'width="{w - 18}" height="16" rx="8"/>'
            f'<text class="gn-pill-text" x="{x + w / 2:.1f}" y="{y + h - 15:.1f}" '
            f'text-anchor="middle">{html.escape(health)}</text>'
            f'</g>'
        )
    stages = sorted({int(n.get("stage", 0)) for n in nodes})
    stage_span = f"0-{stages[-1]}" if stages else "0"
    return (
        f'<figure class="graph-canvas">'
        f'<svg viewBox="0 0 {EXEC_W} {EXEC_H}" role="img" '
        f'aria-label="Execution graph: {len(nodes)} nodes across stages {stage_span}">'
        f'<defs>{markers}</defs>'
        f'<g class="edges">{"".join(edge_svg)}</g>'
        f'<g class="nodes">{"".join(node_svg)}</g>'
        f'</svg>'
        f'<figcaption>Stages {stage_span} left to right. Solid = control flow, dashed = parallel '
        f'seats, dotted = async tool/collector work. Click any node to open its tickets.</figcaption>'
        f'</figure>'
    )


def _exec_cards(nodes: list[dict], stats: dict[str, dict[str, int]]) -> str:
    cards = []
    for n in sorted(nodes, key=lambda n: (int(n.get("stage", 0)), n["id"])):
        nid = n["id"]
        stat = stats[nid]
        tone = _health_tone(stat)
        timeout = n.get("timeout_s")
        reads = ", ".join(n.get("inputs") or []) or "—"
        writes = ", ".join(n.get("outputs") or []) or "—"
        covers = "".join(
            f'<code>{html.escape(c)}</code> ' for c in (n.get("covers") or [])
        ) or "—"
        cards.append(
            f'<article class="node-card gn-{tone}" id="node-{html.escape(nid, quote=True)}">'
            f'<header class="node-card-head">'
            f'<h3>Stage {n.get("stage")} · {html.escape(n.get("label", ""))}</h3>'
            f'<span class="pill info">{html.escape(n.get("repo", ""))}</span>'
            f'<button type="button" class="pill {tone} node-badge" '
            f'onclick="window.filterTicketsByNode(\'{html.escape(nid, quote=True)}\')" '
            f'title="Show the tickets mapped to this node">'
            f'{html.escape(_health_label(stat))}</button>'
            f'</header>'
            f'<dl class="node-facts">'
            f'<div><dt>Entry</dt><dd><code>{html.escape(n.get("entry", "") or "—")}</code></dd></div>'
            f'<div><dt>Timeout</dt><dd>{html.escape(str(timeout) + "s" if timeout else "none")}</dd></div>'
            f'<div><dt>Failure / Skip Rule</dt><dd>'
            f'{html.escape(n.get("skip_or_fallback", "") or "—")}</dd></div>'
            f'<div><dt>Reads → Writes</dt><dd>{html.escape(reads)} → {html.escape(writes)}</dd></div>'
            f'<div><dt>Covered files</dt><dd class="covers">{covers}</dd></div>'
            f'</dl></article>'
        )
    return f'<div class="node-grid">{"".join(cards)}</div>'


def _view_exec(tickets: list[dict], graph: dict,
               stats: dict[str, dict[str, int]]) -> str:
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    open_p0p1 = sum(s["p0p1"] for s in stats.values())
    closed = sum(s["closed"] for s in stats.values())
    healthy = sum(1 for s in stats.values() if s["p0p1"] == 0)
    repos = sorted({n.get("repo", "") for n in nodes})
    stages = sorted({int(n.get("stage", 0)) for n in nodes})
    stage_span = f"stages {stages[0]}–{stages[-1]}" if stages else "no stages"

    def tile(label: str, value: object, note: str, tone: str) -> str:
        return (f'<div class="tile {tone}"><div class="label">{html.escape(label)}</div>'
                f'<div class="value">{html.escape(str(value))}</div>'
                f'<div class="note">{html.escape(note)}</div></div>')

    kpis = "".join([
        tile("Execution Nodes", len(nodes),
             f"{stage_span} across {len(repos)} repos", "ok"),
        tile("Open P0/P1 on Graph", open_p0p1,
             "cycle-halting or wrong-desk work", "bad" if open_p0p1 else "ok"),
        tile("Verified / Closed Tickets", closed,
             "history kept in the ledger", "ok"),
        tile("Healthy Nodes (0 P0/P1)", healthy,
             f"of {len(nodes)} nodes", "warn" if healthy < len(nodes) else "ok"),
    ])
    return (
        f'<section class="doc-view active" id="view-exec">'
        f'<h1>1. Execution Graph (How It Works)</h1>'
        f'<p class="view-lede">{len(nodes)} execution nodes across {len(repos)} '
        f'repo{"" if len(repos) == 1 else "s"} ({stage_span}), stage by stage, with live '
        f'ticket health from <code>tickets.jsonl</code>.</p>'
        f'<div class="status-grid">{kpis}</div>'
        f'{_exec_svg(nodes, edges, stats)}'
        f'<h2>Stage-by-Stage Node Cards</h2>'
        f'{_exec_cards(nodes, stats)}'
        f'</section>'
    )


# Which layer column each execution node sits in on the state-flow map. The
# flow JSON declares edges between stores and nodes but no actor layer, so the
# layering of the ACTORS is a rendering decision recorded here (the stores
# carry their own `layer`).
NODE_LAYER = {
    "collectors": 0, "trigger": 1, "preflight": 1, "gatekeeper": 1, "phase0": 1,
    "regime": 2, "junior": 2, "fa": 2, "qa": 2, "va": 2, "debate": 2,
    "board": 2, "las_bridge": 2, "contract": 3, "execution": 4, "grading": 5,
}


def _actor_layer(node: dict) -> int:
    nid = node.get("id", "")
    if nid in NODE_LAYER:
        return NODE_LAYER[nid]
    return min(DATA_COLS - 1, max(0, int(node.get("stage", 0))))


def _data_positions(stores: list[dict], actors: list[dict]) -> dict[str, tuple[float, float, float, float, str]]:
    """Six columns: a header, an actor chip rail on top, stores below it.

    Actors sit above the stores they touch because the same-column edges
    (collectors → job_runs, execution → orders) are then short vertical arrows
    instead of a tangle of loops.
    """
    col_w = DATA_W / DATA_COLS
    pos: dict[str, tuple[float, float, float, float, str]] = {}

    by_layer: dict[int, list[dict]] = {}
    for s in stores:
        by_layer.setdefault(int(s.get("layer", 0)), []).append(s)
    actor_by_layer: dict[int, list[dict]] = {}
    for n in actors:
        actor_by_layer.setdefault(_actor_layer(n), []).append(n)

    chip_w, chip_h, chip_gap, per_row = 64, DATA_ACTOR_H, 4, 3
    for layer in range(DATA_COLS):
        x0 = layer * col_w
        layer_stores = sorted(by_layer.get(layer, []), key=lambda s: s["id"])
        layer_actors = sorted(actor_by_layer.get(layer, []), key=lambda n: n["id"])

        rows = (len(layer_actors) + per_row - 1) // per_row
        rail_h = rows * chip_h + max(0, rows - 1) * chip_gap
        rail_y = 22.0
        for i, n in enumerate(layer_actors):
            row, col = divmod(i, per_row)
            pos[n["id"]] = (
                x0 + 8 + col * (chip_w + chip_gap),
                rail_y + row * (chip_h + chip_gap),
                chip_w, chip_h, "actor",
            )

        store_top = rail_y + rail_h + 12
        avail = DATA_H - store_top - 8
        total = len(layer_stores) * DATA_STORE_H + max(0, len(layer_stores) - 1) * 8
        top = store_top + max(0.0, (avail - total) / 2)
        for i, s in enumerate(layer_stores):
            pos[s["id"]] = (
                x0 + 8, top + i * (DATA_STORE_H + 8),
                DATA_STORE_W, DATA_STORE_H, "store",
            )
    return pos


def _data_edge_path(s: tuple[float, ...], d: tuple[float, ...]) -> str:
    sx, sy, sw, sh, skind = s
    dx, dy, dw, dh, dkind = d
    if abs(sx - dx) < 1:
        x1, x2 = sx + sw / 2, dx + dw / 2
        if sy < dy:
            y1, y2 = sy + sh, dy
        else:
            y1, y2 = sy, dy + dh
        mid = (y1 + y2) / 2
        return f"M{x1:.1f} {y1:.1f} C{x1:.1f} {mid:.1f} {x2:.1f} {mid:.1f} {x2:.1f} {y2:.1f}"
    if dx > sx:
        x1, y1 = sx + sw, sy + sh / 2
        x2, y2 = dx, dy + dh / 2
        bend = (x2 - x1) * 0.45
        return (f"M{x1:.1f} {y1:.1f} C{x1 + bend:.1f} {y1:.1f} "
                f"{x2 - bend:.1f} {y2:.1f} {x2:.1f} {y2:.1f}")
    x1, y1 = sx + sw / 2, sy + sh
    x2, y2 = dx + dw / 2, dy + dh
    floor = DATA_H - 8
    return (f"M{x1:.1f} {y1:.1f} L{x1:.1f} {floor} "
            f"L{x2:.1f} {floor} L{x2:.1f} {y2:.1f}")


def _store_open_count(store: dict, tickets: list[dict], nodes: list[dict]) -> int:
    """Open tickets that touch a store: named in the title, covered by a
    `repo:path` entry that contains the collection name, or mapped to one of
    the nodes that writes it."""
    sid = store.get("id", "")
    writers = set(store.get("writers") or [])
    count = 0
    for t in tickets:
        if t.get("status") not in OPEN_STATUSES:
            continue
        title = (t.get("title") or "").casefold()
        covers = t.get("covers") or []
        if (sid.casefold() in title
                or any(sid in c for c in covers)
                or _ticket_node(t, nodes) in writers):
            count += 1
    return count


def _store_click_target(store: dict, node_ids: set[str]) -> str:
    for w in store.get("writers") or []:
        if w in node_ids:
            return w
    return "trigger"


def _layer_map(graph: dict) -> dict[int, str]:
    """Column labels: the built-in DATA_LAYERS, overlaid by the graph's own
    optional `layers` object so a project can name its own columns."""
    layers = dict(DATA_LAYERS)
    layers.update({
        int(k): str(v)
        for k, v in (graph.get("layers") or {}).items()
        if str(k).isdigit()
    })
    return layers


def _data_svg(stores: list[dict], flows: list[dict], actors: list[dict],
              tickets: list[dict], nodes: list[dict],
              layers: dict[int, str]) -> str:
    pos = _data_positions(stores, actors)
    node_ids = {n["id"] for n in nodes}
    grid: list[str] = []
    edges: list[str] = []
    boxes: list[str] = []
    col_w = DATA_W / DATA_COLS
    for layer in range(DATA_COLS):
        x = layer * col_w
        grid.append(f'<line class="col-rule" x1="{x:.1f}" y1="4" x2="{x:.1f}" y2="{DATA_H - 4}"/>')
        grid.append(
            f'<text class="layer-head" x="{x + 8:.1f}" y="14">{layer} · '
            f'{html.escape(layers.get(layer, "—"))}</text>'
        )
    for f in flows:
        src, dst = f.get("from"), f.get("to")
        if src not in pos or dst not in pos:
            continue
        edges.append(
            f'<path class="flow-edge" d="{_data_edge_path(pos[src], pos[dst])}" '
            f'marker-end="url(#arrow-flow)"><title>{html.escape(src)} → {html.escape(dst)} '
            f'({html.escape(f.get("key") or "")}): {html.escape(f.get("label") or "")}</title></path>'
        )
    for n in actors:
        x, y, w, h, _ = pos[n["id"]]
        boxes.append(
            f'<g class="actor-node" data-node="{html.escape(n["id"], quote=True)}" '
            f'onclick="window.filterTicketsByNode(\'{html.escape(n["id"], quote=True)}\')" '
            f'style="cursor:pointer">'
            f'<title>{html.escape(n.get("label", ""))}</title>'
            f'<rect class="act-box" x="{x:.1f}" y="{y:.1f}" width="{w}" height="{h}" rx="8"/>'
            f'<text class="act-label" x="{x + w / 2:.1f}" y="{y + h / 2 + 2.6:.1f}" '
            f'text-anchor="middle">{html.escape(n["id"][:12])}</text></g>'
        )
    for s in sorted(stores, key=lambda s: (int(s.get("layer", 0)), s["id"])):
        x, y, w, h, _ = pos[s["id"]]
        opened = _store_open_count(s, tickets, nodes)
        tone = "warn" if opened else "ok"
        target = _store_click_target(s, node_ids)
        join = ",".join(s.get("join_keys") or []) or "—"
        boxes.append(
            f'<g class="store-node" data-store="{html.escape(s["id"], quote=True)}" '
            f'onclick="window.filterTicketsByNode(\'{html.escape(target, quote=True)}\')" '
            f'style="cursor:pointer">'
            f'<title>{html.escape(s.get("purpose") or "")}</title>'
            f'<rect class="st-box" x="{x:.1f}" y="{y:.1f}" width="{w}" height="{h}" rx="8"/>'
            f'<text class="st-id" x="{x + 8:.1f}" y="{y + 16:.1f}">'
            f'{html.escape(s["id"][:24])}</text>'
            f'<text class="st-kind" x="{x + 8:.1f}" y="{y + 31:.1f}">'
            f'{html.escape(s.get("kind", ""))} · {html.escape(s.get("ttl", ""))}</text>'
            f'<text class="st-join" x="{x + 8:.1f}" y="{y + 45:.1f}">'
            f'join: {html.escape(join[:28])}</text>'
            f'<rect class="st-pill st-{tone}" x="{x + 8:.1f}" y="{y + h - 22:.1f}" '
            f'width="{w - 16}" height="16" rx="8"/>'
            f'<text class="st-pill-text" x="{x + w / 2:.1f}" y="{y + h - 11:.1f}" '
            f'text-anchor="middle">{opened} open ticket{"" if opened == 1 else "s"}</text></g>'
        )
    return (
        f'<figure class="graph-canvas">'
        f'<svg viewBox="0 0 {DATA_W} {DATA_H}" role="img" '
        f'aria-label="Data state-flow: {len(stores)} stores across {DATA_COLS} layers">'
        f'<defs><marker id="arrow-flow" class="mk-flow" viewBox="0 0 8 8" refX="8" refY="4" '
        f'markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>'
        f'<g class="layer-grid">{"".join(grid)}</g>'
        f'<g class="edges">{"".join(edges)}</g>'
        f'<g class="nodes">{"".join(boxes)}</g>'
        f'</svg>'
        f'<figcaption>Six layers left to right; actors (chips) above the stores they touch. '
        f'Click a store or actor to open its tickets.</figcaption>'
        f'</figure>'
    )


def _store_table(stores: list[dict], layers: dict[int, str]) -> str:
    rows = []
    for s in sorted(stores, key=lambda s: (int(s.get("layer", 0)), s["id"])):
        layer = int(s.get("layer", 0))
        rows.append(
            f'<tr><td><code>{html.escape(s["id"])}</code></td>'
            f'<td>{layer} · {html.escape(layers.get(layer, "—"))}</td>'
            f'<td>{html.escape(s.get("kind", ""))}</td>'
            f'<td>{html.escape(", ".join(s.get("join_keys") or []))}</td>'
            f'<td>{html.escape(s.get("ttl", ""))}</td>'
            f'<td>{html.escape(", ".join(s.get("writers") or []))}</td>'
            f'<td>{html.escape(", ".join(s.get("readers") or []))}</td>'
            f'<td>{html.escape(s.get("purpose", ""))}</td></tr>'
        )
    return (
        '<div class="scroll-x"><table class="store-table"><thead><tr>'
        '<th>Store / Collection</th><th>Layer</th><th>Kind</th><th>Join Keys</th>'
        '<th>TTL</th><th>Writers</th><th>Readers</th><th>Purpose</th>'
        f'</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
    )


def _flow_table(flows: list[dict]) -> str:
    rows = "".join(
        f'<tr><td><code>{html.escape(f.get("from", ""))}</code></td>'
        f'<td><code>{html.escape(f.get("to", ""))}</code></td>'
        f'<td><code>{html.escape(f.get("key", ""))}</code></td>'
        f'<td>{html.escape(f.get("label", ""))}</td></tr>'
        for f in flows
    )
    return (
        '<div class="scroll-x"><table class="flow-table"><thead><tr>'
        '<th>From</th><th>To</th><th>Join Key</th><th>Payload / State Transition</th>'
        f'</tr></thead><tbody>{rows}</tbody></table></div>'
    )


def _load_stats() -> dict:
    """Optional per-project statistics: DOCS_DIR/stats.json (agent-pool writes it with bin/pool-stats)."""
    try:
        return json.loads((DOCS_DIR / "stats.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _stat_pct(x) -> str:
    return "n/a" if x is None else f"{x * 100:.1f}%"


# Outcome segments of a verified run, in stacking order, with their colour.
_STAT_SEGMENTS = [
    ("clean", ("clean",), "var(--ok)"),
    ("fixed by orchestrator / re-brief", ("fixed", "rebriefed"), "var(--accent)"),
    ("partial / escalated", ("partial", "escalated"), "var(--warn)"),
    ("fail / reverted", ("fail", "reverted"), "var(--bad)"),
]


def _svg_legend(items: list[tuple[str, str]], y: int, x0: int = 130) -> str:
    out, x = [], x0
    for label, colour in items:
        out.append(f'<rect x="{x}" y="{y - 9}" width="10" height="10" rx="2" style="fill:{colour}"/>'
                   f'<text x="{x + 14}" y="{y}" font-size="11" style="fill:var(--ink-soft)">{html.escape(label)}</text>')
        x += 26 + 6.6 * len(label)
    return "".join(out)


_GOLD = "#d4a017"
_MIN_RANK_N = 20


def _best_of(items, value, min_n_of, lower_is_better: bool = True, min_n: int = _MIN_RANK_N):
    """Name of the best item: lowest (or highest) value among items with at least min_n samples."""
    pool = [(k, value(v)) for k, v in items if min_n_of(v) >= min_n and value(v) is not None]
    if not pool:
        return None
    return (min if lower_is_better else max)(pool, key=lambda kv: kv[1])[0]


def _nm(name: str, best) -> str:
    """Row label content; the best row gets a gold star and bold gold text."""
    if best is not None and name == best:
        return f'<tspan style="fill:{_GOLD};font-weight:700">\u2605 {html.escape(name)}</tspan>'
    return html.escape(name)


def _best_note(best, what: str) -> str:
    if not best:
        return ""
    return (f'<figcaption><b style="color:{_GOLD}">\u2605 Best: {html.escape(best)}</b> \u2014 {html.escape(what)} '
            f'(only models with \u2265 {_MIN_RANK_N} samples can win).</figcaption>')


def _gold_box(x, y, w, h) -> str:
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="3" style="fill:none;stroke:{_GOLD};stroke-width:2.5"/>'


def _svg_outcome_bars(rows: dict, title: str) -> str:
    """Horizontal 100% stacked bar per model: what happened to its verified runs."""
    items = [(k, v) for k, v in sorted(rows.items(), key=lambda kv: -kv[1]["verified"]) if v["verified"]]
    if not items:
        return ""
    W, left, bar_w, row_h = 820, 130, 420, 24
    H = 46 + row_h * len(items)
    best = _best_of(items, lambda v: (v.get("outcomes") or {}).get("clean", 0) / v["verified"], lambda v: v["verified"],
                    lower_is_better=False)
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>',
             _svg_legend([(lbl, col) for lbl, _, col in _STAT_SEGMENTS], 32)]
    for i, (name, v) in enumerate(items):
        y = 44 + i * row_h
        oc = v.get("outcomes") or {}
        x = left
        parts.append(f'<text x="{left - 8}" y="{y + 14}" font-size="12" text-anchor="end" '
                     f'style="fill:var(--ink)">{_nm(name, best)}</text>')
        if name == best:
            parts.append(_gold_box(left - 3, y - 3, bar_w + 6, 24))
        for label, keys, colour in _STAT_SEGMENTS:
            n = sum(oc.get(k, 0) for k in keys)
            if not n:
                continue
            w = bar_w * n / v["verified"]
            parts.append(f'<rect x="{x:.1f}" y="{y}" width="{w:.1f}" height="18" style="fill:{colour}">'
                         f'<title>{html.escape(name)}: {n} {html.escape(label)} of {v["verified"]} verified</title></rect>')
            x += w
        clean = oc.get("clean", 0) / v["verified"]
        warn = " \u26a0" if v["verified"] < 20 else ""
        parts.append(f'<text x="{left + bar_w + 8}" y="{y + 14}" font-size="11" style="fill:var(--ink-soft)">'
                     f'{clean * 100:.0f}% clean \u00b7 {_stat_pct(v["fault_rate"])} fault \u00b7 n={v["verified"]}{warn}</text>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            f'{_best_note(best, "highest share of clean runs")}</figure>')


def _svg_rate_ci(rows: dict, title: str, mark_best: bool = True, keep_order: bool = False) -> str:
    """Fault rate per model with its 95% Wilson interval as a whisker."""
    items = [(k, v) for k, v in (rows.items() if keep_order else sorted(rows.items(), key=lambda kv: (kv[1]["fault_rate"] or 0)))
             if v["verified"] >= 5]
    if not items:
        return ""
    W, left, bar_w, row_h = 820, 130, 420, 22
    top = max(0.5, max(v["ci95"][1] for _, v in items))
    H = 50 + row_h * len(items)
    sx = lambda r: left + bar_w * r / top
    best = _best_of(items, lambda v: v["fault_rate"], lambda v: v["verified"]) if mark_best else None
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>']
    for t in range(0, int(top * 100) + 1, 10):
        x = sx(t / 100)
        parts.append(f'<line x1="{x:.1f}" y1="24" x2="{x:.1f}" y2="{H - 14}" style="stroke:var(--rule)" stroke-width="1"/>'
                     f'<text x="{x:.1f}" y="{H - 2}" font-size="10" text-anchor="middle" style="fill:var(--ink-soft)">{t}%</text>')
    for i, (name, v) in enumerate(items):
        y = 30 + i * row_h
        r = v["fault_rate"] or 0
        lo, hi = v["ci95"]
        parts.append(
            f'<text x="{left - 8}" y="{y + 12}" font-size="12" text-anchor="end" style="fill:var(--ink)">{_nm(name, best)}</text>'
            f'<rect x="{left}" y="{y + 2}" width="{max(1, sx(r) - left):.1f}" height="12" style="fill:var(--bad);opacity:.75">'
            f'<title>{html.escape(name)}: {v["faults"]} faults / {v["verified"]} verified</title></rect>'
            f'<line x1="{sx(lo):.1f}" y1="{y + 8}" x2="{sx(hi):.1f}" y2="{y + 8}" style="stroke:var(--ink)" stroke-width="1.5"/>'
            f'<line x1="{sx(lo):.1f}" y1="{y + 3}" x2="{sx(lo):.1f}" y2="{y + 13}" style="stroke:var(--ink)" stroke-width="1.5"/>'
            f'<line x1="{sx(hi):.1f}" y1="{y + 3}" x2="{sx(hi):.1f}" y2="{y + 13}" style="stroke:var(--ink)" stroke-width="1.5"/>'
            f'<text x="{min(W - 4, sx(hi) + 6):.1f}" y="{y + 12}" font-size="11" style="fill:var(--ink-soft)">'
            f'{_stat_pct(r)} (n={v["verified"]})</text>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            f'{_best_note(best, "lowest fault rate")}</figure>')


def _svg_daily(daily: dict, title: str) -> str:
    """Stacked column per day (verified runs by outcome) with the unverified count on top."""
    if not daily:
        return ""
    days = list(daily.items())
    W, H, left, base = 820, 230, 40, 190
    col = min(70, (W - left - 10) / len(days))
    peak = max(max(v["verified"] for _, v in days), 1)
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>',
             _svg_legend([(lbl, c) for lbl, _, c in _STAT_SEGMENTS], 32, x0=left)]
    for i, (d, v) in enumerate(days):
        x = left + i * col + 6
        y = base
        oc = v.get("outcomes") or {}
        for label, keys, colour in _STAT_SEGMENTS:
            n = sum(oc.get(k, 0) for k in keys)
            if not n:
                continue
            h = (base - 50) * n / peak
            y -= h
            parts.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{col - 12:.1f}" height="{h:.1f}" style="fill:{colour}">'
                         f'<title>{d}: {n} {html.escape(label)}</title></rect>')
        parts.append(
            f'<text x="{x + (col - 12) / 2:.1f}" y="{y - 4:.1f}" font-size="10" text-anchor="middle" '
            f'style="fill:var(--ink)">{v["verified"]}</text>'
            f'<text x="{x + (col - 12) / 2:.1f}" y="{base + 14}" font-size="10" text-anchor="middle" '
            f'style="fill:var(--ink-soft)">{d[5:]}</text>'
            f'<text x="{x + (col - 12) / 2:.1f}" y="{base + 27}" font-size="9" text-anchor="middle" '
            f'style="fill:var(--bad)">{_stat_pct(v["fault_rate"])}</text>')
    parts.append(f'<line x1="{left}" y1="{base}" x2="{W - 4}" y2="{base}" style="stroke:var(--rule)"/>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            '<figcaption>Number on top: verified runs that day. Red number: fault rate that day.</figcaption></figure>')


def _svg_rework(models: dict, title: str) -> str:
    """Per model: agent commits, how many got re-fixed later, fixes authored, fixes that needed fixing again."""
    items = [(k, v) for k, v in sorted(models.items(), key=lambda kv: -kv[1]["commits"]) if v["commits"]]
    if not items:
        return ""
    W, left, bar_w, row_h = 820, 130, 400, 34
    peak = max(v["commits"] for _, v in items)
    H = 46 + row_h * len(items)
    sx = lambda n: bar_w * n / peak
    best = _best_of(items, lambda v: v["refix_rate"], lambda v: v["commits"])
    legend = [("commits", "var(--panel-2)"), ("re-fixed later", "var(--warn)"),
              ("fixes it made", "var(--accent)"), ("its fixes re-fixed", "var(--bad)")]
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>',
             _svg_legend(legend, 32)]
    for i, (name, v) in enumerate(items):
        y = 42 + i * row_h
        parts.append(
            f'<text x="{left - 8}" y="{y + 17}" font-size="12" text-anchor="end" style="fill:var(--ink)">{_nm(name, best)}</text>'
            f'<rect x="{left}" y="{y}" width="{sx(v["commits"]):.1f}" height="13" style="fill:var(--panel-2);stroke:var(--rule)">'
            f'<title>{v["commits"]} agent commits</title></rect>'
            f'<rect x="{left}" y="{y}" width="{sx(v["refixed"]):.1f}" height="13" style="fill:var(--warn)">'
            f'<title>{v["refixed"]} commits had lines rewritten later by someone else</title></rect>'
            f'<rect x="{left}" y="{y + 15}" width="{sx(v["fixes"]):.1f}" height="11" style="fill:var(--accent)">'
            f'<title>{v["fixes"]} commits fixed an earlier agent commit</title></rect>'
            f'<rect x="{left}" y="{y + 15}" width="{sx(v["fixes_refixed"]):.1f}" height="11" style="fill:var(--bad)">'
            f'<title>{v["fixes_refixed"]} of those fixes had to be fixed again</title></rect>'
            f'<text x="{left + bar_w + 8}" y="{y + 11}" font-size="11" style="fill:var(--ink-soft)">'
            f'{v["refixed"]}/{v["commits"]} re-fixed ({_stat_pct(v["refix_rate"])}) \u00b7 survival {_stat_pct(v["survival"])}</text>'
            f'<text x="{left + bar_w + 8}" y="{y + 25}" font-size="11" style="fill:var(--ink-soft)">'
            f'{v["fixes"]} fixes, {v["fixes_refixed"]} re-fixed ({_stat_pct(v["fix_refix_rate"])})</text>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            f'{_best_note(best, "lowest share of commits re-fixed later")}</figure>')


def _svg_hbars(pairs: list[tuple[str, int]], title: str, colour: str = "var(--accent)") -> str:
    pairs = [p for p in pairs if p[1]]
    if not pairs:
        return ""
    peak = max(n for _, n in pairs)
    left = max(130, int(6.6 * max(len(k) for k, _ in pairs)) + 14)
    W, bar_w, row_h = 820, 820 - left - 60, 20
    H = 28 + row_h * len(pairs)
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>']
    for i, (k, n) in enumerate(pairs):
        y = 24 + i * row_h
        parts.append(f'<text x="{left - 8}" y="{y + 12}" font-size="12" text-anchor="end" style="fill:var(--ink)">{html.escape(k)}</text>'
                     f'<rect x="{left}" y="{y + 2}" width="{bar_w * n / peak:.1f}" height="12" style="fill:{colour}"/>'
                     f'<text x="{left + bar_w * n / peak + 6:.1f}" y="{y + 12}" font-size="11" style="fill:var(--ink-soft)">{n}</text>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg></figure>')


def _vs_avg_cells(rate, avg) -> str:
    """Two cells: percentage-point difference from the average, and the rate as a multiple of it.
    Green = better than average (lower fault rate), red = worse."""
    if avg is None:
        return ""
    if rate is None or not avg:
        return '<td data-v="">n/a</td><td data-v="">n/a</td>'
    d = (rate - avg) * 100
    tone = "var(--ok)" if d < -0.05 else ("var(--bad)" if d > 0.05 else "var(--ink-soft)")
    return (f'<td data-v="{d:.3f}" style="color:{tone};font-weight:600;white-space:nowrap">{d:+.1f} pp</td>'
            f'<td data-v="{rate / avg:.4f}" style="color:{tone}">{rate / avg:.2f}\u00d7</td>')


def _svg_mix_index(mix: dict, title: str) -> str:
    """Actual faults / faults expected from the model's job mix (each job at its all-model average).
    1.0 = exactly as good as an average model doing the same jobs; below 1 = better."""
    items = [(m, v) for m, v in mix.items() if v["index"] is not None and v["verified"] >= 5]
    items.sort(key=lambda kv: kv[1]["index"])
    best = _best_of(items, lambda v: v["index"], lambda v: v["verified"])
    if not items:
        return ""
    W, left, half, row_h = 820, 130, 230, 22
    top = max(2.0, min(4.0, max(v["index"] for _, v in items)))
    mid = left + half
    sx = lambda r: mid + half * (min(r, top) - 1) / (top - 1) if r >= 1 else mid - half * (1 - r)
    H = 50 + row_h * len(items)
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>',
             f'<line x1="{mid}" y1="24" x2="{mid}" y2="{H - 14}" style="stroke:var(--ink)" stroke-width="1"/>',
             f'<text x="{mid}" y="{H - 2}" font-size="10" text-anchor="middle" style="fill:var(--ink-soft)">1.0\u00d7 = average for its job mix</text>',
             f'<text x="{left}" y="{H - 2}" font-size="10" style="fill:var(--ok)">\u2190 better</text>',
             f'<text x="{mid + half}" y="{H - 2}" font-size="10" text-anchor="end" style="fill:var(--bad)">worse \u2192</text>']
    for i, (m, v) in enumerate(items):
        y = 28 + i * row_h
        x = sx(v["index"])
        colour = "var(--ok)" if v["index"] < 1 else "var(--bad)"
        x0, w = (x, mid - x) if x < mid else (mid, x - mid)
        warn = " \u26a0" if v["verified"] < 20 else ""
        parts.append(
            f'<text x="{left - 8}" y="{y + 12}" font-size="12" text-anchor="end" style="fill:var(--ink)">{_nm(m, best)}</text>'
            f'<rect x="{x0:.1f}" y="{y + 2}" width="{max(w, 1):.1f}" height="12" style="fill:{colour};opacity:.85">'
            f'<title>{m}: {v["faults"]} faults vs {v["expected"]} expected from its job mix</title></rect>'
            f'<text x="{mid + half + 10}" y="{y + 12}" font-size="11" style="fill:var(--ink-soft)">'
            f'{v["index"]:.2f}\u00d7 \u00b7 {v["faults"]}/{v["expected"]:.1f} exp. \u00b7 n={v["verified"]}{warn}</text>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            '<figcaption>Normalised for job mix: each model\'s faults divided by the faults an average model would '
            'have made on the same jobs (each job at its all-model fault rate). Removes the penalty for taking the '
            'hard jobs (build, debug).</figcaption>' + _best_note(best, "fewest faults relative to its job mix") + '</figure>')


_SORT_JS = r"""<script>(function(){
function val(c){if(!c)return null;var s=c.hasAttribute('data-v')?c.getAttribute('data-v'):c.textContent.trim();
 if(s===''||/^n\/a/i.test(s))return null;var t=s.replace(/,/g,'').replace(/^[^\d+\-.a-z]+/i,'');
 var m=t.match(/^[+\-]?\d*\.?\d+/);return m?parseFloat(m[0]):s.toLowerCase();}
document.querySelectorAll('table.stat-sort').forEach(function(t){if(t.dataset.sortReady)return;t.dataset.sortReady='1';
 var hs=t.tHead?t.tHead.rows[0].cells:[];Array.prototype.forEach.call(hs,function(th,i){
  th.style.cursor='pointer';th.title='Click to sort';th.addEventListener('click',function(){
   var b=t.tBodies[0];if(!b)return;var rows=Array.prototype.slice.call(b.rows);var asc=th.getAttribute('data-dir')!=='asc';
   Array.prototype.forEach.call(hs,function(h){h.removeAttribute('data-dir');h.textContent=h.textContent.replace(/ [\u25b2\u25bc]$/,'');});
   th.setAttribute('data-dir',asc?'asc':'desc');th.textContent+=asc?' \u25b2':' \u25bc';
   rows.sort(function(x,y){var a=val(x.cells[i]),c=val(y.cells[i]);if(a===null&&c===null)return 0;if(a===null)return 1;if(c===null)return -1;
    if(typeof a===typeof c)return (a<c?-1:a>c?1:0)*(asc?1:-1);return (typeof a==='number'?-1:1)*(asc?1:-1);});
   rows.forEach(function(r){b.appendChild(r);});});});});})();</script>"""


def _stat_table(first: str, rows: dict, limit: int = 0, avg=None) -> str:
    items = sorted(rows.items(), key=lambda kv: -kv[1]["verified"])
    if limit:
        items = items[:limit]
    body = []
    best = _best_of(items, lambda v: v["fault_rate"], lambda v: v["verified"])
    for k, v in items:
        oc = v.get("outcomes") or {}
        small = 0 < v["verified"] < 20
        ci = f'{_stat_pct(v["ci95"][0])}\u2013{_stat_pct(v["ci95"][1])}' if v["verified"] else "n/a"
        body.append(
            (f'<tr style="background:rgba(212,160,23,.12)"><td><b style="color:{_GOLD}">\u2605</b> <code>{html.escape(str(k))}</code></td>'
             if k == best else f'<tr><td><code>{html.escape(str(k))}</code></td>')
            + f'<td>{v["runs"]}</td><td>{v["verified"]}</td>'
            f'<td>{oc.get("clean", 0)}</td><td>{oc.get("fixed", 0)}</td><td>{oc.get("rebriefed", 0)}</td>'
            f'<td>{oc.get("partial", 0) + oc.get("escalated", 0)}</td><td>{oc.get("fail", 0) + oc.get("reverted", 0)}</td>'
            f'<td>{v["faults"]}</td><td>{_stat_pct(v["fault_rate"])}{" \u26a0" if small else ""}</td><td>{ci}</td>'
            + _vs_avg_cells(v["fault_rate"], avg) + '</tr>')
    return ('<div class="scroll-x"><table class="flow-table stat-sort"><thead><tr>'
            f'<th>{html.escape(first)}</th><th>Runs</th><th>Verified</th><th>Clean</th><th>Fixed by orch.</th>'
            '<th>Re-briefed</th><th>Partial/esc.</th><th>Fail/reverted</th><th>Faults</th><th>Fault rate</th>'
            '<th>95% CI</th>' + ('<th>\u0394 vs avg</th><th>\u00d7 avg</th>' if avg is not None else '')
            + f'</tr></thead><tbody>{"".join(body)}</tbody></table></div>')


def _heat_colour(rate) -> str:
    if rate is None:
        return "var(--panel-2)"
    hue = 130 * (1 - min(rate / 0.4, 1.0))
    return f"hsl({hue:.0f},55%,42%)"


def _svg_heatmap(matrix: dict, title: str, min_n: int = 5, note: str = "", job_rate=None) -> str:
    """Rows = job types, columns = models; cell colour = fault rate (green 0% -> red >= 40%), text = rate and n."""
    jobs = sorted(matrix, key=lambda j: -sum(v["verified"] for v in matrix[j].values()))
    jobs = [j for j in jobs if sum(v["verified"] for v in matrix[j].values())]
    totals: dict[str, int] = {}
    for j in jobs:
        for m, v in matrix[j].items():
            totals[m] = totals.get(m, 0) + v["verified"]
    models = [m for m in sorted(totals, key=lambda m: -totals[m]) if totals[m]]
    if not jobs or not models:
        return ""
    left, top, cw, chh = 130, 50, max(62, min(84, 680 // len(models))), 30
    W, H = left + cw * len(models) + 10, top + chh * len(jobs) + 26
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>']
    for i, m in enumerate(models):
        parts.append(f'<text x="{left + i * cw + cw / 2:.1f}" y="{top - 8}" font-size="11" text-anchor="middle" '
                     f'style="fill:var(--ink)">{html.escape(m)}</text>')
    for r, j in enumerate(jobs):
        y = top + r * chh
        avg_txt = f' ({_stat_pct((job_rate or {}).get(j))})' if job_rate and (job_rate or {}).get(j) is not None else ''
        parts.append(f'<text x="{left - 8}" y="{y + 19}" font-size="12" text-anchor="end" style="fill:var(--ink)">'
                     f'{html.escape(j)}{avg_txt}</text>')
        row_best = _best_of([(m, matrix[j][m]) for m in models if m in matrix[j]], lambda v: v["fault_rate"],
                            lambda v: v["verified"], min_n=min_n)
        for i, m in enumerate(models):
            v = matrix[j].get(m)
            x = left + i * cw
            if not v or not v["verified"]:
                parts.append(f'<rect x="{x + 1}" y="{y + 1}" width="{cw - 2}" height="{chh - 2}" rx="3" '
                             f'style="fill:var(--panel-2);opacity:.45"/>')
                continue
            thin = v["verified"] < min_n
            jr = (job_rate or {}).get(j)
            rel = None if jr is None or v["fault_rate"] is None else v["fault_rate"] - jr
            if thin:
                fill = "var(--panel-2)"
            elif rel is not None:
                fill = _heat_colour(max(0.0, min(0.4, 0.2 + rel)))   # 0 pp = amber, -20 pp green, +20 pp red
            else:
                fill = _heat_colour(v["fault_rate"])
            ink = "var(--ink-soft)" if thin else "#fff"
            parts.append(
                f'<rect x="{x + 1}" y="{y + 1}" width="{cw - 2}" height="{chh - 2}" rx="3" style="fill:{fill}">'
                f'<title>{html.escape(j)} by {html.escape(m)}: {v["faults"]} faults / {v["verified"]} verified'
                f'{" (too few to rank)" if thin else ""}</title></rect>'
                f'<text x="{x + cw / 2:.1f}" y="{y + 14}" font-size="11" font-weight="600" text-anchor="middle" '
                f'style="fill:{ink}">{"\u2605 " if m == row_best else ""}{_stat_pct(v["fault_rate"])}</text>'
                + (_gold_box(x, y, cw, chh) if m == row_best else '') + f''
                f'<text x="{x + cw / 2:.1f}" y="{y + 25}" font-size="9" text-anchor="middle" style="fill:{ink}">'
                + (f'{rel * 100:+.0f}pp \u00b7 ' if rel is not None and not thin else '') + f'n={v["verified"]}</text>')
    legend = ('Cell = fault rate and its difference from that job\'s average over all models (green = better than '
              'the job average, amber = average, red = worse).' if job_rate else
              'Cell = fault rate of that model on that job (green 0% \u2192 red \u2265 40%).')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {max(W, 760)} {H - 18}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg><figcaption>{legend} Grey = fewer than '
            f'{min_n} verified runs. <b style="color:{_GOLD}">\u2605 gold box = best model in that row</b> (lowest fault rate, '
            f'\u2265 {min_n} runs). {html.escape(note)}</figcaption></figure>')


def _best_table(best: dict) -> str:
    rows = []
    medal = ["\U0001f947", "\U0001f948", "\U0001f949"]
    for job, ranked in sorted(best.items(), key=lambda kv: -sum(r["verified"] for r in kv[1])):
        if not ranked:
            continue
        cells = "".join(
            f'<td>{medal[i]} <code>{html.escape(r["model"])}</code> {_stat_pct(r["success"])} '
            f'<span class="muted">(n={r["verified"]}, \u2265{_stat_pct(r["success_lo"])})</span></td>'
            for i, r in enumerate(ranked[:3]))
        cells += "<td></td>" * (3 - min(3, len(ranked)))
        worst = ranked[-1] if len(ranked) > 3 else None
        cells += (f'<td><code>{html.escape(worst["model"])}</code> {_stat_pct(worst["success"])} '
                  f'<span class="muted">(n={worst["verified"]})</span></td>' if worst else "<td></td>")
        rows.append(f'<tr><td><b>{html.escape(job)}</b></td>{cells}</tr>')
    return ('<div class="scroll-x"><table class="flow-table stat-sort"><thead><tr><th>Job</th><th>Best</th><th>2nd</th>'
            '<th>3rd</th><th>Weakest</th></tr></thead><tbody>' + "".join(rows) + '</tbody></table></div>'
            '<p class="muted">Success = verified runs without a fault. Ranked by the 95% lower bound (\u2265), so '
            'a model needs a good rate AND enough runs; at least 5 verified runs to rank.</p>')


def _svg_roles(roles: dict, title: str) -> str:
    """Per model: how many verified coding jobs vs review/critic jobs it did, with the fault rate of each."""
    items = [(m, v) for m, v in roles.items() if v["coding"]["verified"] + v["review"]["verified"]]
    items.sort(key=lambda kv: -(kv[1]["coding"]["verified"] + kv[1]["review"]["verified"]))
    if not items:
        return ""
    W, left, bar_w, row_h = 820, 130, 360, 34
    peak = max(max(v["coding"]["verified"], v["review"]["verified"]) for _, v in items)
    best_c = _best_of(items, lambda v: v["coding"]["fault_rate"], lambda v: v["coding"]["verified"])
    best_r = _best_of(items, lambda v: v["review"]["fault_rate"], lambda v: v["review"]["verified"])
    H = 46 + row_h * len(items)
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>',
             _svg_legend([("coding (build, edit, debug, scripted)", "var(--accent)"),
                          ("review / critic", "var(--warn)")], 32)]
    for i, (m, v) in enumerate(items):
        y = 42 + i * row_h
        c, r = v["coding"], v["review"]
        parts.append(
            f'<text x="{left - 8}" y="{y + 17}" font-size="12" text-anchor="end" style="fill:var(--ink)">{html.escape(m)}</text>'
            f'<rect x="{left}" y="{y}" width="{bar_w * c["verified"] / peak:.1f}" height="13" style="fill:var(--accent)">'
            f'<title>{c["verified"]} verified coding runs</title></rect>'
            f'<rect x="{left}" y="{y + 15}" width="{bar_w * r["verified"] / peak:.1f}" height="13" style="fill:var(--warn)">'
            f'<title>{r["verified"]} verified review runs</title></rect>'
            f'<text x="{left + bar_w + 10}" y="{y + 11}" font-size="11" style="fill:{_GOLD if m == best_c else "var(--ink-soft)"}">{"\u2605 best coder \u00b7 " if m == best_c else ""}coding {c["verified"]} '
            f'\u00b7 fault {_stat_pct(c["fault_rate"])}</text>'
            f'<text x="{left + bar_w + 10}" y="{y + 26}" font-size="11" style="fill:{_GOLD if m == best_r else "var(--ink-soft)"}">{"\u2605 best critic \u00b7 " if m == best_r else ""}review {r["verified"]} '
            f'\u00b7 fault {_stat_pct(r["fault_rate"])}</text>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            + (f'<figcaption><b style="color:{_GOLD}">\u2605 Best coder: {html.escape(best_c or "n/a")} \u00b7 '
               f'best critic: {html.escape(best_r or "n/a")}</b> (lowest fault rate, \u2265 {_MIN_RANK_N} runs).</figcaption>')
            + '</figure>')


def _why_section(w: dict) -> str:
    """Explain one job type's fault rate: how the faults ended, why (from the orchestrator's notes), which
    models and repos carry them, corrections needed, and recent examples."""
    if not w or not w.get("faults"):
        return ""
    job = html.escape(w["job"])
    rate = w["faults"] / w["verified"] if w["verified"] else None
    fo = w.get("fault_outcomes") or {}
    label = {"fixed": "landed, orchestrator had to fix it", "partial": "partial: work left owed",
             "fail": "failed outright", "rebriefed": "passed only after a re-brief", "reverted": "reverted"}
    reasons = sorted((w.get("reasons") or {}).items(), key=lambda kv: -kv[1])
    ex = "".join(
        f'<tr><td>{html.escape(str(e["date"]))}</td><td><code>{html.escape(str(e["model"]))}</code></td>'
        f'<td>{html.escape(str(e["outcome"]))}</td><td>{html.escape(str(e["repo"]))}</td>'
        f'<td>{html.escape(", ".join(e["reasons"]))}</td><td>{html.escape(e["note"])}</td></tr>'
        for e in w.get("examples") or [])
    named = [(k, v) for k, v in reasons if k not in ("other", "no note (auto-recorded)")]
    top = ", ".join(f"{html.escape(k)} ({v})" for k, v in named[:4])
    return (
        f'<h3 id="why-{job}">Why does <code>{job}</code> fail {_stat_pct(rate)} of the time?</h3>'
        f'<p class="view-lede">{w["faults"]} faults in {w["verified"]} verified {job} runs. Most did not fail outright: '
        f'{fo.get("fixed", 0)} landed but the orchestrator had to fix them, {fo.get("partial", 0)} were partial, '
        f'only {fo.get("fail", 0)} failed. A faulted {job} run needed {w["corrections_fault"]} orchestrator '
        f'corrections on average, against {w["corrections_ok"]} for a clean one. Top reasons from the orchestrator\'s '
        f'notes: {top}.</p>'
        + _svg_hbars([(label.get(k, k), v) for k, v in sorted(fo.items(), key=lambda kv: -kv[1])],
                     f"How the {w['job']} faults ended", "var(--warn)")
        + _svg_hbars(reasons, f"Why: reasons in the orchestrator's notes ({w['job']} faults; a run can have several)",
                     "var(--bad)")
        + _svg_rate_ci(w["by_model"], f"{w['job']} fault rate by model (95% interval)")
        + _svg_rate_ci({k: v for k, v in w["by_repo"].items() if v["verified"] >= 5},
                       f"{w['job']} fault rate by repo (95% interval)")
        + (f'<h4>Recent {job} faults with the orchestrator\'s note</h4><div class="scroll-x"><table class="flow-table stat-sort">'
           '<thead><tr><th>Date</th><th>Model</th><th>Outcome</th><th>Repo</th><th>Reasons</th><th>Note</th></tr></thead>'
           f'<tbody>{ex}</tbody></table></div>' if ex else "")
    )


def _reason_matrix(reasons_by_job: dict) -> str:
    jobs = [j for j, v in sorted(reasons_by_job.items(), key=lambda kv: -sum(kv[1].values())) if v]
    if not jobs:
        return ""
    reasons = sorted({r for j in jobs for r in reasons_by_job[j]},
                     key=lambda r: (-sum(reasons_by_job[j].get(r, 0) for j in jobs), r))
    head = "".join(f"<th>{html.escape(j)}</th>" for j in jobs)
    body = "".join(
        f'<tr><td>{html.escape(r)}</td>' + "".join(
            f'<td>{reasons_by_job[j].get(r, 0) or ""}</td>' for j in jobs) + "</tr>" for r in reasons)
    return ('<h4>Fault reasons by job type (counts)</h4><div class="scroll-x"><table class="flow-table stat-sort"><thead><tr>'
            f'<th>Reason</th>{head}</tr></thead><tbody>{body}</tbody></table></div>')


def _critic_section(cr: dict) -> str:
    if not cr:
        return ""
    models = cr.get("models") or {}
    rows = "".join(
        f'<tr><td><code>{html.escape(m)}</code></td><td>{v["review_all"]["verified"]}</td>'
        f'<td>{_stat_pct(v["review_all"]["fault_rate"])}</td><td>{v["review_week"]["verified"]}</td>'
        f'<td>{_stat_pct(v["review_week"]["fault_rate"])}</td><td>{v["findings"]}</td>'
        f'<td>{v["blocker"]}/{v["major"]}/{v["minor"]}</td><td>{v["true_positive"]}</td><td>{v["caught"]}</td></tr>'
        for m, v in sorted(models.items(), key=lambda kv: -(kv[1]["review_all"]["verified"] + kv[1]["caught"] * 10)))
    bx = cr.get("builder_x_critic") or {}
    critics = sorted({c for row in bx.values() for c in row}, key=lambda c: (-sum(r.get(c, 0) for r in bx.values()), c))
    pair = "".join(
        f'<tr><td><code>{html.escape(b)}</code></td>' + "".join(f'<td>{row.get(c, 0) or ""}</td>' for c in critics)
        + f'<td>{sum(row.values())}</td></tr>'
        for b, row in sorted(bx.items(), key=lambda kv: -sum(kv[1].values())))
    return (
        '<h4>Critic benchmark</h4><div class="scroll-x"><table class="flow-table stat-sort"><thead><tr><th>Critic</th>'
        '<th>Review runs (all)</th><th>Review fault (all)</th><th>Review runs (7d)</th><th>Review fault (7d)</th>'
        '<th>Findings raised</th><th>Blocker/major/minor</th><th>True pos.</th><th>Escaped defects caught</th>'
        f'</tr></thead><tbody>{rows}</tbody></table></div>'
        '<p class="muted">Review fault = the review itself was wrong (missed or invented an issue). Findings come from '
        'scored review panels; escaped defects caught are matched from the defect ledger\'s found-by field.</p>'
        + (f'<h4>Builder \u00d7 critic: who caught whose issues</h4><div class="scroll-x"><table class="flow-table stat-sort">'
           '<thead><tr><th>Builder</th>' + "".join(f"<th>{html.escape(c)}</th>" for c in critics)
           + f'<th>Total</th></tr></thead><tbody>{pair}</tbody></table></div>' if pair else "")
    )


def _teams_section(tm: dict, wk: dict, days: int = 7) -> str:
    """Which models work well together: orchestrator -> worker pairs and builder -> reviewer pairs."""
    pairs = {f"{o} \u2192 {w}": v for o, ws in (tm.get("orchestrator_x_worker") or {}).items() for w, v in ws.items()}
    head = ('<h3>Teams: which models work well together</h3>'
            f'<p class="muted">{tm.get("recorded", 0)} runs name the model that orchestrated them. This is recorded '
            f'automatically for every subagent since {html.escape(str(tm.get("since") or "2026-11-11"))}; older runs '
            'do not have it. A pair reads orchestrator \u2192 worker. A run only counts toward a fault rate once the '
            'orchestrator has verified it.</p>')
    if not pairs:
        return head + '<p class="muted">No team runs recorded yet.</p>'
    bx = tm.get("builder_x_reviewer") or {}
    rev = "".join(
        f'<tr><td><code>{html.escape(bl)}</code></td><td><code>{html.escape(c)}</code></td><td>{v["reviews"]}</td>'
        f'<td>{html.escape(", ".join(f"{k} {n}" for k, n in sorted(v["outcomes"].items())))}</td></tr>'
        for bl, cs in sorted(bx.items()) for c, v in sorted(cs.items(), key=lambda kv: -kv[1]["reviews"]))
    return (head + _stat_table("Orchestrator \u2192 worker (all time)", pairs)
            + f'<h4>Best team per job (last {days} days, pairs with \u2265 5 verified runs)</h4>'
            + (_best_table(wk.get("best_by_job") or {}) if any((wk.get("best_by_job") or {}).values())
               else '<p class="muted">No pair has 5 verified runs in this window yet.</p>')
            + _svg_heatmap(tm.get("by_job") or {}, "Fault rate: job type \u00d7 team (all time)")
            + '<h4>Reviews: whose build was checked by whom</h4>'
            + ('<div class="scroll-x"><table class="flow-table stat-sort"><thead><tr><th>Builder</th><th>Reviewer</th>'
               f'<th>Reviews</th><th>Review outcomes</th></tr></thead><tbody>{rev}</tbody></table></div>' if rev
               else '<p class="muted">No recorded review of a named build yet.</p>'))


def _svg_num_matrix(cells: dict, rows: list, cols: list, title: str, fmt, colour, tip, sub=None,
                    caption: str = "") -> str:
    """Generic builder x fixer matrix: cells[row][col] -> number; colour(v) -> fill; fmt(v) -> label."""
    if not rows or not cols:
        return ""
    left, top, cw, chh = 120, 50, max(58, min(80, 680 // len(cols))), 30
    W, H = max(760, left + cw * len(cols) + 10), top + chh * len(rows) + 6
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>']
    for i, c in enumerate(cols):
        lab = "orch/human" if c == "orchestrator/human" else c
        parts.append(f'<text x="{left + i * cw + cw / 2:.1f}" y="{top - 8}" font-size="11" text-anchor="middle" '
                     f'style="fill:var(--ink)">{html.escape(lab)}</text>')
    for r_i, r in enumerate(rows):
        y = top + r_i * chh
        parts.append(f'<text x="{left - 8}" y="{y + 19}" font-size="12" text-anchor="end" style="fill:var(--ink)">{html.escape(r)}</text>')
        for i, c in enumerate(cols):
            x = left + i * cw
            v = (cells.get(r) or {}).get(c)
            if v is None:
                parts.append(f'<rect x="{x + 1}" y="{y + 1}" width="{cw - 2}" height="{chh - 2}" rx="3" '
                             f'style="fill:var(--panel-2);opacity:.45"/>')
                continue
            parts.append(
                f'<rect x="{x + 1}" y="{y + 1}" width="{cw - 2}" height="{chh - 2}" rx="3" style="fill:{colour(v)}">'
                f'<title>{html.escape(tip(r, c, v))}</title></rect>'
                f'<text x="{x + cw / 2:.1f}" y="{y + (14 if sub else 19)}" font-size="11" font-weight="600" '
                f'text-anchor="middle" style="fill:#fff">{html.escape(fmt(v))}</text>'
                + (f'<text x="{x + cw / 2:.1f}" y="{y + 25}" font-size="9" text-anchor="middle" style="fill:#fff">'
                   f'{html.escape(sub(r, c))}</text>' if sub else ""))
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            + (f'<figcaption>{caption}</figcaption>' if caption else "") + '</figure>')


def _svg_split_bars(builders: dict, title: str) -> str:
    """Per builder, 100% bar of WHO re-fixed its re-fixed commits: same model, another model, orchestrator/human.
    A commit re-fixed by two kinds counts in both, so the bar is normalised to the sum."""
    segs = [("same model", "by_same", "var(--accent)"), ("another model", "by_other", "var(--warn)"),
            ("orchestrator/human", "by_orchestrator", "var(--bad)")]
    items = [(b, v) for b, v in sorted(builders.items(), key=lambda kv: -kv[1]["commits"]) if v["refixed"]]
    if not items:
        return ""
    W, left, bar_w, row_h = 820, 130, 400, 24
    H = 46 + row_h * len(items)
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>',
             _svg_legend([(l, c) for l, _, c in segs], 32)]
    for i, (b, v) in enumerate(items):
        y = 44 + i * row_h
        tot = sum(v[k] for _, k, _ in segs) or 1
        x = left
        parts.append(f'<text x="{left - 8}" y="{y + 14}" font-size="12" text-anchor="end" style="fill:var(--ink)">{html.escape(b)}</text>')
        for lab, k, col in segs:
            w = bar_w * v[k] / tot
            if w:
                parts.append(f'<rect x="{x:.1f}" y="{y}" width="{w:.1f}" height="18" style="fill:{col}">'
                             f'<title>{b}: {v[k]} re-fixed commits touched by {lab}</title></rect>')
                if w > 34:
                    parts.append(f'<text x="{x + w / 2:.1f}" y="{y + 13}" font-size="10" text-anchor="middle" '
                                 f'style="fill:#fff">{100 * v[k] / tot:.0f}%</text>')
            x += w
        parts.append(f'<text x="{left + bar_w + 8}" y="{y + 14}" font-size="11" style="fill:var(--ink-soft)">'
                     f'{v["refixed"]}/{v["commits"]} commits re-fixed ({_stat_pct(v["refix_rate"])})</text>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg></figure>')


def _refix_layers_section(L: dict, avg_refix) -> str:
    if not L or not L.get("builders"):
        return ""
    B, F = L["builders"], L["fixers"]
    rows = [b for b in sorted(B, key=lambda b: -B[b]["commits"]) if B[b]["commits"] >= 3]
    cols = [f for f in sorted(F, key=lambda f: -F[f]["events"]) if F[f]["events"] >= 3]
    ev = L.get("events") or {}

    def per100_colour(v):
        return _heat_colour(min(0.4, v / 100 * 2))          # 20 per 100 commits = red

    def lift_colour(v):
        return _heat_colour(max(0.0, min(0.4, 0.2 * v)))      # 1.0x = amber, 0 = green, >= 2x = red

    heat_per100 = _svg_num_matrix(
        L.get("per100") or {}, rows, cols,
        "Re-fixed per 100 of the builder's commits (row = builder, column = who re-fixed)",
        lambda v: f"{v:.1f}", per100_colour,
        lambda r, c, v: f"{c} re-fixed {v:.1f} of every 100 {r} commits ({(ev.get(r) or {}).get(c, 0)} fix-up commits)",
        sub=lambda r, c: f"{(ev.get(r) or {}).get(c, 0)} fix-ups",
        caption="Normalised by the builder's volume: a builder with 270 commits and one with 40 are directly comparable. "
                "Green = rarely, red = 20+ of every 100 commits.")
    heat_lift = _svg_num_matrix(
        L.get("lift") or {}, rows, cols,
        "Pairing vs chance: observed fix-ups / expected (1.0\u00d7 = what the two volumes alone predict)",
        lambda v: f"{v:.2f}\u00d7", lift_colour,
        lambda r, c, v: f"{c} re-fixed {r} {v:.2f}x as often as expected from both totals",
        caption="Normalised by BOTH totals: expected = builder's fix-ups received \u00d7 fixer's fix-ups made / all fix-ups. "
                "Red (\u2265 2\u00d7) = this fixer lands on this builder's code far more than chance (often the same lane or a "
                "reviewer assigned to it); green = less than chance.")
    heat_lines = _svg_num_matrix(
        L.get("lines100") or {}, rows, cols,
        "Lines rewritten per 100 lines the builder added",
        lambda v: f"{v:.2f}", lambda v: _heat_colour(min(0.4, v / 2 * 0.4)),
        lambda r, c, v: f"{c} rewrote {v:.3f} of every 100 lines {r} added",
        caption="Size of the rework, normalised by how much code the builder wrote (red \u2265 2 lines per 100).")
    brow = "".join(
        f'<tr><td><code>{html.escape(b)}</code></td><td>{v["commits"]}</td><td>{v["refixed"]}</td>'
        f'<td>{_stat_pct(v["refix_rate"])}</td>' + _vs_avg_cells(v["refix_rate"], avg_refix)
        + f'<td>{_stat_pct(v["by_same"] / v["commits"] if v["commits"] else None)}</td>'
        f'<td>{_stat_pct(v["by_other"] / v["commits"] if v["commits"] else None)}</td>'
        f'<td>{_stat_pct(v["by_orchestrator"] / v["commits"] if v["commits"] else None)}</td>'
        f'<td>{v["events_per_commit"]}</td><td>{v["lines_per_100_added"] if v["lines_per_100_added"] is not None else "n/a"}</td>'
        f'<td>{v["median_lines_per_fixup"] if v["median_lines_per_fixup"] is not None else "n/a"}</td>'
        f'<td>{v["median_hours_to_first_refix"] if v["median_hours_to_first_refix"] is not None else "n/a"}</td>'
        f'<td>{v["p75_hours_to_first_refix"] if v["p75_hours_to_first_refix"] is not None else "n/a"}</td></tr>'
        for b, v in sorted(B.items(), key=lambda kv: -kv[1]["commits"]))
    frow = "".join(
        f'<tr><td><code>{html.escape(f)}</code></td><td>{v["events"]}</td><td>{_stat_pct(v["share_of_all_fixups"])}</td>'
        f'<td>{v["own_commits"] or "\u2014"}</td>'
        f'<td>{v["fixups_per_100_own_commits"] if v["fixups_per_100_own_commits"] is not None else "n/a"}</td>'
        f'<td>{v["builders_fixed"]}</td><td>{_stat_pct(v["self_share"])}</td><td>{v["lines_rewritten"]}</td>'
        f'<td>{v["median_lines_per_fixup"] if v["median_lines_per_fixup"] is not None else "n/a"}</td>'
        f'<td>{v["median_hours_after"] if v["median_hours_after"] is not None else "n/a"}</td></tr>'
        for f, v in sorted(F.items(), key=lambda kv: -kv[1]["events"]))
    return (
        '<h3>Who re-fixed whose commits (normalised)</h3>'
        f'<p class="view-lede">{L.get("grand_events", 0)} fix-up events. Raw counts favour whoever did the most work, '
        'so every view below is divided by volume: per 100 of the builder\'s commits, per 100 lines it added, or '
        'against what both totals predict by chance. Builders and fixers with fewer than 3 commits/fix-ups are left '
        'out of the matrices (still in the tables). Hover a cell for the raw count.</p>'
        + _svg_split_bars(B, "Who re-fixed each builder's commits (share of its re-fixed commits)")
        + heat_per100 + heat_lift + heat_lines
        + '<h4>Builder view: how its commits got re-fixed</h4>'
        '<div class="scroll-x"><table class="flow-table stat-sort"><thead><tr><th>Builder</th><th>Commits</th>'
        '<th>Re-fixed</th><th>Re-fix rate</th><th>\u0394 vs avg</th><th>\u00d7 avg</th><th>by same model</th>'
        '<th>by other model</th><th>by orch./human</th><th>Fix-ups per commit</th><th>Lines rewritten / 100 added</th>'
        '<th>Median lines per fix-up</th><th>Median hrs to 1st re-fix</th><th>p75 hrs</th></tr></thead>'
        f'<tbody>{brow}</tbody></table></div>'
        '<p class="muted">"by \u2026" columns = share of ALL the builder\'s commits re-fixed by that kind of fixer (a commit '
        'can be hit by several). Hours = time from the commit to the first later commit that rewrote its lines.</p>'
        '<h4>Fixer view: who does the re-fixing</h4>'
        '<div class="scroll-x"><table class="flow-table stat-sort"><thead><tr><th>Fixer</th><th>Fix-ups</th>'
        '<th>Share of all fix-ups</th><th>Own commits</th><th>Fix-ups per 100 own commits</th><th>Builders fixed</th>'
        '<th>Fixing its own model</th><th>Lines rewritten</th><th>Median lines per fix-up</th><th>Median hrs after</th>'
        f'</tr></thead><tbody>{frow}</tbody></table></div>'
        '<p class="muted">Fix-ups per 100 own commits = how much of a model\'s output is touching other commits\' lines: '
        'high = it mostly integrates/fixes, low = it mostly writes new code.</p>'
    )


_BAND_COL = {"1-3 easy": "var(--ok)", "4-6 medium": "var(--warn)", "7-10 hard": "var(--bad)", "unscored": "var(--panel-2)"}
_BANDS = ["1-3 easy", "4-6 medium", "7-10 hard"]


def _svg_band_validation(by_band: dict, monotonic) -> str:
    items = {b: by_band[b] for b in _BANDS if (by_band.get(b) or {}).get("verified")}
    if not items:
        return ""
    cap = ("\u2713 Fault rate rises with the difficulty score, so ranking on it is justified." if monotonic else
           "\u26a0 Fault rate does NOT rise steadily with the score at this sample size; treat the adjusted ranking "
           "as indicative.")
    chart = _svg_rate_ci(items, "Check: does the difficulty score predict faults? (all models, easy \u2192 hard)", mark_best=False, keep_order=True)
    return chart.replace("</figure>", f'<figcaption>{cap}</figcaption></figure>', 1)


def _svg_rank_index(models: dict, title: str) -> str:
    """Difficulty-adjusted index with 95% interval, best first, medals for the top 3 (>= 20 runs)."""
    items = [(m, v) for m, v in models.items() if v["index"] is not None and v["verified"] >= 5]
    items.sort(key=lambda kv: (kv[1]["verified"] < _MIN_RANK_N, kv[1]["index"]))
    if not items:
        return ""
    W, left, half, row_h = 820, 150, 230, 24
    top = max(2.0, min(4.0, max(v["index_ci"][1] for _, v in items)))
    mid = left + half
    sx = lambda r: mid + half * (min(r, top) - 1) / (top - 1) if r >= 1 else mid - half * (1 - r)
    H = 54 + row_h * len(items)
    medal = ["\U0001f947", "\U0001f948", "\U0001f949"]
    ranked = [m for m, v in items if v["verified"] >= _MIN_RANK_N]
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>',
             f'<line x1="{mid}" y1="24" x2="{mid}" y2="{H - 16}" style="stroke:var(--ink)" stroke-width="1"/>',
             f'<text x="{mid}" y="{H - 2}" font-size="10" text-anchor="middle" style="fill:var(--ink-soft)">1.0\u00d7 = average for equally hard work</text>',
             f'<text x="{left}" y="{H - 2}" font-size="10" style="fill:var(--ok)">\u2190 better</text>',
             f'<text x="{mid + half}" y="{H - 2}" font-size="10" text-anchor="end" style="fill:var(--bad)">worse \u2192</text>']
    for i, (m, v) in enumerate(items):
        y = 30 + i * row_h
        rank = ranked.index(m) if m in ranked else None
        tag = (medal[rank] + " ") if rank is not None and rank < 3 else ("" if rank is not None else "\u26a0 ")
        x = sx(v["index"])
        lo, hi = v["index_ci"]
        colour = "var(--ok)" if v["index"] < 1 else "var(--bad)"
        x0, w = (x, mid - x) if x < mid else (mid, x - mid)
        lab_style = f"fill:{_GOLD};font-weight:700" if rank == 0 else "fill:var(--ink)"
        if rank == 0:
            parts.append(_gold_box(4, y - 1, W - 8, row_h - 2))
        parts.append(
            f'<text x="{left - 8}" y="{y + 13}" font-size="12" text-anchor="end" style="{lab_style}">{tag}{html.escape(m)}</text>'
            f'<rect x="{x0:.1f}" y="{y + 3}" width="{max(w, 1):.1f}" height="12" style="fill:{colour};opacity:.85">'
            f'<title>{m}: {v["faults"]} faults vs {v["expected"]} expected for its difficulty mix</title></rect>'
            f'<line x1="{sx(lo):.1f}" y1="{y + 9}" x2="{sx(hi):.1f}" y2="{y + 9}" style="stroke:var(--ink)" stroke-width="1.3"/>'
            f'<line x1="{sx(lo):.1f}" y1="{y + 4}" x2="{sx(lo):.1f}" y2="{y + 14}" style="stroke:var(--ink)" stroke-width="1.3"/>'
            f'<line x1="{sx(hi):.1f}" y1="{y + 4}" x2="{sx(hi):.1f}" y2="{y + 14}" style="stroke:var(--ink)" stroke-width="1.3"/>'
            f'<text x="{mid + half + 10}" y="{y + 13}" font-size="11" style="fill:var(--ink-soft)">'
            f'{v["index"]:.2f}\u00d7 ({lo:.2f}\u2013{hi:.2f}) \u00b7 n={v["verified"]}</text>')
    best = html.escape(ranked[0]) if ranked else "n/a"
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            f'<figcaption><b style="color:{_GOLD}">\U0001f947 Best: {best}</b>. '
            'Index = actual faults \u00f7 faults expected if an average model had done the same jobs at the same '
            'difficulty (strata = job type \u00d7 difficulty band; unscored runs compared within their job type). '
            f'Whiskers = 95% interval. Medals only for models with \u2265 {_MIN_RANK_N} verified runs; \u26a0 = too few to rank.'
            '</figcaption></figure>')


def _svg_band_mix(models: dict, title: str) -> str:
    """How hard each model's work was: share of its verified runs per difficulty band."""
    keys = _BANDS + ["unscored"]
    items = [(m, v) for m, v in models.items() if v["verified"] >= 5]
    items.sort(key=lambda kv: -(kv[1]["hard_share"] or 0))
    if not items:
        return ""
    W, left, bar_w, row_h = 820, 130, 400, 24
    H = 46 + row_h * len(items)
    parts = [f'<text x="0" y="14" font-size="13" font-weight="600" style="fill:var(--ink)">{html.escape(title)}</text>',
             _svg_legend([(k, _BAND_COL[k]) for k in keys], 32)]
    for i, (m, v) in enumerate(items):
        y = 44 + i * row_h
        x = left
        parts.append(f'<text x="{left - 8}" y="{y + 14}" font-size="12" text-anchor="end" style="fill:var(--ink)">{html.escape(m)}</text>')
        for k in keys:
            n = v["mix"].get(k, 0)
            if not n:
                continue
            w = bar_w * n / v["verified"]
            parts.append(f'<rect x="{x:.1f}" y="{y}" width="{w:.1f}" height="18" style="fill:{_BAND_COL[k]}">'
                         f'<title>{m}: {n} {k} runs</title></rect>')
            if w > 30:
                ink = "var(--ink)" if k == "unscored" else "#fff"
                parts.append(f'<text x="{x + w / 2:.1f}" y="{y + 13}" font-size="10" text-anchor="middle" '
                             f'style="fill:{ink}">{n}</text>')
            x += w
        ms = v["median_score"]
        parts.append(f'<text x="{left + bar_w + 8}" y="{y + 14}" font-size="11" style="fill:var(--ink-soft)">'
                     f'median {ms if ms is not None else "n/a"} \u00b7 {_stat_pct(v["hard_share"])} hard</text>')
    return (f'<figure class="stat-chart"><svg viewBox="0 0 {W} {H}" width="100%" role="img" '
            f'xmlns="http://www.w3.org/2000/svg">{"".join(parts)}</svg>'
            '<figcaption>Sorted by share of hard work. Score 1\u201310 from the code the run touched (files, modules, '
            'size before the change, importers, new code); \u201cunscored\u201d = no commits to measure (reviews, lookups, ops).'
            '</figcaption></figure>')


def _difficulty_section(d: dict, mix: dict, label: str) -> str:
    if not d or not d.get("models"):
        return ""
    models = d["models"]
    order = sorted(models, key=lambda m: (models[m]["verified"] < _MIN_RANK_N,
                                          models[m]["index"] if models[m]["index"] is not None else 9, m))
    medal = ["\U0001f947", "\U0001f948", "\U0001f949"]
    rows = []
    rank = 0
    for m in order:
        v = models[m]
        ok = v["verified"] >= _MIN_RANK_N and v["index"] is not None
        tag = (medal[rank] if rank < 3 else str(rank + 1)) if ok else "\u26a0"
        style = ' style="background:rgba(212,160,23,.12)"' if ok and rank == 0 else ""
        ci = v["index_ci"]
        ci_txt = f"{ci[0]:.2f}\u2013{ci[1]:.2f}" if ci else "n/a"
        jm = (mix.get(m) or {}).get("index")
        idx = f'{v["index"]}\u00d7' if v["index"] is not None else "n/a"
        rows.append(
            f'<tr{style}><td data-v="{rank + 1 if ok else 999}">{tag}</td><td><code>{html.escape(m)}</code></td>'
            f'<td>{v["verified"]}</td><td>{v["scored"]}</td><td>{v["mix"]["1-3 easy"]}</td><td>{v["mix"]["4-6 medium"]}</td>'
            f'<td>{v["mix"]["7-10 hard"]}</td><td>{v["median_score"] if v["median_score"] is not None else "n/a"}</td>'
            f'<td>{v["faults"]}</td><td>{v["expected"]}</td><td><b>{idx}</b></td><td>{ci_txt}</td>'
            f'<td>{v["scored_index"] if v["scored_index"] is not None else "n/a"}</td>'
            f'<td>{jm if jm is not None else "n/a"}</td>'
            f'<td>{_stat_pct(v["faults"] / v["verified"] if v["verified"] else None)}</td></tr>')
        if ok:
            rank += 1
    bb = d.get("by_band") or {}
    band_txt = ", ".join(f'{b}: {_stat_pct(bb[b]["fault_rate"])} (n={bb[b]["verified"]})'
                         for b in _BANDS if (bb.get(b) or {}).get("verified"))
    hm = {b: (d.get("band_model") or {}).get(b, {}) for b in _BANDS}
    return (
        f'<h3 id="difficulty-ranking-{label.split()[0]}">Ranking adjusted for difficulty ({html.escape(label)})</h3>'
        f'<p class="view-lede">Easy work flatters a model and hard work punishes it. {d["scored"]} of {d["verified"]} verified '
        f'runs have a difficulty score. Fault rate by band: {band_txt}. The ranking compares each model with the average '
        'model doing the SAME job type at the SAME difficulty.</p>'
        + _svg_rank_index(models, f"Difficulty-adjusted ranking, best first ({label})")
        + _svg_band_validation(bb, d.get("monotonic"))
        + _svg_band_mix(models, f"How hard was each model's work? ({label})")
        + _svg_heatmap(hm, f"Fault rate by difficulty band \u00d7 model ({label})",
                       job_rate={b: bb[b]["fault_rate"] for b in _BANDS if (bb.get(b) or {}).get("verified")},
                       note="Rows are difficulty bands (band average in brackets).")
        + '<div class="scroll-x"><table class="flow-table stat-sort"><thead><tr><th>Rank</th><th>Model</th><th>Verified</th>'
          '<th>Scored</th><th>Easy</th><th>Medium</th><th>Hard</th><th>Median score</th><th>Faults</th><th>Expected</th>'
          '<th>Difficulty-adj. index</th><th>95% CI</th><th>Index (scored runs only)</th><th>Job-mix index</th>'
          f'<th>Raw fault rate</th></tr></thead><tbody>{"".join(rows)}</tbody></table></div>'
          '<p class="muted">Ranked by the difficulty-adjusted index (lower = better); \u26a0 = fewer than '
          f'{_MIN_RANK_N} verified runs, not ranked. "Index (scored runs only)" leaves out runs without a difficulty score.</p>'
    )


def _stats_section(stats: dict) -> str:
    """Agent-pool statistics (stats.json from .agents/bin/pool-stats): charts first, tables after."""
    if not stats:
        return ""
    wk = stats.get("week") or stats
    win = stats.get("window") or {}
    span = f'{win.get("since", "?")} \u2192 {win.get("until", "?")}'
    t = wk["totals"]
    ch = stats.get("churn") or {}
    cm = ch.get("models") or {}
    ct = ch.get("totals") or {}
    classes = ["cross-review", "orchestrator", "live run", "other"]

    def tbl(head: str, body: str) -> str:
        return (f'<div class="scroll-x"><table class="flow-table stat-sort"><thead><tr>{head}</tr></thead>'
                f'<tbody>{body}</tbody></table></div>')

    def ths(*c: str) -> str:
        return "".join(f"<th>{x}</th>" for x in c)

    rework_rows = "".join(
        f'<tr><td><code>{html.escape(k)}</code></td><td>{v["commits"]}</td><td>{v["added"]}</td>'
        f'<td>{_stat_pct(v["survival"])}</td><td>{v["refixed"]}</td><td>{_stat_pct(v["refix_rate"])}</td>'
        f'<td>{v["lines_reworked"]}</td><td>{v["reworked_by_orchestrator"]}</td><td>{v["fixes"]}</td>'
        f'<td>{v["fixes_refixed"]}</td><td>{_stat_pct(v["fix_refix_rate"])}</td>'
        f'<td>{v.get("rework_per_100") if v.get("rework_per_100") is not None else "n/a"}</td>'
        + _vs_avg_cells(v["refix_rate"], ct.get("refix_rate")) + '</tr>'
        for k, v in sorted(cm.items(), key=lambda kv: -kv[1]["commits"]))
    rev = "".join(
        f'<tr><td><code>{html.escape(k)}</code></td><td>{v["findings"]}</td><td>{v["blocker"]}</td>'
        f'<td>{v["major"]}</td><td>{v["minor"]}</td><td>{v["true_positive"]}</td>'
        f'<td>{v["false_positive"]}</td><td>{v["unlabelled"]}</td></tr>'
        for k, v in sorted(stats["reviewers"].items(), key=lambda kv: -kv[1]["findings"]))
    mat = "".join(
        f'<tr><td><code>{html.escape(k)}</code></td>'
        + "".join(f'<td>{v.get(c, 0)}</td>' for c in classes) + f'<td>{sum(v.values())}</td></tr>'
        for k, v in sorted(stats["defect_matrix"].items(), key=lambda kv: -sum(kv[1].values())))
    causes = "".join(f'<tr><td><code>{html.escape(k)}</code></td><td>{v}</td></tr>'
                     for k, v in sorted(wk["fault_causes"].items(), key=lambda kv: -kv[1]))
    a = stats["totals"]
    churn_note = ""
    if ct.get("commits"):
        churn_note = (f'<p class="view-lede">Git blame of {ct["commits"]} agent commits in '
                      f'{len((ch.get("meta") or {}).get("repos") or {})} repos since '
                      f'{html.escape(str((ch.get("meta") or {}).get("since", "?")))} (code only; docs, generated HTML, '
                      f'lockfiles and assets excluded). <b>{ct["refixed"]}</b> commits '
                      f'({_stat_pct(ct["refixed"] / ct["commits"])}) had lines rewritten later by someone else. '
                      f'<b>{ct["fixes"]}</b> commits fixed an earlier agent commit, and <b>{ct["fixes_refixed"]}</b> '
                      f'of those fixes had to be fixed again. Survival = share of added lines still in the code today.</p>')
    return (
        '<h2 id="agent-pool-statistics">Agent-pool statistics: models, success and failure, fixes</h2>'
        f'<p class="view-lede">Last {win.get("days", 7)} days ({span}): {t["runs"]} runs recorded, '
        f'{t["verified"]} verified by the orchestrator. <b>{t["faults"]} faults ({_stat_pct(t["fault_rate"])}, '
        f'95% CI {_stat_pct(t["ci95"][0])}\u2013{_stat_pct(t["ci95"][1])})</b>, {t["clean"]} clean, '
        f'{(t.get("outcomes") or {}).get("fixed", 0)} fixed by the orchestrator. Unknown/unverified/infra/stopped rows are '
        'never in a rate. A fault is <code>model_error</code>, <code>scope_violation</code>, <code>reverted</code> or '
        '<code>fail</code>. \u26a0 = fewer than 20 verified runs. Click any table header to sort; '
        '\u0394 vs avg = percentage points above (red) or below (green) the average, \u00d7 avg = rate as a multiple of it. All time: '
        f'{a["faults"]}/{a["verified"]} faults ({_stat_pct(a["fault_rate"])}).</p>'
        + _difficulty_section(wk.get("difficulty") or {}, wk.get("mix_adjusted") or {}, f"last {win.get('days', 7)} days")
        + _difficulty_section(stats.get("difficulty") or {}, stats.get("mix_adjusted") or {}, "all time")
        + _svg_outcome_bars(wk["by_model"], f"What happened to each model's verified runs (last {win.get('days', 7)} days)")
        + _svg_rate_ci(wk["by_model"], "Fault rate by model with 95% interval (models with \u2265 5 verified runs)")
        + _svg_daily(stats.get("daily") or {}, "Verified runs per day by outcome")
        + '<h3>Which model is best at which job</h3>'
        + _svg_mix_index(wk.get("mix_adjusted") or {}, f"Normalised fault rate: actual vs expected for the model's job mix (last {win.get('days', 7)} days)")
        + _svg_heatmap(wk.get("job_model") or {}, f"Fault rate vs the job average: job type (average) \u00d7 model (last {win.get('days', 7)} days)", job_rate=wk.get("job_rate"))
        + _best_table(wk.get("best_by_job") or {})
        + _svg_heatmap(stats.get("job_model") or {}, "Fault rate: job type \u00d7 model (all time)")
        + '<h3>Coders vs critics</h3>'
        + _svg_roles(wk.get("roles") or {}, f"Who did the coding and who did the reviewing (last {win.get('days', 7)} days)")
        + _critic_section(stats.get("critics") or {})
        + _teams_section(stats.get("teams") or {}, wk.get("teams") or {}, win.get("days", 7))
        + ''.join(_why_section(w) for w in (wk.get("why") or {}).values())
        + _reason_matrix(wk.get("reasons_by_job") or {})
        + '<h3>Fixes and fixes of fixes (git)</h3>' + churn_note
        + _svg_rework(cm, "Per model: commits re-fixed later, fixes made, fixes that had to be fixed again")
        + (tbl(ths("Model", "Commits", "Lines added", "Survival", "Re-fixed", "Re-fix rate", "Lines reworked",
                   "\u2026by orchestrator", "Fixes made", "Fixes re-fixed", "Fix re-fix rate", "Lines reworked / 100 added",
                   "Re-fix \u0394 vs avg", "Re-fix \u00d7 avg"), rework_rows)
           + (f'<p class="muted">Averages over all agent commits: re-fix rate {_stat_pct(ct.get("refix_rate"))}, survival '
              f'{_stat_pct(ct.get("survival"))}, fix re-fix rate {_stat_pct(ct.get("fix_refix_rate"))}, '
              f'{ct.get("rework_per_100")} lines reworked per 100 added.</p>' if ct.get("commits") else "")
           if rework_rows else '<p class="muted">No churn cache yet: run <code>.agents/bin/pool-churn</code>.</p>')
        + _refix_layers_section(ch.get("layers") or {}, ct.get("refix_rate"))
        + _svg_outcome_bars(wk["by_job_type"], "Outcome by job type (last 7 days)")
        + f'<h3>Tables: last {win.get("days", 7)} days</h3>'
        + '<h4>By model</h4>' + _stat_table("Model", wk["by_model"], avg=wk["totals"]["fault_rate"])
        + '<h4>By job type</h4>' + _stat_table("Job type", wk["by_job_type"], avg=wk["totals"]["fault_rate"])
        + '<h4>By repo (top 15)</h4>' + _stat_table("Repo", wk["by_repo"], 15, avg=wk["totals"]["fault_rate"])
        + '<h4>Fault causes</h4>' + tbl(ths("Cause", "Count"), causes)
        + '<h3>Reviews (all time)</h3>'
        + _svg_hbars([(k, v["findings"]) for k, v in sorted(stats["reviewers"].items(), key=lambda kv: -kv[1]["findings"])],
                     "Cross-review findings per reviewer")
        + f'<p class="view-lede">{stats["findings"]} findings, {stats["defects"]} escaped defects. No finding is '
          'labelled a false positive yet, so there is no precision figure.</p>'
        + tbl(ths("Critic", "Findings", "Blocker", "Major", "Minor", "True pos.", "False pos.", "Unlabelled"), rev)
        + '<h4>Review-job runs by model</h4>' + _stat_table("Model", stats["review_runs_by_model"])
        + "<h4>Who catches a builder's defects</h4>"
        + tbl(ths("Builder", *classes, "Total"), mat)
        + '<h3>All time by model</h3>' + _svg_outcome_bars(stats["by_model"], "All time: verified runs by outcome")
        + _stat_table("Model", stats["by_model"], avg=stats["totals"]["fault_rate"])
        + '<p class="muted">Source: <code>.agents/subagent-*.jsonl</code>, <code>.agents/churn-cache/</code>. '
          'Refresh: <code>.agents/bin/pool-churn &amp;&amp; .agents/bin/pool-stats --write-stats</code>, then deploy '
          'trading-client.</p>'
        + _SORT_JS
    )


def _view_data(tickets: list[dict], graph: dict, nodes: list[dict], stats: dict | None = None) -> str:
    stores = graph.get("stores") or []
    flows = graph.get("flows") or []
    layers = _layer_map(graph)
    referenced = {f.get("from") for f in flows} | {f.get("to") for f in flows}
    actors = [n for n in nodes if n["id"] in referenced]
    return (
        f'<section class="doc-view" id="view-data">'
        f'<h1>2. Data State-Flow (How Data Moves)</h1>'
        f'<p class="view-lede">{len(stores)} stores across {len(layers)} layers, '
        f'joined by {len(flows)} flows. A store is a collection, not a service: '
        f'the join key is the contract between the two sides.</p>'
        f'{_data_svg(stores, flows, actors, tickets, nodes, layers)}'
        f'{_stats_section(stats or {})}'
        f'<h2>Store &amp; Collection Reference</h2>'
        f'{_store_table(stores, layers)}'
        f'<h2>Data Flow Edges</h2>'
        f'{_flow_table(flows)}'
        f'</section>'
    )


def _sev_tone(sev: str) -> str:
    return {"P0": "bad", "P1": "bad", "P2": "warn", "P3": "muted"}.get(sev, "muted")


def _status_tone(status: str) -> str:
    if status in ("wontfix", "wont-fix"):
        return "muted"
    if status in CLOSED_ALL:
        return "ok"
    if status == "blocked":
        return "bad"
    return "warn"


def _ticket_resolution(t: dict) -> str:
    closed_by = t.get("closed_by") or {}
    verified = t.get("verified_by") or {}
    closed = t.get("status") in CLOSED_ALL
    bits: list[str] = []
    if closed or closed_by:
        if closed_by.get("note"):
            bits.append(html.escape(str(closed_by["note"])))
        if closed_by.get("commit"):
            bits.append(f'<code>{html.escape(str(closed_by["commit"]))}</code>')
        if closed_by.get("date"):
            bits.append(f'<span class="muted">closed {html.escape(str(closed_by["date"]))}</span>')
    if verified.get("cmd"):
        bits.append(f'<code>{html.escape(str(verified["cmd"]))}</code>')
    if not closed and t.get("opened"):
        bits.append(f'<span class="muted">opened {html.escape(str(t["opened"]))}</span>')
    return " · ".join(bits) or '<span class="muted">—</span>'


def _ticket_rows(tickets: list[dict], nodes: list[dict], dates: dict,
                 today: str) -> str:
    rows = []
    for t in sorted(tickets, key=lambda t: (SEVERITY_ORDER.get(t.get("severity", ""), 9),
                                            t.get("id", ""))):
        nid = _ticket_node(t, nodes)
        status = t.get("status", "")
        sev = t.get("severity", "")
        owner = t.get("owner", "")
        flags = "".join(
            f'<span class="pill {"bad" if f == "REGRESSED" else "warn"}">{f}</span> '
            for f in _ticket_flags(t, today, dates)
        )
        covers = ", ".join(t.get("covers") or [])
        rows.append(
            f'<tr class="tck-row" data-node="{html.escape(nid, quote=True)}" '
            f'data-status="{html.escape(status, quote=True)}" '
            f'data-sev="{html.escape(sev, quote=True)}" '
            f'data-owner="{html.escape(owner, quote=True)}">'
            f'<td class="tck-idcell"><span class="tck-id">'
            f'{html.escape(t.get("id", ""))}</span> '
            f'<span class="pill {_sev_tone(sev)}">{html.escape(sev)}</span></td>'
            f'<td><span class="pill {_status_tone(status)}">{html.escape(status)}</span> {flags}</td>'
            f'<td><button type="button" class="pill info tck-node" '
            f'onclick="window.filterTicketsByNode(\'{html.escape(nid, quote=True)}\')">'
            f'{html.escape(nid)}</button>'
            f'<div class="muted tck-area">{html.escape(t.get("area", ""))} · '
            f'{html.escape(owner)}</div></td>'
            f'<td><div class="tck-title">{html.escape(t.get("title", ""))}</div>'
            f'<div class="muted">{html.escape(t.get("source_ref", ""))}'
            f'{(" · " + html.escape(covers)) if covers else ""}</div></td>'
            f'<td class="tck-res">{_ticket_resolution(t)}</td></tr>'
        )
    return "".join(rows)


def _view_tickets(tickets: list[dict], nodes: list[dict],
                  stats: dict[str, dict[str, int]], dates: dict) -> str:
    today = datetime.now(timezone.utc).date().isoformat()
    n_total = len(tickets)
    n_open = sum(1 for t in tickets if t.get("status") in ("open", "in_progress"))
    n_blocked = sum(1 for t in tickets if t.get("status") == "blocked")
    n_closed = sum(1 for t in tickets if t.get("status") in CLOSED_ALL)
    n_p0p1 = sum(1 for t in tickets
                 if t.get("status") in OPEN_STATUSES and t.get("severity") in ("P0", "P1"))

    def tile(label: str, value: object, note: str, tone: str) -> str:
        return (f'<div class="tile {tone}"><div class="label">{html.escape(label)}</div>'
                f'<div class="value">{html.escape(str(value))}</div>'
                f'<div class="note">{html.escape(note)}</div></div>')

    kpis = "".join([
        tile("Total Tickets", n_total, "every ticket ever opened", "ok"),
        tile("Open", n_open, "open + in-progress", "warn" if n_open else "ok"),
        tile("Blocked", n_blocked, "waiting on a decision or dependency",
             "bad" if n_blocked else "ok"),
        tile("Closed & Verified", n_closed, "closed + wont-fix", "ok"),
        tile("Open P0/P1", n_p0p1, "cycle-halting or wrong desk data",
             "bad" if n_p0p1 else "ok"),
    ])

    node_opts = ['<option value="">All Execution Nodes</option>']
    for n in sorted(nodes, key=lambda n: (int(n.get("stage", 0)), n["id"])):
        opened = stats[n["id"]]["open"]
        node_opts.append(
            f'<option value="{html.escape(n["id"], quote=True)}">'
            f'{html.escape(n["id"])} — {html.escape(_short_label(n.get("label", "")))} '
            f'({opened} open)</option>'
        )
    status_opts = "".join(
        f'<option value="{v}">{html.escape(label)}</option>'
        for v, label in (("", "All Statuses"), ("active", "Open & Blocked (Active)"),
                         ("open", "open"), ("blocked", "blocked"),
                         ("closed", "closed"), ("wontfix", "wontfix (duplicate / obsolete)"))
    )
    sev_opts = "".join(
        f'<option value="{v}">{html.escape(label)}</option>'
        for v, label in (("", "All Severities"), ("P0", "P0"), ("P1", "P1"),
                         ("P2", "P2"), ("P3", "P3"))
    )
    if ACTIVE_PROJECT == "trading-cycle":
        owners = ["trading-service", "lazy-agent-service", "scraper-service",
                  "trading-client", "operator"]
        owners += sorted({
            t.get("owner") for t in tickets
            if t.get("owner") and t.get("owner") not in owners
        })
    else:
        owners = sorted({t.get("owner", "") for t in tickets if t.get("owner")})
    owner_opts = '<option value="">All Owners</option>' + "".join(
        f'<option value="{html.escape(o, quote=True)}">{html.escape(o)}</option>'
        for o in owners
    )

    rows = _ticket_rows(tickets, nodes, dates, today)
    return (
        f'<section class="doc-view" id="view-tickets">'
        f'<h1>3. Roadmap &amp; Tickets</h1>'
        f'<p class="view-lede">Rendered from <code>tickets.jsonl</code>. Filter by node, '
        f'status, severity, owner or free text; every row links back to its graph node.</p>'
        f'<div class="status-grid">{kpis}</div>'
        f'<div class="ticket-filters">'
        f'<label>Node<select id="flt-node" onchange="window.applyTicketFilters()">'
        f'{"".join(node_opts)}</select></label>'
        f'<label>Status<select id="flt-status" onchange="window.applyTicketFilters()">'
        f'{status_opts}</select></label>'
        f'<label>Severity<select id="flt-sev" onchange="window.applyTicketFilters()">'
        f'{sev_opts}</select></label>'
        f'<label>Owner<select id="flt-owner" onchange="window.applyTicketFilters()">'
        f'{owner_opts}</select></label>'
        f'<label class="wide">Search<input id="flt-q" type="search" '
        f'placeholder="Filter by ID, title, file, commit, or command…" '
        f'oninput="window.applyTicketFilters()"></label>'
        f'<button type="button" onclick="window.resetTicketFilters()">Reset</button>'
        f'<span id="flt-count">Showing {n_total} of {n_total} tickets</span>'
        f'</div>'
        f'<div class="scroll-x"><table id="tickets-table"><thead><tr>'
        f'<th>ID</th><th>Status</th><th>Graph Node</th><th>Title &amp; Source</th>'
        f'<th>Verification / Resolution</th></tr></thead>'
        f'<tbody>{rows}</tbody></table></div>'
        f'</section>'
    )


def _project_bar() -> str:
    """The workspace project bar injected at the very top of <body>.

    Keep this in sync with stage_project_docs.py's `render_project_bar`: the
    staging script strips a previous bar with
    `<nav class="sun-project-bar"[^>]*>.*?</nav>` and re-injects it, so the bar
    must be one non-nesting <nav> whose style is scoped to the bar itself.
    """
    if not PROJECTS_JSON.exists():
        return ""
    try:
        projects = json.loads(PROJECTS_JSON.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"{PROJECTS_JSON.name} is not valid JSON: {e}")
    if not isinstance(projects, list):
        return ""
    style = (
        ".sun-project-bar{background:var(--panel-2,#181c23);"
        "border-bottom:1px solid var(--rule,#2b323c);"
        "padding:0.45rem 1.2rem;display:flex;flex-wrap:wrap;gap:0.35rem;"
        "align-items:center;font-family:system-ui,sans-serif;font-size:0.78rem;"
        "position:sticky;top:0;z-index:999;}"
        ".sun-project-bar .sun-proj-label{color:var(--ink-3,#8b95a3);"
        "text-transform:uppercase;letter-spacing:0.08em;margin-right:0.5rem;}"
        ".sun-project-bar .sun-proj-tab{color:var(--ink-2,#c8d0da);"
        "text-decoration:none;padding:0.22rem 0.7rem;border-radius:999px;"
        "border:1px solid var(--rule,#2b323c);white-space:nowrap;}"
        ".sun-project-bar .sun-proj-tab:hover{background:var(--panel-3,#212733);}"
        ".sun-project-bar .sun-proj-tab.active{"
        "background:var(--accent,#0f6f6c);color:#fff;font-weight:600;}"
    )
    tabs = []
    for p in projects:
        if not isinstance(p, dict) or not p.get("slug") or not p.get("href"):
            continue
        cls = "sun-proj-tab active" if p["slug"] == ACTIVE_PROJECT else "sun-proj-tab"
        tabs.append(
            f'<a href="{html.escape(p["href"], quote=True)}" class="{cls}" '
            f'title="{html.escape(", ".join(p.get("repos") or []), quote=True)}">'
            f'{html.escape(p.get("label") or p["slug"])}</a>'
        )
    return (
        '<nav class="sun-project-bar" aria-label="Workspace Projects">'
        f"<style>{style}</style>"
        '<span class="sun-proj-label">PROJECTS</span>'
        + "".join(tabs)
        + "</nav>"
    )


def _view_tabs(open_tickets: int, closed_tickets: int, n_chapters: int = 13) -> str:
    tabs = (
        ("exec", "1. Execution Graph (How It Works)"),
        ("data", "2. Data State-Flow (How Data Moves)"),
        ("tickets", f"3. Roadmap &amp; Tickets ({open_tickets} open / {closed_tickets} verified)"),
        ("ref", f"4. Reference &amp; Deep-Dive Specs ({n_chapters} chapters)"),
    )
    buttons = "".join(
        f'<button type="button" class="view-tab{" active" if i == 0 else ""}" '
        f'data-view="{v}" onclick="window.switchDocView(\'{v}\')">{label}</button>'
        for i, (v, label) in enumerate(tabs)
    )
    return (f'<nav class="view-switcher" aria-label="Documentation views">{buttons}</nav>')


def build() -> str:
    chapters = _read_chapters()
    if not chapters:
        raise SystemExit(f"No chapters found in {CHAPTERS_DIR}")

    tickets = _load_tickets()
    open_tickets = sum(1 for t in tickets if t.get("status") in OPEN_STATUSES)
    closed_tickets = sum(1 for t in tickets if t.get("status") in CLOSED_ALL)

    # One date cache for the whole build: `_ticket_flags` shells out to git per
    # covered file, and both the ledger chapter and view 3 need the same answer.
    dates: dict[str, str | None] = {}

    exec_graph = _load_graph(EXEC_GRAPH)
    data_graph = _load_graph(DATA_GRAPH)
    nodes = exec_graph.get("nodes") or []
    stats = _node_stats(tickets, nodes)

    title, subtitle = "Documentation", ""
    meta = DOCS_DIR / "meta.txt"
    if meta.exists():
        parts = meta.read_text(encoding="utf-8").strip().split("\n", 1)
        title = parts[0].strip() or title
        subtitle = parts[1].strip() if len(parts) > 1 else ""

    nav_parts, body_parts, touched = [], [], []
    chap_no = 0
    for group in _load_parts(chapters):
        if group["part"]:
            nav_parts.append(
                f'<li class="part" title="{html.escape(group["blurb"], quote=True)}">'
                f'{html.escape(group["part"])}</li>'
            )
            # A divider in the BODY too, not just the sidebar. Scrolling is how
            # this page is actually read, and a reader who only ever sees one
            # chapter after another has no sense of structure — which is what
            # made the flat version feel like a pile rather than a document.
            blurb = (
                f'<p>{html.escape(group["blurb"])}</p>' if group["blurb"] else ""
            )
            body_parts.append(
                f'<div class="part-divider">'
                f'<h2>{html.escape(group["part"])}</h2>{blurb}</div>'
            )
        for record in group["chapters"]:
            path, meta, md = record["path"], record["meta"], record["body"]
            is_ledger = path.name == LEDGER_CHAPTER
            if is_ledger:
                # The ledger chapter's body is generated from tickets.jsonl. Its
                # file keeps only the front matter, so the board can never drift
                # from the ledger and no one can hand-edit a stale backlog.
                md = _ticket_board(tickets, dates)
            chap_no += 1
            chap_ts = _last_touched(path)
            touched.append(chap_ts)
            sub_toc: list[dict] = []
            rendered = render_markdown(md, toc=sub_toc)
            m = re.search(r"^#\s+(.*)$", md, re.M)
            chap_title = m.group(1).strip() if m else path.stem
            chap_id = _slug(re.sub(r"^\d+[-_]", "", path.stem))
            status = (meta.get("status") or "").strip()
            # The status rides in the SIDEBAR as well as the body. A reader
            # scanning for "what is still open" should not have to open eleven
            # chapters to find the two that are still claims about the future.
            nav_status = (
                f'<span class="status s-{STATUS_TONE.get(status, "muted")}">'
                f'{html.escape(status)}</span>'
                if status else ""
            )
            if is_ledger:
                tone = "bad" if open_tickets else "ok"
                nav_status += (
                    f'<span class="status s-{tone}">{open_tickets} open</span>'
                )
            nav_parts.append(
                f'<li><a class="chapter" href="#{chap_id}">'
                f'<span class="num">{chap_no}</span>'
                f'<span class="title-text">{html.escape(chap_title)}</span>'
                f'{nav_status}'
                f'<span class="freshness badge" data-ts="{html.escape(chap_ts)}"></span>'
                f"</a></li>"
            )
            for entry in sub_toc:
                nav_parts.append(
                    f'<li><a class="sub" href="#{entry["id"]}">'
                    f'{html.escape(entry["text"])}</a></li>'
                )
            # The eyebrow repeats the part name in the body because the sidebar
            # is hidden on narrow screens and in print — without it a reader who
            # lands on a deep link has no idea which section they are in.
            eyebrow = (
                f'<p class="eyebrow">{html.escape(group["part"])}'
                f'<span class="sep">·</span>Chapter {chap_no}</p>'
                if group["part"] else ""
            )
            body_parts.append(
                f'<section class="chapter" id="{chap_id}">'
                f'<span class="freshness" data-ts="{html.escape(chap_ts)}"></span>'
                f"{eyebrow}{_status_bar(meta)}{rendered}</section>"
            )

    bench = sorted(BENCH_DIR.glob("*.md")) if BENCH_DIR.is_dir() else []
    if bench:
        nav_parts.append(f'<li class="part">{BENCH_PART}</li>')
        body_parts.append(f'<div class="part-divider"><h2>{BENCH_PART}</h2></div>')
    for path in bench:
        md = path.read_text(encoding="utf-8")
        bench_id = _bench_id(path.stem)
        bench_ts = _last_touched(path)
        touched.append(bench_ts)
        m = re.search(r"^#\s+(.*)$", md, re.M)
        nav_parts.append(
            f'<li><a class="chapter" href="#{bench_id}">'
            f'<span class="title-text">{html.escape(m.group(1).strip() if m else path.stem)}</span>'
            f'<span class="freshness badge" data-ts="{html.escape(bench_ts)}"></span>'
            f"</a></li>"
        )
        body_parts.append(
            f'<section class="chapter" id="{bench_id}">'
            f'<span class="freshness" data-ts="{html.escape(bench_ts)}"></span>'
            f'<p class="eyebrow">{BENCH_PART}</p>'
            f'{render_markdown(md, id_prefix=bench_id + "-")}</section>'
        )

    return PAGE.format(
        title=html.escape(title),
        subtitle=html.escape(subtitle),
        css=CSS,
        stamp=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        newest=html.escape(max(touched) if touched else ""),
        project_bar=_project_bar(),
        tabs=_view_tabs(open_tickets, closed_tickets, len(chapters)),
        view_exec=_view_exec(tickets, exec_graph, stats),
        view_data=_view_data(tickets, data_graph, nodes, _load_stats()),
        view_tickets=_view_tickets(tickets, nodes, stats, dates),
        nav="".join(nav_parts),
        body="\n".join(body_parts),
    )


def _strip_stamp(page: str) -> str:
    """Compare pages ignoring TIMESTAMPS, so --check reports real content drift.

    Two kinds of timestamp are neutralised, for the same reason:

    - the generation stamp, which differs on every rebuild;
    - the per-chapter ``data-ts`` freshness marks, whose SOURCE changes when a
      chapter is committed (an uncommitted edit is dated by mtime, a committed
      one by its commit date). Without this, `--check` failed immediately after
      every documentation commit and the Stop hook rebuilt, producing a fresh
      diff, which needed another commit — a loop that reported "stale" when
      nothing a reader can see had changed.

    Content drift still fails the check; only the clock is ignored. The marks
    refresh on the next real content rebuild, which is exactly when the thing
    they describe has actually moved.
    """
    page = re.sub(r"generated [^<]*", "", page)
    return re.sub(r'data-ts="[^"]*"', 'data-ts=""', page)


def status_report() -> list[dict]:
    """Every chapter's front matter, as data. This is what the daily audit reads.

    It lives in the builder rather than in the audit script so that a repo which
    only ever gets the kit copied in is still auditable — there is exactly one
    file that knows what a chapter looks like.
    """
    out = []
    for record in _read_chapters():
        meta = record["meta"]
        out.append({
            "file": record["path"].name,
            "part": meta.get("part", ""),
            "status": meta.get("status", ""),
            "updated": meta.get("updated", ""),
            "review_by": meta.get("review-by", ""),
            "owner": meta.get("owner", ""),
            "live": meta.get("status", "") in LIVE_STATUSES,
            "last_touched": _last_touched(record["path"]),
        })
    return out


def main() -> int:
    global ACTIVE_PROJECT

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="exit 1 if index.html is stale")
    ap.add_argument("--status", action="store_true",
                    help="print chapter front matter as JSON and exit")
    ap.add_argument("--docs-dir", metavar="PATH",
                    help="render another project's documentation/ tree")
    ap.add_argument("--project", metavar="SLUG",
                    help="project slug to mark active in the workspace project bar")
    args = ap.parse_args()

    if args.docs_dir:
        _use_docs_dir(Path(args.docs_dir).resolve())
    ACTIVE_PROJECT = args.project or _detect_project() or ACTIVE_PROJECT

    if args.status:
        import json as _json
        print(_json.dumps(status_report(), indent=2))
        return 0

    page = build()
    if args.check:
        if not OUTPUT.exists():
            print(f"STALE: {OUTPUT} does not exist. Run: python3 {Path(__file__).name}")
            return 1
        if _strip_stamp(OUTPUT.read_text(encoding="utf-8")) != _strip_stamp(page):
            print(f"STALE: {OUTPUT} does not match chapters/. Run: python3 {Path(__file__).name}")
            return 1
        print(f"OK: {OUTPUT.name} is up to date.")
        return 0

    OUTPUT.write_text(page, encoding="utf-8")
    n = len(list(CHAPTERS_DIR.glob("*.md")))
    print(f"Built {OUTPUT} from {n} chapter(s), {len(page):,} bytes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
