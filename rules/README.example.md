# Path-Scoped Rules

Markdown files in this directory are loaded by `src/platform/rules/RuleLoader.ts`
and injected into the agent's dynamic-tail layer **only when the agent touches a
file matching the rule's `paths` globs**.

## File format

````markdown
---
name: testing-policy
description: How to write and run tests in this repo
paths:
  - "src/**/__tests__/**"
  - "*.test.ts"
---

Your rule body in markdown.
````

- `name` and `description` are required metadata; `paths` is a list of globs
  (`*` matches within a path segment, `**` crosses directories).
- Files without valid frontmatter (like this README) are skipped.
- Copy this file to `my-rule.md.example`-style content minus the `.example`
  logic — any `*.md` file with frontmatter becomes an active rule.
