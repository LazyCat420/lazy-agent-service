#!/usr/bin/env python3
"""Regenerate tool_schemas.json from the tool_schemas/<group>/*.json shards.

WHY: ToolSchemaService loads tool_schemas.json at runtime, but editing that file
by hand drifts from the per-group shards (this bit us on 2026-10-10 when a stale
regen reverted scrape_url's description and dropped its char_limit param).
The shards are the source of truth and this script is the ONLY generator of the
flat file, for every repo that carries a copy. trading-service and
trading-client call it with `--out` to write their own copy; nothing else may
write a tool_schemas.json. (Until 2026-10-22 trading-service's
build_tool_schemas.py was a second generator that wrote into this repo too, so
whichever deploy ran last decided what shipped -- trading-client ch.47.)

Usage:
  python3 scripts/export_tool_schemas.py               # write ./tool_schemas.json
  python3 scripts/export_tool_schemas.py --check       # exit 1 if it would change
  python3 scripts/export_tool_schemas.py --out PATH    # write PATH only (other repos)
  python3 scripts/export_tool_schemas.py --out PATH --check
  python3 scripts/export_tool_schemas.py --supports-out  # exit 0: lets callers
                                                         # refuse an older exporter

Merge rules:
  - every tool_schemas/<owner_app>/*.json is a JSON array of schema objects;
  - each entry needs name, description and parameters;
  - an entry without owner_app gets its shard folder's name (trading,
    shared, html-notes, ...): consumers filter on it;
  - duplicate tool names are an error (fail loudly, never silently dedupe);
  - output is sorted by (owner_app, name) so every copy is byte-identical.
"""
import glob
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "tool_schemas.json")
REQUIRED_KEYS = ("name", "description", "parameters")


def collect(root: str = ROOT) -> list[dict]:
    merged: list[dict] = []
    seen: dict[str, str] = {}
    shards = sorted(glob.glob(os.path.join(root, "tool_schemas", "*", "*.json")))
    if not shards:
        sys.exit("export_tool_schemas: no shard files found under tool_schemas/*/")
    for path in shards:
        rel = os.path.relpath(path, root)
        owner = os.path.basename(os.path.dirname(path))
        with open(path, encoding="utf-8") as f:
            entries = json.load(f)
        if not isinstance(entries, list):
            sys.exit(f"export_tool_schemas: {rel} must contain a JSON array")
        for entry in entries:
            if not isinstance(entry, dict):
                sys.exit(f"export_tool_schemas: non-object entry in {rel}")
            missing = [k for k in REQUIRED_KEYS if k not in entry]
            if missing:
                sys.exit(f"export_tool_schemas: {entry.get('name', '?')} in {rel} is missing {missing}")
            name = entry["name"]
            if name in seen:
                sys.exit(f"export_tool_schemas: duplicate tool '{name}' in {rel} (also in {seen[name]})")
            seen[name] = rel
            entry.setdefault("owner_app", owner)
            merged.append(entry)
    merged.sort(key=lambda t: (t.get("owner_app", ""), t["name"]))
    return merged


def render(merged: list[dict]) -> str:
    return json.dumps(merged, indent=2, ensure_ascii=False) + "\n"


def publish(out: str, text: str) -> None:
    """Replace `out` whole: write a temp file beside it, then os.replace.

    Each consumer regenerates its copy right before taking its Docker build
    context, and builds run in parallel, so a reader must never see a
    half-written file. A failed publish leaves the previous copy untouched.
    """
    directory = os.path.dirname(out) or "."
    fd, temporary = tempfile.mkstemp(prefix=".tool-schemas-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(temporary, os.stat(out).st_mode & 0o777 if os.path.exists(out) else 0o644)
        os.replace(temporary, out)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _parse_args(argv: list[str]) -> tuple[str, bool]:
    out, check, i = DEFAULT_OUT, False, 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--check":
            check = True
        elif arg == "--out":
            if i + 1 >= len(argv):
                sys.exit("export_tool_schemas: --out needs a path")
            out = os.path.abspath(argv[i + 1])
            i += 1
        elif arg == "--supports-out":
            sys.exit(0)
        else:
            sys.exit(f"export_tool_schemas: unknown argument {arg!r}")
        i += 1
    return out, check


def main(argv: list[str]) -> None:
    out, check = _parse_args(argv)
    merged = collect()
    rendered = render(merged)
    label = os.path.relpath(out) if out != DEFAULT_OUT else "tool_schemas.json"
    current = None
    if os.path.exists(out):
        with open(out, encoding="utf-8") as f:
            current = f.read()
    if current == rendered:
        print(f"export_tool_schemas: {len(merged)} tools, {label} up to date")
        return
    if check:
        sys.exit(f"export_tool_schemas: {label} is STALE ({len(merged)} tools in shards). "
                 f"Run: python3 scripts/export_tool_schemas.py" + (f" --out {out}" if out != DEFAULT_OUT else ""))
    publish(out, rendered)
    print(f"export_tool_schemas: wrote {len(merged)} tools to {label}")


if __name__ == "__main__":
    main(sys.argv[1:])
