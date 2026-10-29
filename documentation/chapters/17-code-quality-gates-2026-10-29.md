---
title: Code Quality Gates — 2026-10-29
status: in-progress
updated: 2026-10-29
---

# Code Quality Gates — CRAP, duplication, architecture, dead code

First measured pass of the quality programme for `lazy-agent-service`.
All numbers are CONFIRMED by the commands named next to them and stored in
`.checks/quality-2026-10-29/`. Where a figure is a judgement (e.g. what counts
as "logic" duplication) it is labelled.

## Why

The repo had no measured quality gate: complexity was only visible through
ESLint warnings nobody read, duplication was estimated by token scanning, and
an earlier handoff claimed "0 functions over McCabe 30" that the first real
measurement contradicted (19 existed, including a 91-complexity stream reducer
in a file that handoff had touched). Coverage was unknown, and architecture
rules were not enforced.

## Baseline (before, `266a0ef`)

| metric | command | value |
|---|---|---|
| tracked `src/**/*.ts` | `git ls-files` | 528 files, 141,644 LOC (30,074 test LOC) |
| production functions | `node scripts/quality/crap.mjs` | 4,715 measured |
| McCabe > 30 | same | 19 (5 > 50, max 91) |
| McCabe > 120 lines | same | 78 |
| CRAP > 60 | same | 374 |
| coverage | `vitest run --coverage` | statements 44.77 %, branches 39.71 %, functions 53.70 %, lines 44.96 % |
| duplication (jscpd, logic) | `node scripts/quality/dry.mjs` | 2.94 % (3,179/108,095 lines, 205 clones) |
| architecture | `node scripts/quality/arch.mjs` | 109 `no-circular` warnings, 3 `services-no-routes` **errors** (`BenchmarkService`, `WallgardenService`, `WorkflowExecutionService` importing `handleConversation`/`handleAgent` from `routes/ChatRoutes.ts`) |
| dead code (knip) | `node scripts/quality/deadcode.mjs` | 230 findings (6 unused files, 58 unused exports, 161 unused types, 5 duplicate exports) |
| tests | `vitest run` | 180 files / 1,930 tests |

## Current (`a7d21db`, after this pass)

| metric | value |
|---|---|
| production functions | 4,840 measured |
| McCabe > 30 | **8** (AudioRoutes handler 50, ScheduledTaskService.tick 33, llama-cpp.getServerProps 32, AdminConversationRoutes 31, ConversationService.appendMessages 35, EmbeddingService.generate 32, PlatformRoutes 36, EmbedRoutes 31) |
| CRAP > 60 | **360** (from 374) |
| coverage | statements **47.33 %** (15,921/33,638), branches 42.07 %, functions 55.76 %, lines 47.65 % |
| duplication (logic) | **2.32 %** (2,528/109,081 lines, 180 clones); all 2.65 % |
| architecture | **0 errors**, 136 warnings (569 modules) — the three `services-no-routes` errors are gone |
| dead code | 234 findings (report-only) |
| tests | **189 files / 1,974 tests**, ~16 s |
| `npm run verify` | ~34 s on `main` |

The provider work alone removed 11 functions over complexity 30
(anthropic/openai/google stream reducers, `MemoryConsolidationService.consolidate`,
`RequestLogger.logChatGeneration`, `VllmModelSyncService.checkAndSync`) and
raised statement coverage by 2.6 points because the extracted reducers are
unit-testable.

## What landed

**Tooling (Phase 0).** `scripts/quality/{crap,dry,arch,deadcode,prompt-budget}.mjs`,
`.dependency-cruiser.cjs`, `knip.json`, ESLint ratchet (`complexity` warn 30,
`max-depth` 5, `max-params` 6, `max-lines-per-function` 150), npm scripts
`coverage`, `quality:crap|dry|arch|deadcode|prompt`, `quality`, `verify`.

**Architecture (Phase 1).** The chat generation implementation moved from
`src/routes/ChatRoutes.ts` to `src/core/chat/ChatGeneration.ts` (router file is
now thin). `services-no-routes` is an error; `no-circular` is a warning
(barrel-induced cycles, ratchet later).

**Duplication (Phase 2).** Shared `parseCsvFilter`/`buildAdminMatch` in
`src/utils/QueryBuilders.ts`; one definition-registry builder
(`definitionRegistry.ts`) for Topology and Thought Structure; ToT/GoT shared
plumbing (`strategies/shared.ts`); one frontmatter parser
(`src/platform/frontmatter.ts`); table-driven somatic keyword effects; provider
payload builders and per-event stream reducers.

**Model-agnostic harness (Phase 4).**
- `src/providers/inworld.ts` reads `ttsSteering` from the catalog instead of
  `model.startsWith("inworld-tts-2")`; unknown TTS models take the current
  protocol.
- `src/providers/openai.ts` reasoning detection reads the catalog `thinking`
  flag; unknown models take the reasoning-safe path (omit sampling, send
  `max_completion_tokens`).
- `getModelProfile` is catalog-first: limits (`maxInputTokens`,
  `maxOutputTokens`), effort vocabulary (`thinkingLevels`) and "does it think"
  (`thinking`) come from the catalog; family name patterns are only a fallback
  for unlisted models.
- `code_health` tool (`tool_schemas/shared/quality.json`,
  `LocalToolRouter`): deterministic in-process measurement of submitted files —
  per-function complexity, long functions, duplicate token windows, unused
  exports. No filesystem access, no shell, no network, 50-file/2 MB budget.
- `CriticGate` judges with a different model of the same provider and reports
  `judgeIndependent`, so an approval is not the author model grading itself.
- Progressive-disclosure budget: full tool catalog 12,888 tokens vs compact
  2,918 tokens (22.6 %); 10 descriptions exceed 600 chars
  (`canvas_add_widget` is 6,862) — reported, not gated, because rewriting tool
  contracts is a product decision.

**CI (Phase 3).** `.github/workflows/quality.yml` runs `npm run verify` on
push/PR and a nightly `npm run quality` (coverage CRAP + dead code) with report
artifacts. The repo's `.git/hooks/pre-push` is owned by the workspace secret
scanner, so the quality gate lives in CI instead of a second local hook.

## Gates

| gate | threshold | blocks? |
|---|---|---|
| `npm run lint` | complexity warn 30, depth 5, params 6, function lines 150 | warnings only |
| `npm run quality:crap` | cx > 30 or CRAP > 60 per function | yes |
| `npm run quality:dry` | logic duplication ≤ 8 % (declarative tables excluded) | yes |
| `npm run quality:arch` | 0 dependency errors | yes |
| `npm run quality:prompt` | compact ≤ 50 % of full, full ≤ 15,000 tokens | yes |
| `npm run quality:deadcode` | report only | no |

`verify` runs typecheck → lint → tests → dry → arch → prompt. It deliberately
does not run `prettier --check`: the repo has never been Prettier-formatted
(406 files), and a mass reformat would bury every real diff.

## Remaining (ratchet plan)

1. The 8 functions still over 30 and 360 over CRAP 60 — decompose in batches,
   then tighten the ESLint `complexity` rule from warn to **error at 20**.
2. 136 `no-circular` warnings: fix the real cycles, then make the rule an
   error; barrel-only cycles get an allowlist.
3. 234 knip findings: delete unused exports/types in a dedicated batch and add
   a `CONTRACT_OWNERSHIP.md` owner list before enforcing.
4. Coverage: no per-directory floor yet; add one after the CRAP batch.

## Verify it yourself

```bash
cd agents/lazy-agent-service
npm run verify                 # 34 s gate
npm run quality:crap           # coverage + CRAP report
node scripts/quality/prompt-budget.mjs
```

Reports: `.checks/quality-2026-10-29/{crap,dry,arch,deadcode,prompt-budget}.{json,md}`.
