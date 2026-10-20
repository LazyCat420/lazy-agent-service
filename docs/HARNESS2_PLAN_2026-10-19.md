# Harness² (recursive agent harnessing) port — plan, 2026-10-19

Source: https://github.com/google-research/harness2 (`harness2/core/recursion.py`,
`prompts.py`, `library.py`, read 2026-10-19). Paper: arXiv 2610.14224.

## Verified starting state (2026-10-19)

| Claim | Class | Evidence |
|---|---|---|
| No harness² code exists in this service | Verified | grep `harness2|propose.*probe|improvement harness|reflector` over `src docs documentation skills packages` = 0 hits |
| `runSingleModel(benchmark, model, …)` executes one real run with a caller system prompt and returns response + tool calls | Verified | `src/services/BenchmarkService.ts:323` |
| `getProvider(id).generateText(messages, model, opts)` returns `{text, usage}` | Verified | `src/types/provider.ts:149`, used by `MemoryExtractor.ts:279` |
| Routes mount via `src/index.ts` like `ExperimentRoutes` | Verified | `src/index.ts:79` |

## What is ported

Task-level recursion (Propose–Probe–Compose) and harnessing-level recursion (library),
faithful to upstream structure:

1. **Harness tree** (`harness2/HarnessTree.ts`). Editable surface for this substrate:
   `systemprompt.md`, `guardrails.md`, `memory.md`, `tool_guidance.md`,
   `skills/<name>/SKILL.md`. Validation as upstream: skill frontmatter `name` = dir +
   `description`, every skill named verbatim in `systemprompt.md`/`guardrails.md`, no
   `{{`/`{%` in always-on text, `systemprompt.md` non-empty, no grader-verdict phrases.
   Materialised into the run's system prompt (always-on files, then the triggered skills).
2. **Prompts** (`harness2/Prompts.ts`): `propose` (INV/DOM), `aggregate`, `composeRound`,
   `select`, `experience`, ported text with this substrate's surface block. Proposals reply
   with `<file path>`/`<delete path>` blocks + `<notes>` (no on-disk session here).
3. **Recursion** (`harness2/Recursion.ts`): `runParallel` (2k INV/DOM candidates, k
   compositions) and `runSequential` (k rounds of INV+DOM then compose). Each stage gets 2
   attempts; an invalid proposal falls back to the current harness. Both schedule 4k
   rollouts and 3k stages including k base rollouts.
4. **Selection** (`harness2/Selection.ts`): blind, shuffled pick over base + final outputs.
5. **Library** (`harness2/Library.ts`): per-domain, on disk under
   `runtime-data/harness2/<domain>/` (`HARNESS2_LIBRARY_PATH` override). Stores the full
   adopted tree + `EXPERIENCE.md`; refuses an entry without cue/lesson/evidence; rebuilds
   `INDEX.md`; fed to every proposer stage of later tasks in the domain.
6. **Service + route**: `Harness2Service.run()` wires executor (`runSingleModel`) and
   proposer (`generateText`), then select → experience → library add.
   `POST /harness2/run`.

## Out of scope

Sub-agents, scripts and plugins components (no on-demand execution surface for them in
this substrate — upstream also makes the surface substrate-specific); benchmark adapters
(JobBench/LAB/WorkBuddy); cost ledger in USD; wiring adopted harnesses into the live
`/agent` production prompt path (trading runs must stay untouched).

## Acceptance

- A1 unit: tree validation rejects each of the upstream rule violations; accepts valid.
- A2 unit: parallel k=2 schedules exactly 8 rollouts and 6 stages; sequential k=2 the same;
  an invalid proposal is retried once, then falls back (`fellBack=true`, tree = base).
- A3 unit: library refuses entry without experience; stores tree; index lists entry; next
  task's proposer prompt contains the library index (dependency-chain assertion).
- A4 smoke: `POST /harness2/run` against a live local model, k=1, produces 4 rollouts, a
  selected output, and (when the reflector writes one) a library entry on disk.
- `npx tsc --noEmit` clean for the new files; vitest green for `src/services/harness2`.

## Verification (2026-10-19, on main)

- `npx tsc --noEmit`: no errors in `src/services/harness2`, `Harness2Routes.ts`, `BenchmarkService.ts`.
- `npx vitest run src/services/harness2`: 15/15 pass (A1–A3). Mutation check: passing `libraryText: ""`
  turns the library dependency-chain test red; restored.
- Live smoke (throwaway script, Jetson `nemotron35` as solver + improver, k=1 parallel, two
  bookkeeping tasks, temp library deleted afterwards): each task scheduled base1/inv1/dom1/agg1 (4
  rollouts, 3 stages); one DOM proposal with a bad skill frontmatter was retried with the rejection,
  then fell back; library went 0 → 1 → 2 entries; task-2 proposer prompts carried the library
  (inv1 prompt 5,026 → 7,770 chars).
- NOT verified: `makeExecutor`/`makeProposer` (the `runSingleModel` / `generateText` wiring) and the
  `POST /harness2/run` route against a running service; not deployed.

## Known quality limit seen in the smoke

Nemotron as improver confabulated: the selector called a wrong total "the exact correct sum", and
the reflector wrote "high confidence" lessons from differences that were sampling noise (agg1 was
KEEP_BASE, identical to base). The method is faithful; its judgement is only as good as the
improver model. Use a stronger `improver` (GLM 5.3 / Claude) than the solver.
