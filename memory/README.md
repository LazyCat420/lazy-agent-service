# Always-On Memory

Every `*.md` file in this directory is loaded verbatim into the projectScope
layer of the assembled context on **every** run (see
`src/platform/context/ContextAssembly.ts`). Keep entries short, durable and
project-scoped — this is the wrong place for anything task-specific.

Example `conventions.md`:

```markdown
- This repo uses TypeScript ESM (`"type": "module"`) with explicit `.ts`
  import extensions.
- Never run the full test suite; per-file vitest only.
```

This README is skipped by the loader (`README*` is ignored), so it will not
reach the prompt.
