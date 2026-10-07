---
name: repo-triage
description: Systematic triage of a failing test or broken build in this repository
tools:
  - shell
  - read_file
---

# Repo Triage Skill

1. **Reproduce** — run the single failing test file first, never the full suite:
   `bunx vitest run <file> --exclude "**/.worktrees/**"`.
2. **Isolate** — read the failing assertion, then the smallest code path that
   feeds it. Do not open files speculatively.
3. **Diagnose** — state the root cause in one sentence before editing anything.
4. **Fix** — edit the source, not the symptom. If the test pins incidental
   behavior, delete the test instead of re-pinning it.
5. **Verify** — re-run the same single test file and report its output.

Stop and report if two independent fix attempts fail — change approach.
