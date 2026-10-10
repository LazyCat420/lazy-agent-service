#!/usr/bin/env python3
"""Regenerate tool_schemas.json from the tool_schemas/<group>/*.json shards.

WHY: ToolSchemaService loads tool_schemas.json at runtime, but editing that file
by hand drifts from the per-group shards (this bit us on 2026-10-10 when a stale
regen reverted scrape_url's description and dropped its char_limit param).
The shards are the source of truth; this script is the only writer.

Usage:
  python3 scripts/export_tool_schemas.py            # write tool_schemas.json
  python3 scripts/export_tool_schemas.py --check    # exit 1 if it would change

Merge rules:
  - every tool_schemas/*/*.json (excluding tool_schemas/README.md) is an array
    of schema objects;
  - groups are concatenated in sorted path order; within a group, sorted filename
    order, then array order;
  - duplicate tool names are an error (fail loudly, never silently dedupe).
"""
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tool_schemas.json")


def collect() -> list[dict]:
    merged: list[dict] = []
    seen: set[str] = set()
    shards = sorted(glob.glob(os.path.join(ROOT, "tool_schemas", "*", "*.json")))
    if not shards:
        sys.exit("export_tool_schemas: no shard files found under tool_schemas/*/")
    for path in shards:
        with open(path, encoding="utf-8") as f:
            entries = json.load(f)
        if not isinstance(entries, list):
            sys.exit(f"export_tool_schemas: {path} must contain a JSON array")
        for entry in entries:
            name = entry.get("name")
            if not name:
                sys.exit(f"export_tool_schemas: entry without 'name' in {path}")
            if name in seen:
                sys.exit(f"export_tool_schemas: duplicate tool '{name}' (also in another shard)")
            seen.add(name)
            merged.append(entry)
    return merged


def main() -> None:
    merged = collect()
    rendered = json.dumps(merged, indent=2, ensure_ascii=False) + "\n"
    check = "--check" in sys.argv
    current = None
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            current = f.read()
    if current == rendered:
        print(f"export_tool_schemas: {len(merged)} tools, up to date")
        return
    if check:
        sys.exit(f"export_tool_schemas: tool_schemas.json is STALE ({len(merged)} tools in shards). Run: python3 scripts/export_tool_schemas.py")
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(rendered)
    print(f"export_tool_schemas: wrote {len(merged)} tools to tool_schemas.json")


if __name__ == "__main__":
    main()
