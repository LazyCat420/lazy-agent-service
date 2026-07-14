# Tool schema sources

This folder is the **source of truth** for the shared tool registry. One file
per owning app + domain, each a bare JSON array of tool entries:

```
tool_schemas/
  trading/        # trading-service pipeline + chat agent tools
  html-notes/     # HTML-Notes / canvas / widget tools
  treesearch/     # strain_* tools
```

The flat `tool_schemas.json` files at the roots of lazy-tool-service,
trading-service, and trading-client are **build artifacts** — never edit them
by hand. Regenerate them with:

```
python3 ../trading-service/scripts/build_tool_schemas.py
```

(also run automatically by `deploy.sh`). The build validates unique names and
required keys, stamps `owner_app` from the folder, and writes byte-identical
copies to all three repos (asserted by
`trading-service/tests/test_multi_repo_audit.py`).

To refresh schemas from prism + the native Python registry, run
`trading-service/scripts/update_tool_schemas.py`, which rewrites these source
files and then rebuilds the flat artifacts.
