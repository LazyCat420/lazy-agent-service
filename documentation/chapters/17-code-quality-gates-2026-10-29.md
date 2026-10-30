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

## Current (`18df632`, after this pass)

| metric | value |
|---|---|
| production functions | 4,889 measured |
| McCabe > 30 | **0** (was 19; the last 8 were decomposed: AudioRoutes 50, PlatformRoutes 36, ConversationService.appendMessages 35, ScheduledTaskService.tick 33, llama-cpp.getServerProps 32, EmbeddingService.generate 32, AdminConversationRoutes 31, EmbedRoutes 31) |
| CRAP > 60 | **353** (from 374); ratchet ceiling 360 |
| coverage | statements **47.85 %** (16,087/33,613), branches 42.94 %, functions 56.14 %, lines 48.20 % |
| duplication (logic) | **2.26 %** (2,476/109,545 lines, 177 clones); all 2.59 % |
| architecture | **0 errors**, 137 warnings (570 modules) — the three `services-no-routes` errors are gone |
| dead code | 228 findings (0 unused files, 58 unused exports, 165 unused types, 5 duplicate exports) |
| tests | **193 files / 2,000 tests**, ~16 s |
| `npm run verify` | ~35 s on `main` |

The provider work alone removed 11 functions over complexity 30
(anthropic/openai/google stream reducers, `MemoryConsolidationService.consolidate`,
`RequestLogger.logChatGeneration`, `VllmModelSyncService.checkAndSync`) and
raised statement coverage by 2.6 points because the extracted reducers are
unit-testable.

## What landed

**Tooling (Phase 0).** `scripts/quality/{crap,dry,arch,deadcode,prompt-budget}.mjs`,
`.dependency-cruiser.cjs`, `knip.json`, ESLint ratchet (`complexity` warn **20** after the decomposition batch,
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

**Applied methodology (research → code).** Four practices were adopted from the
literature and made mechanical rather than advisory:
- *Spec-driven development*: gates are executable and evidence-backed; a claim
  of "done" must be reproducible by a command, not a narrative.
- *Context engineering / progressive disclosure*: tool descriptions are paid on
  every turn, so the compact level is measured and capped (`prompt-budget.mjs`).
- *Agentic-harness engineering*: sensors must be deterministic and cheap —
  `code_health` runs in-process over submitted content, no shell/FS/network.
- *LLM-as-judge guardrails*: the judge must not be the author; `CriticGate`
  selects a different model of the same provider and reports
  `judgeIndependent` in every result.

**CI (Phase 3).** `.github/workflows/quality.yml` runs `npm run verify` on
push/PR and a nightly `npm run quality` (coverage CRAP + dead code) with report
artifacts. The repo's `.git/hooks/pre-push` is owned by the workspace secret
scanner, so the quality gate lives in CI instead of a second local hook.

## Gates

| gate | threshold | blocks? |
|---|---|---|
| `npm run lint` | complexity warn **20**, depth 5, params 6, function lines 150 | warnings only (97 complexity warnings today) |
| `npm run quality:crap` | 0 functions over cx 30; at most 360 functions over CRAP 60 (ratchet, lower as coverage rises) | yes |
| `npm run quality:dry` | logic duplication ≤ 8 % (declarative tables excluded) | yes |
| `npm run quality:arch` | 0 dependency errors | yes |
| `npm run quality:prompt` | compact ≤ 50 % of full, full ≤ 15,000 tokens | yes |
| `npm run quality:deadcode` | report only | no |

`verify` runs typecheck → lint → tests → dry → arch → prompt. It deliberately
does not run `prettier --check`: the repo has never been Prettier-formatted
(406 files), and a mass reformat would bury every real diff.

## Remaining (ratchet plan)

1. **0 functions over McCabe 30** now, but 353 are over CRAP 60 because their
   coverage is 0–20 %. The lever is tests, not more decomposition: add
   coverage where CRAP is high, then lower the `--max-crap-count` ceiling
   (360 → 300 → …) and tighten the ESLint `complexity` rule from warn to
   **error at 20**.
2. 136 `no-circular` warnings: fix the real cycles, then make the rule an
   error; barrel-only cycles get an allowlist.
3. 234 knip findings: delete unused exports/types in a dedicated batch and add
   a `CONTRACT_OWNERSHIP.md` owner list before enforcing.
4. Coverage: no per-directory floor yet; add one after the CRAP batch.

## Live verification (2026-10-30, deployed `57572df`)

`scripts/eval/run-basic-eval.mjs`, 8 questions × 2 profiles (`trading`,
`html-notes`), GLM-5.3 judge, concurrency 1, against `http://10.0.0.16:5591`.

| profile | grades | wall s before → after | tool calls | tokens |
|---|---|---|---|---|
| trading | 7 PASS / 1 WEAK → same | 810 → 578 (−29 %) | 21 → 22 | 68,433 → 75,736 |
| html-notes | 7 PASS / 1 WEAK → same | 877 → 566 (−36 %) | 12 → 13 | 46,865 → 48,404 |
| total | 14 PASS / 2 WEAK → same | **1,688 → 1,144 (−32 %)** | 33 → 35 | 115,298 → 124,140 (+7.7 %) |

LIKELY, not proven: one sample per question, uncontrolled backend load; the
grades and tool counts show no behavioural regression.

## Verify it yourself

```bash
cd agents/lazy-agent-service
npm run verify                 # 34 s gate
npm run quality:crap           # coverage + CRAP report
node scripts/quality/prompt-budget.mjs
```

Reports: `.checks/quality-2026-10-30/{crap,dry,arch,deadcode,prompt-budget}.{json,md}`;
live eval: `.checks/eval-baseline-2026-10-29/` and `.checks/eval-after-2026-10-29/`.
