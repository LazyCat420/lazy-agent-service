---
part: Plans
status: in-progress
updated: 2026-10-22
review-by: 2026-11-05
---

# Harness² Self-Improving Loop — Deep Audit (2026-10-22)

This chapter audits the Harness² port (`src/services/harness2/`, `POST /harness2/run`; commits
`8e242aa` + `430d150`, 2026-10-19) against Google's reference code, traces how its rollouts run
through this service's agentic harness, and lists what is missing, unfinished, or duplicated. It
ends with an ordered fix plan. The audit itself changed nothing in `src/` (landed `1b3c000`).

**Fix status.** The Phase 1 fixes in §6 are landing in three chunks:
- (a) learning gates, selection and run status;
- (b) the proposer contract, library hygiene and prompts;
- (c) the route and the executor.

Each fixed finding below carries a **Status** line. §9 records how each chunk was verified.

- **Upstream:** <https://github.com/google-research/harness2> at `1cfe254` (2026-10-13). That
  commit is the latest, so the 10-19 port and this audit read the same code. Paper: arXiv 2610.14224.
- **Ours:** `main` @ `a4ae118`. The harness2 files are byte-identical on the primary checkout.
- **Labels:** **CONFIRMED** means reproduced by `scripts/audit-harness2-loop.ts` (check id `R<n>`)
  or read in code at the cited line. **REPORTED** means found by a code sweep and spot-checked.
  **HYPOTHESIS** means plausible but not proven; nothing else in this chapter builds on one.

## 1. Verdict: REQUEST CHANGES

The **task-level schedule is faithful**. The details are listed in §5 so nobody "fixes" them:
- the 4k-rollout / 3k-stage budget, the INV/DOM split, one retry then fallback, KEEP_BASE;
- sequential checkpoints, and the parallel compose.

**The decision points around the schedule are not faithful.** These are what gets selected, what
gets stored, what evidence the improver sees, and what a skill costs. Three of them corrupt what
the loop learns:
1. Failed runs still write library lessons (R4, R5). **Fixed in `94883af`.**
2. Empty or cut-off improver replies are recorded as deliberate "keep the base" decisions (R2, R3).
   **Fixed in `a3993ea`.**
3. A re-run task reads its own earlier answer (R6). **Fixed in `a3993ea`.**

**The loop is also not closed.** Nothing outside `/harness2` reads the library or an adopted
harness (§4.B4), so no production agent improves from it. The rollouts don't run the real agent
either (§4.B1). The only domain tool is `calculate_precise`, plus the loop's own internal tools.
The "how the agent works" (INV) half of the method therefore has almost nothing to optimise.

**Exposure today is small:** the route is live on the NAS, but no library exists there yet (§2).
That makes this the right time to fix it, before anyone relies on stored lessons.

## 2. Measured baseline

| Check | Result | Label |
|---|---|---|
| `vitest run src/services/harness2` (testrun, primary checkout @ `a4ae118`) | 1 file, **15/15 pass** | CONFIRMED |
| `scripts/audit-harness2-loop.ts` (testrun, fake deps, no network) | **20/20 defects reproduce** (§7) | CONFIRMED |
| NAS `GET :5591/harness2/library/audit-probe-x` | `200 {"entries":[],"context":""}`, so the route is deployed | CONFIRMED |
| NAS `/volume1/docker/lazy-agent-service/runtime-data/` | no `harness2/` directory: the endpoint has never stored an entry | CONFIRMED |
| Library persistence across deploys | `docker-compose.yml:33` bind-mounts `./runtime-data`, so it survives redeploys | CONFIRMED |

**The green suite covers none of the defects below.** The tests exercise the schedule, the
validation rules, and the library's happy path. They never reach the failure branches,
selection, retention, or the executor and proposer wiring (`makeExecutor` / `makeProposer` and
the route have no test).

## 3. How the loop works, and where ours departs

```
 base rollouts (k)                  ← ours: no "all bases failed" stop            [A4]
      │
 Propose: INV + DOM candidates      ← ours: empty/cut reply = KEEP_BASE            [A5]
      │   (2 attempts, validate)    ← ours: no transport retry, retry is blind,
      │                                     first error only, no auto-trigger      [A6]
 Probe: roll each candidate once    ← ours: 1 domain tool, extra prompt layers     [B1, B2]
      │
 Compose (agg / c_t)                ← evidence clipped; prompt grows unbounded     [A9]
      │
 Select (blind)                     ← ours: base runs in the pool, selector at k=1,
      │                                     same order every task                  [A1, A2]
 Reflect → EXPERIENCE               ← ours: runs even when selection failed;
      │                                     no id→label map                        [A3, A8]
 Library (per domain)               ← ours: reads own entry on re-run, evicts by name,
                                            one library forever, '..' escapes      [A7, C3]
      ╳  nothing feeds an adopted harness back into production agents             [B4]
```

| Upstream module (`harness2/core/`) | Ours | State |
|---|---|---|
| `recursion.py` (`run_parallel`, `run_sequential`, `_run_stage`) | `Recursion.ts` | Schedule faithful. Stage acceptance is not: no `autotrigger` (`recursion.py:116`), the rejected tree is not handed back (`:228`), the empty-tree check is gone (`:214`) |
| `schedule.py` (`run_task`, `run_domain`, resume, `summary.json`) | `runHarness2` | Gates missing: base-failed (`:629`), reflect and store only on `sel.ok` (`:529`, `:555`), trivial k=1 selection (`:514`), `lib.retain` (`:701`). No run record or resume |
| `selection.py` | `selectOutput` in `Harness2Service.ts` | Pool and seeding differ (A1, A2); the reflection gets no id map (A8) |
| `library.py` | `Library.ts` | No `retain`/`forget` (`:90`, `:101`); one library forever instead of one per run and mode (`:23`) |
| `context.py` (evidence written as files, no clipping) | `buildMission` (everything inlined into one prompt) | A substrate adaptation, but its clipping is below upstream's floor (A9) |
| `tree.py` | `HarnessTree.ts` | No always-on cap, first error only, no `autotrigger`, different diversity metric |
| `proposer.py` (an agent session with file access, retries, audit trail) | `makeProposer`: one `generateText` call | Empty reply returns `""` (`Harness2Service.ts:166`); upstream: "Never swallowed into an empty string" (`proposer.py:62`) |
| `prompts.py` (66 KB) | `Prompts.ts` (16 KB) | Stage prompts condensed but faithful; surface, GENERALIZE, select and experience lost rules that matter (A10, A12, A8) |
| `ledger.py`, `judge.py`, `report.py`, `runmark.py` | not ported | Budget identity is covered by unit tests only; no judge (by design) |

## 4. Findings

### A. The loop's decision points

**A1 — The selection pool includes the base runs, and k=1 still runs a selector.** CONFIRMED (R17).
- **Ours:** `selectOutput` builds the pool from the base rollouts plus the finals
  (`Harness2Service.ts:111`). Its comment calls this the upstream "mixed" pool.
- **Upstream:** `selection_pool` is "exactly the k finals… the reference executions are not in
  the pool… the only pool this release builds" (`selection.py:93`). `run_task` refuses any other
  policy. At k=1, upstream delivers the single final with **no selector call**
  (`trivial_selection`, `schedule.py:514`).
- **Effect:** our method is not the one the paper measured. Every k=1 run spends an extra
  improver call, and a base output can be "adopted", which then stores the base tree as a lesson.
  The mixed pool does have a real argument (it lets an unadapted answer win when adaptation hurt).
  That makes this a **decision for the user** (§6 Q1), not a silent default.
- **Status: default changed to upstream's in `94883af`; Q1 is still open for the user.**
  - The pool is now the k finals. At k=1 the single final is delivered with no selector call
    (`selection.trivial`).
  - `selectionPool: "mixed"` keeps the old pool as an opt-in.
  - **Consequence at k=1:** if `agg1` delivers nothing, the run returns status `no-output` and
    no output, even when `base1` delivered. Every rollout's output stays in `result.rollouts`.

**A2 — The "blind, shuffled" order is the same for every task.** CONFIRMED (R1).
- **Ours:** the seed defaults to `0` (`Harness2Service.ts:188`), so a 2-candidate pool always
  comes out `[agg1, base1]`. Upstream seeds per task: `sha1(task|k|mode)` (`selection.py:71`).
- **Effect:** in the repro, a selector that always answers `a1` picked `agg1` on 12 of 12
  different tasks. LLM selectors do lean toward one position, so this turns position bias into a
  systematic pro-adaptation bias.
- **Status: fixed in `94883af`.** `selectionSeed` hashes `task|k|mode` (plus the caller's `seed`
  when given) and shuffles a canonical sort, as upstream's `assign_ids` does.

**A3 — Failed selections still write library lessons.** CONFIRMED (R4, R5).
- **Ours:** reflection and `library.add` run unconditionally (`Harness2Service.ts:193-207`).
  - If nothing delivered, `selectOutput` returns `base1` with an error, and an entry is still
    stored (R4).
  - If the selector fails, the first shuffled candidate is "adopted" and stored (R5).
- **Upstream:** reflection runs only `if mode_lib and sel.ok`, and the library add requires
  `sel.ok` plus a complete experience (`schedule.py:529`, `:555`). A fallback pick delivers an
  output but never teaches.
- **Status: fixed in `94883af`.**
  - Reflection and `library.add` run only when the status is `ok` and the chosen run delivered.
  - A selector failure delivers upstream's neutral fallback and sets `selection.fallback`, with
    status `selection-fallback`. Nothing is learned from it.
  - `selection.ok` is false and `chosenLabel` is `""` when nothing delivered.

**A4 — No stop when every base rollout failed.** CONFIRMED (R12).
- **Ours:** with the solver down, the run still made 4 improver calls (`inv1`, `dom1`, `agg1`,
  `experience`) and 4 doomed rollouts.
- **Upstream:** stops with status `base-failed` (`schedule.py:629`). It also refuses to build
  evidence when no trajectory renders ("the proposer would be adapting on nothing").
- **Status: fixed in `94883af`.** With no base rollout `ok`, the run returns `base-failed`
  after zero improver calls, and `errors[0]` carries each base error.

**A5 — An empty or cut-off improver reply looks like a deliberate KEEP_BASE.** CONFIRMED (R2, R3).
- **Empty reply:** `makeProposer` returns `res.text || ""` (`Harness2Service.ts:166`). `applyReply`
  then keeps the current tree, so the stage records `keptBase=true, fellBack=false` with empty
  notes (R2). Downstream stages and the reflector read that as an evidence-based "no change".
- **Cut-off reply:** a reply truncated inside a second `<file>` block is half-applied, and it
  passes validation. In R3 the accepted tree tells the agent to "use the `totals` skill", but
  that skill does not exist.
- Nothing checks `finish_reason` or zero usage. Compare memory
  `zero-reported-token-usage-marks-a-truncated-generation`.
- **Status: fixed in `a3993ea`.**
  - `makeProposer` throws a `ProposerError` on empty text or all-zero usage. An empty string
    from any proposer is a failed transport attempt.
  - After 2 attempts the stage falls back with `proposer failed: empty reply (after 2 transport
    attempts)`, never `keptBase`.
  - A reply that leaves a `<file>` block open is rejected with "cut off inside the `<file>`
    block" and retried.
  - `generateText` exposes no `finish_reason`, so a cap hit that still closes every block is
    accepted. A cut-off selector or reflector reply fails its own parse and falls back.

**A6 — Stage retries are weaker than upstream's.** CONFIRMED (R13, R21, R8).
- **No transport retry:** a single `ECONNRESET` ends the stage on the first attempt
  (`Recursion.ts:170-173`). Upstream makes 2 transport attempts with backoff
  (`config.py:177`, `proposer.py`).
- **The retry is blind:** it appends "YOUR PREVIOUS ATTEMPT WAS REJECTED… Fix it", but the
  proposer call is stateless and never sees what it sent (R21). Upstream writes the rejected tree
  back into the session's workspace, so the retry edits it (`recursion.py:228`).
- **First error only:** `validateTree` throws at the first problem. A reply with 4 problems
  reported only one (R8). Upstream collects every error into one message (`tree.py:377`).
- **No `autotrigger`:** upstream repairs a missing skill trigger line before validating
  (`recursion.py:116`, `tree.py:192`). That is the exact failure the 10-19 smoke run hit (a DOM
  proposal retried, then fell back).
- **Status: fixed in `a3993ea`.**
  - **Transport:** 2 attempts with backoff of 10 s × (attempt − 1). A deadline is not retried,
    because `generateText` takes no abort signal and the timed-out call keeps generating.
  - **Retry:** it edits the rejected tree, and its prompt shows that tree and the rejected notes.
  - **Validation:** `collectTreeErrors` reports every problem in one message.
  - **`autotrigger`:** appends ``- When <description>, use the `<name>` skill.`` to
    `guardrails.md`, unless that would break the cap (`stage.repaired` lists the skills it fixed).

**A7 — Library scoping and retention.** CONFIRMED (R6, R9) and code.
- **Self-read:** a re-run task reads its own earlier entry as "earlier tasks in this domain" (R6).
  Upstream keeps only the entries before the current task (`library.py:101`, `schedule.py:701`).
- **Eviction is alphabetical:** past the 60,000-char cap, `contextText` drops "the oldest", but
  `entries()` sorts by name (`Library.ts:142`). R9 added `zeta-older` and then `alpha-newer`;
  the newer one was evicted.
- **One library forever:** there is one library per domain, shared across mode, k, solver and
  improver, and it grows without end. Upstream scopes roots per run and mode, "so each sweep
  starts every domain empty" (`library.py:23`).
- **No way to remove a bad lesson:** there is no `forget`/`retain` and no delete endpoint.
- **Caller-chosen task ids overwrite:** a reused `taskId` replaces an unrelated earlier entry.
- **Status:**
  - **Fixed in `a3993ea`:**
    - Self-read: `contextText({ exclude: [taskId] })` drops the task's own block and its
      index row.
    - Eviction: each entry gets a `- stored:` time; `entriesByAge` evicts the oldest first, and
      the context says how many entries it left out.
    - `Library.forget()` exists.
  - **Fixed in `2ad3f48`:** `DELETE /harness2/library/:domain/:taskId`.
  - **Open:** library scope (Q5).
  - **Unchanged:** a reused `taskId` still overwrites its entry, as upstream's `add` does.

**A8 — The reflector cannot read the selector's reasoning, and its prompt lost the
anti-confabulation rules.** CONFIRMED (R18) and prompt diff.
- **No id map:** the selector writes its `<why>` in anonymous ids ("a2 reconciles the total").
  The reflection prompt carries that text but not the `a1/a2 → label` map. Upstream writes
  `adoption.json` for exactly this (`selection.py:432`, `:471`).
- **Base tree twice:** the base tree is rendered as CURRENT HARNESS and again as BASE HARNESS.
- **Dropped sentences:** `experience()` (`Prompts.ts:264`) dropped upstream's strongest lines,
  including "an invented attribution poisons the library for every later task"
  (`prompts.py:1130`) and "Adoption alone never establishes that an edit helped or will
  transfer" (`prompts.py:1145`).
- **HYPOTHESIS:** the 10-19 smoke run's "high confidence lessons from sampling noise" is partly
  caused by these cuts, not only by the weak improver model. Testable: A/B the two prompt texts
  on the same recorded evidence.
- **Status: fixed in `a3993ea`.** The reflection mission is now:
  - the BASE HARNESS, shown once;
  - every candidate, diffed against the base;
  - an ADOPTION block: the submitted label, how it was selected, the `a<n> → label` map, and the
    selector's reason.
  - `experience()` restores the dropped lines. The hypothesis is still untested.

**A9 — Evidence is clipped below upstream's floor, and the prompt grows without bound.**
CONFIRMED (R19, R20) and code.
- **What the improver sees:** each tool result is cut at 800 chars, args at 400, thinking at
  1,500 and the final output at 6,000 (`Harness2Service.ts:135-140`). Selector candidates are cut
  at 12,000 (`:121`).
- **Upstream's floor:** an observation limit under 10,000 is "in the range that fabricates
  defects" and is refused (`spec.py:163`). Trajectories are never clipped as a whole, and the
  model is told that truncation markers "are ours, not behavior by the solver" (`context.py:534`).
  Our selector has a FINISH rule against "visibly incomplete sections" and gets no such
  disclaimer (R19). Upstream's has one (`prompts.py:1087`). This biases selection against long
  answers.
- **Size:** everything is inlined, and there is no cap on tool-call count or total mission size.
  At k=4, with 20 tool calls per rollout, the aggregator prompt was **394,106 chars (about 98k
  tokens) before any library text** (R20).
- **ASSUMPTION:** whether that overflows GLM-5.3-Flash depends on the served context length,
  which this audit did not check. An overflow surfaces as "proposer failed", which means a
  silent fallback. (Later check: the deployed `vllm-2` no longer serves GLM at all; see A14.
  The Jetson's `nemotron35` serves `max_model_len=100000` tokens.)
- **Status:** the selector's truncation-marker sentence is fixed in `94883af` (R19). The rest
  is fixed in `a3993ea`:
  - **Caps:** thinking 4,000, tool args 2,000, tool results 10,000 (upstream's floor), final
    output 20,000.
  - **Truncation note:** every mission states that truncation markers are ours.
  - **Budget:** past a 240,000-char mission budget (`HARNESS2_MISSION_CHAR_BUDGET`), trajectories
    are compacted. Each keeps its start and end, behind an explicit COMPACTED note. R20 now builds
    a 239,332-char prompt.
  - **Selector:** each candidate gets min(40,000, budget / n).

**A10 — The cost of skills is misrepresented, and nothing caps always-on text.** CONFIRMED (R14, R15).
- **What we do:** `materialize` puts **every** skill body into every rollout's system prompt
  (`HarnessTree.ts:98-108`). In R14, a 53-char system prompt plus a 5,048-char skill gave a
  5,173-char system prompt.
- **What we tell the proposer:** the surface table says skills are "used only when its trigger
  fires" (`Prompts.ts:49`). It also says "ALWAYS-ON PROSE IS THE EXPENSIVE OPTION; prefer a
  SKILL" (`:51`).
- **Effect:** on this substrate that advice is false. The proposer is steered to grow the prompt
  and cannot see the cost.
- **No cap:** a 200,000-char `systemprompt.md` validates (R15). Upstream caps always-on text at
  24,000 chars (OpenCode, `substrate/opencode.py:50`) or 8,000 (Codex, `codex.py:42`).
- **We already have on-demand skills:** `SkillRegistry` plus the `skill_read` tool, using the
  same `skills/<name>/SKILL.md` layout (`AgenticLoopService.ts:361-378`). See §6 Q2 and D5.
- **Status: Q2 default applied in `a3993ea`; Q2 itself is still open for the user.**
  - Skills stay inlined.
  - The surface table now says skills are always on here and cost the same as always-on prose.
  - `ALWAYS_ON_MAX` caps the **materialized** prompt at 24,000 chars, skill bodies included.
  - **R14 stays CONFIRMED by design:** it measures inlining, which this default keeps.

**A11 — The "grader verdict" check is invented, misfires on finance text, and can crash the
whole run.** CONFIRMED (R7).
- **Ours:** `GRADER_RE` (`HarnessTree.ts:43`) matches English phrases such as `graded as`,
  `graded by`, `answer key` and `reference solution`. Its comment credits upstream
  `context.py`.
- **Upstream:** checks machine markers from benchmark graders, such as `"pass_rate"` and
  `deterministic_eval_summary` (`context.py:419`).
- **Misfire:** "Treat any bond graded as BBB- or better as investment grade" is rejected as a
  grader leak.
- **Crash:** when a reflected lesson trips the check, `Library.add` throws out of `runHarness2`
  (R7). The route answers 500 and every rollout result is lost, because there is no run record
  (C2).
- **Status: fixed in `94883af`.**
  - The tripwire uses upstream's `GRADER_VERDICT_MARKERS` (machine markers, checked in both file
    names and file text). "graded as BBB-" now passes.
  - A failed `library.add` goes into `errors[]`, and the run still returns.
  - A second bug was found while fixing this. `Library.add` checked `JSON.stringify(lesson)`, and
    JSON escaping turns `"pass_rate"` into `\"pass_rate\"`, so a quoted marker slipped through.
    It now checks the raw lesson text, as upstream does.

**A12 — Smaller prompt and input gaps.** CONFIRMED (prompt diff).
- **Library re-verify rule dropped:** GENERALIZE (`Prompts.ts:118`) lost the rule that protects
  the cross-task loop. A component copied from the library must have its facts **re-verified**:
  "an earlier task's mapping or threshold is a hypothesis here, not a fact" (`prompts.py:323`).
- **Wrong "answer-free" variant:** the selector uses the proposer's version, which mentions
  trajectories the selector never sees. Upstream has a separate `ANSWER_FREE_SELECT`
  (`prompts.py:47`).
- **Unchecked caller text:** the request's `bench` prompt slots are not checked for
  rubric/score/grader words. Upstream refuses them (`spec.py:121`).
- **Status: fixed.**
  - `ANSWER_FREE_SELECT`: `94883af`.
  - The GENERALIZE re-verify rule: `a3993ea`.
  - The `bench` checks: `2ad3f48`. Slots must be known keys, and every slot except `work` refuses
    upstream's words (benchmark, evaluation, grader, rubric, score). `work` restates the task,
    and a real task may say "credit score".

**A13 — The diversity metric is not upstream's.** CONFIRMED (R11). Low impact.
- **Ours:** `diversity` compares whole-file text, so a one-line edit to a 50-line file scores
  0.0. Upstream's line-Jaccard (`tree.py:407`) would score 0.961.
- It is reported only and drives no decision, but its comment calls it upstream's.
- **Status: fixed in `a3993ea`.** `diversity` is upstream's line-Jaccard (`meanJaccard`, `n`, `nDistinct`).

**A14 — The default improver model is no longer served, and a dead improver looked like a clean
run.** CONFIRMED (NAS query, 2026-10-22), found while fixing.
- **The default:** `DEFAULT_IMPROVER` is `vllm-2` / `GLM-5.3-Flash-EXL3-TF`
  (`Harness2Service.ts:27-30`).
- **What is served:** on the NAS, `GET :5591/config-local` lists `vllm-2` serving only
  `DeepSeek-V4.1-Flash-1017`, and `vllm` serving `nemotron35`.
- **Effect before the fix:** with no override, every proposer call fails. Every stage falls back
  to the base tree, the k=1 final is a re-roll of the base, and the run still read as a normal
  KEEP_BASE result.
- **Status:** detection fixed in `94883af`. When every stage falls back on a proposer failure, the
  run returns status `improver-failed`, `errors[0]` names the cause, and nothing is learned.
  Fixed in `2ad3f48`:
  - **Preflight:** the route lists what each local provider serves and refuses a model that is not
    served (400), an unknown instance (400), or an unreachable provider (502).
  - **Default improver:** `DEFAULT_IMPROVER.model` is empty unless `HARNESS2_IMPROVER_MODEL` is
    set, and the route fills in the model `vllm-2` serves.

### B. How rollouts run through our agentic harness

**B1 — Rollouts do not exercise the real agent.** CONFIRMED (code).
- **The executor:** `runSingleModel` (`BenchmarkService.ts:323`). Without `toolsEnabled` there
  are no tools at all. With it, it calls `handleAgent` with `autoApprove: true`,
  `maxIterations: 10` and `enabledTools: [CALCULATE_PRECISE]` (`:383-392`).
- **What the solver can call:** the agentic loop adds its internal tools to every run:
  `take_note`, `ask_user` and `retrieve_offloaded_content` always, plus `skill_read` when repo
  skills exist (`AgenticLoopService.ts:361-378`). So `calculate_precise` is the only domain tool.
- **No real agent:** `makeExecutor` never passes `model.agent` (`Harness2Service.ts:144-155`), so
  a rollout cannot run as a real custom agent (trading, lupos, …) with its own tools and policies.
- **Effect:** `tool_guidance.md` and the INV dimension have no real tool use to adapt. Harnesses
  learned here are not evidence about production agents.
- **`ask_user` can stall a rollout and the whole run:**
  - `ask_user` parks the turn until someone answers over `POST /agent/answer`, or until the
    turn's abort signal fires (`harnesses/lifecycle/AskUserTool.ts:142-185`). It also stores a
    pending question first.
  - harness2 passes no signal, and the loop then substitutes one that never aborts
    (`AgenticLoopService.ts:557`).
  - Neither the loop nor `ChatRoutes.ts` has an overall timeout.
  - Result: a tools-enabled rollout whose model asks a question waits indefinitely, and so does
    the synchronous `POST /harness2/run`. A proposer writing "ask the user when unsure" into
    `guardrails.md` would trigger exactly this.
  - **Status: fixed in `2ad3f48`.** Every rollout now ends:
    - it gets its own AbortSignal with a deadline (`HARNESS2_ROLLOUT_TIMEOUT_MS`, default
      20 min) and follows the run's cancellation;
    - its first `ask_user` call aborts it, recorded as "no user is attached";
    - if it ignores its abort, it is abandoned after 30 s.
    - The `ask_user` schema is still offered to the solver. Removing it means changing
      `AgenticLoopService.ts`, which two other worktrees are editing.
- **Side note:** `take_note` writes `data/notes/<runId>.md`. That path is not on a container
  volume and is not gitignored in a checkout.

**B2 — Tools-enabled rollouts run under prompt layers the proposer never sees.** CONFIRMED (code).
- **What `/agent` adds:** `handleAgent` routes through `AgenticLoopService` and
  `SystemPromptAssembler`. With no `agent`, the assembler adds:
  - a direct-mode identity;
  - tool docs, built after the orchestrator-only tools are grafted onto the assembler's
    enabled set (`system-prompt/index.ts:88-97`). Whether that graft also changes the tool
    schemas actually offered was not traced (REPORTED);
  - project skills, conversation memories and workflow memories, by embedding match
    (`:440`, `:468`, `:501`);
  - a local-time system message (`:600`).
- **How it is wired:** the assembler runs as a `beforePrompt` hook registered by
  `createStandardHooks` (`harnesses/lifecycle/HookInitializer.ts:51-59`, called from
  `AgenticLoopService.ts:578`).
- **Effect:** the proposer diffs only the harness2 tree, so behaviour caused by those layers is
  credited to tree edits (confounded evidence).
- **HYPOTHESIS — rollouts may not be independent:** the same hook set registers MemoryExtractor
  and WorkflowMemory as `afterResponse` hooks. WorkflowMemory skips only the trading project
  (`WorkflowMemoryService.ts`, `createHook`: needs a conversation id, a completed run and ≥ 4
  messages). So a completed tools-enabled rollout can store a workflow memory under project
  `harness2`, and a later candidate's rollout can retrieve it in step 10. Not reproduced here
  (needs Mongo and embeddings). Check: run a k=1 task with `toolsEnabled`, then query
  `workflow_memories` for project `harness2`.

**B3 — Tools-enabled rollouts leave an agent-conversation document each.** CONFIRMED (code).
- `runSingleModel` passes `skipConversation: true`, but `handleAgent` ignores it. It mints a UUID
  (`ChatRoutes.ts:852`) and upserts a conversation stub (`:859`; `ConversationService.ts:236`).
- One k=1 task makes 4 of them. This is inherited from the benchmark path and also affects
  `/benchmark` agent runs.

**B4 — The loop is not closed.** REPORTED (sweep), spot-checked.
- Outside `Harness2Routes.ts`, nothing reads `runtime-data/harness2`, `HARNESS2_LIBRARY_PATH`,
  `contextText()` or an adopted tree.
- The 10-19 plan scoped this out on purpose, so trading prompts stay untouched.
- The result: "self-improving" currently means only that later `/harness2/run` calls in the same
  domain read earlier lessons. See §6 Q4.

### C. Route and operational safety

**C1 — An open, expensive endpoint.** CONFIRMED (code).
- **No authentication:** `authMiddleware` only copies the project and username headers
  (`AuthMiddleware.ts:12-58`). This is service-wide, so Rod's repos can call without keys.
- **Cost:** at k=4, one `POST /harness2/run` can start 16 rollouts and up to 24 improver calls
  (12 stages × 2 attempts), plus selection and reflection.
- **Load on the Spark:** the default improver is GLM on the DGX Spark (`vllm-2`), the same box
  that serves the trading cycle. Nothing queues or prioritises these calls, and nothing stops two
  runs at once.
- **Any model:** the body may name any provider/model as solver or improver, including paid
  cloud models.
- **Status: partly fixed in `2ad3f48`.**
  - Solver and improver must be local providers unless `HARNESS2_ALLOW_CLOUD=1`.
  - A preflight confirms each local model is served before any rollout (A14).
  - Only one run per domain can be active.
  - **Unchanged:** there is still no authentication (it is service-wide, and Rod's repos call
    without keys), and the Spark still has no queue or priority.

**C2 — A synchronous request with no run record.** CONFIRMED (code).
- **Results live only in the HTTP response.** The response is returned after the whole run.
  Nothing aborts on client disconnect, and nothing persists stage notes, selection, raw
  reflection or proposer prompts.
- **Upstream keeps a full record:** `summary.json` (with resume), `selection.json`, `edits.md`,
  per-stage evidence directories and a proposer audit trail.
- **Effect:** when a run dies late (A11), or the client times out, everything except a possible
  library entry is gone.
- **Status: fixed in `2ad3f48`.**
  - `POST /harness2/run` answers 202 with a `runId`.
  - `GET /harness2/runs/:runId` polls, and `POST /harness2/runs/:runId/cancel` aborts.
  - `wait: true` keeps a synchronous answer, and cancels the run when the client disconnects.
  - Every run writes `<libraryRoot>/<domain>/runs/<runId>.json`: the request at start, then the
    whole result or the error. A record still `running` with no live job reads `interrupted`.
  - Proposer prompts are not stored, and there is no resume (upstream has both).

**C3 — `..` escapes the library directory.** CONFIRMED (R10; path computation only).
- `slug` keeps dots (`Library.ts:29`). So `domain: ".."` resolves to the parent of the library
  root, and `taskId: ".."` resolves to the domain directory itself. Both GET and POST accept
  them.
- Reach is one directory level, because slashes are replaced.
- **Status: fixed.**
  - `slug` replaces leading dots, so `..`, `.` and `.x` stay inside the root (`a3993ea`).
  - The route refuses any `taskId` or `domain` outside `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`
    (`2ad3f48`).

**C4 — Concurrent runs in one domain race.** CONFIRMED (code).
- Two runs in the same domain race on the `INDEX.md` rebuild. Two runs with the same `taskId`
  race on `rmSync` of its harness directory (`Library.ts:88`).
- **Status: fixed in `2ad3f48`.**
  - One active run per domain: a second `POST` answers 409 with the holder's `runId`.
  - `DELETE` of a lesson also waits while the domain runs.
  - The library writes are synchronous, so within one process this guard is the whole fix. Two
    service processes sharing one library would still need a file lock.

### D. Duplicates and cleanup

- **D1 — Frontmatter parsing, 4th copy.** REPORTED, spot-checked. `HarnessTree.frontmatter` is
  the weakest of four hand-rolled parsers. The others are `SkillRegistry.parseSkillFrontmatter`
  (`platform/skills/SkillRegistry.ts:38`, handles lists and quotes, same `SKILL.md` layout),
  `RuleLoader.parseFrontmatter` (`platform/rules/RuleLoader.ts:81`) and
  `SubagentRegistry.parseSubagentMarkdown` (`SubagentRegistry.ts:64`). Reuse SkillRegistry's.
- **D2 — Other helper copies.** REPORTED, spot-checked.
  - `mapLimit` repeats the shared-cursor worker pool written inline in
    `RunExecutionEngine.ts:359-409`.
  - The local `truncate` is about the seventh ad-hoc copy. There are four identical copies in
    `orchestrator/routers/`, plus `ContextWindowManager.ts:177`, which uses the same marker
    format.
  - None of them is shared.
- **D3 — Duplication inside harness2.**
  - The cue/lesson/evidence completeness check exists twice (`parseExperience` and
    `Library.hasExperience`).
  - "Tree unchanged" exists twice (`isUnchanged` and the inline `same` in `buildMission`).
  - The `decisions` map is built in three places.
  - `Library.contextText` re-implements `renderTree` inline.
  - **Status: all four fixed in `a3993ea`** (`hasExperience`, `isUnchanged`, `decisionsOf`, `renderTree`).
- **D4 — Overlapping mechanisms elsewhere.** REPORTED.
  - `WorkflowMemoryService` already stores successful trajectories and injects them into
    `/agent`. It is the closest twin of `Library`.
  - `MemoryExtractor` stores "feedback" memories, which work roughly like lessons.
  - `ExperimentService` is a compare step.
  - `PromotionController` (shadow → canary → active) is an adopt step with **no caller**.
  - `TournamentRouter` is a non-blind best-of-N judge, an output-level twin of `selectOutput`.
  - Before growing a fourth "lessons" store, decide which of these is the home (§6 Q4).
- **D5 — Dead or unwired harness components found along the way.** CONFIRMED (code).
  - `SkillService.ts` has no importers.
  - `PromotionController` and `RuleLoader` have no production caller.
  - The runtime image copies only `node_modules`, `dist`, `package.json`, `tool_schemas.json`,
    `profiles`, `contracts` and `public` (`Dockerfile:36-48`). So `skills/`, `memory/`, `rules/`
    and `subagents/` do not exist in the container. `/agent` never injects `skill_read` in
    production (`AgenticLoopService.ts:367`), and when it does, it never lists the skill names
    (only `/v1/runs`' `ContextAssembly.ts:239` does).
- **D6 — Docs drift.** `docs/HARNESS2_PLAN_2026-10-19.md`:
  - cites a `harness2/Selection.ts` that never existed (selection lives in `Harness2Service.ts`);
  - says the route is "not deployed" (it is);
  - presents the mixed selection pool as upstream's.
  - It had no documentation chapter until this one. The plan now carries a banner pointing here.
- **D7 — Leftovers.**
  - `/tmp/h2up/` holds 25 flattened upstream files written 2026-10-21 by another session. They
    are not used by anything and were **not deleted** by this audit; the user may delete them.
  - `runtime-data/` is not in `.gitignore`, so a local harness2 run leaves untracked files in a
    checkout. **Fixed in `2ad3f48`.**
- **D8 — Test gaps.** No test reaches A1–A13, `makeExecutor`, `makeProposer` or the route.
  Upstream's own suite has two tests ours lacks: "complete evidence and library prefix" and
  "failed selection is never judged".

## 5. What is faithful (keep it)

- **Budget and schedule:** 4k rollouts / 3k stages including the k shared base rollouts; INV and
  DOM per round; parallel = 2k candidates, then k independent compositions; sequential = k
  rounds editing the previous checkpoint, with KEEP_BASE meaning "keep the current checkpoint".
- **Stage handling:** `STAGE_ATTEMPTS = 2`, with fallback to the stage's current harness. The
  decisions map carries `notes || error`.
- **Labelling unchanged candidates:** an unchanged candidate is labelled "IDENTICAL… sampling
  noise" (`430d150`).
- **Library format:** stores the whole adopted tree plus `EXPERIENCE.md`, and refuses an entry
  without cue/lesson/evidence. `NO_ENTRY` means no entry. Domains are isolated.
- **Stage prompts:** propose, aggregate and composeRound keep upstream's structure and
  KEEP_BASE language.

## 6. Fix plan

**Phase 1 — clear bugs, no design decision needed.** Each item lands with a test that the
audit script check named in brackets turns into NOT REPRODUCED.

1. **Gate learning on success** [R4, R5]. Reflect and `library.add` only when selection
   succeeded and the chosen run delivered. Record the fallback pick as delivered-not-learned.
   **Done in `94883af`.**
2. **Base-failure stop** [R12]. If no base rollout is `ok`, return status `base-failed` without
   proposer calls. **Done in `94883af`.**
3. **Proposer contract** [R2, R3, R13, R21, R8]. **Done in `a3993ea`.**
   - An empty reply, `finish_reason: length` or zero usage is an error, never KEEP_BASE.
   - Make 2 transport attempts with backoff.
   - Put the rejected reply (or its parsed tree) into the retry prompt.
   - Have `validateTree` collect all errors, and add `autotrigger` before validation.
   - Reject replies with an unterminated `<file>` block.
4. **Library hygiene** [R6, R9, R10]. **Done in `a3993ea`, except the lock and the `DELETE`
   route (chunk (c)).**
   - Exclude the current `taskId` from `contextText`.
   - Evict by stored time, not name.
   - Refuse `.`/`..` and leading-dot slugs.
   - Add a per-domain lock and a `DELETE /harness2/library/:domain/:taskId`.
5. **Per-task selection seed** [R1]. Default to a hash of `taskId|k|mode`. **Done in `94883af`.**
6. **Reflection input** [R18]. **Done in `a3993ea`.**
   - Pass the id→label map and drop the duplicate base render.
   - Restore upstream's experience lines, the GENERALIZE re-verify rule, `ANSWER_FREE_SELECT`
     and the truncation disclaimer [R19]. (`ANSWER_FREE_SELECT` and the selector's truncation
     sentence: done in `94883af`.)
7. **No run-killing checks** [R7]. **Done in `94883af`.**
   - Swap `GRADER_RE` for upstream's machine-marker list, or keep the phrases as a warning only.
   - Catch per-stage and library failures into the result instead of throwing.
8. **Route** [C1–C4]. **Done in `2ad3f48`, except authentication (service-wide, unchanged).**
   - Persist a run record (`runtime-data/harness2/<domain>/runs/<taskId>.json`: stages, notes,
     selection, raw reflection).
   - Turn the route into an async job with a poll endpoint, and abort on disconnect.
   - Allow one run at a time per domain.
   - Default to local providers only.
   - Validate the `bench` slots.
9. **Rollouts always end** [B1]. **Done in `2ad3f48`; the `ask_user` schema is still offered.** Pass an `AbortSignal` with a per-rollout deadline into
   `runSingleModel`, and leave `ask_user` out of harness2 rollouts, since no user is attached.
10. **Served models** [A14]. Return `improver-failed` when every stage fell back on a proposer
    failure (done in `94883af`). Preflight in the route that the solver and improver models are
    served. Make the default improver follow the model `vllm-2` actually serves. **Done in
    `2ad3f48`.**

**Phase 2 — needs the user's decision before building.**

- **Q1 Selection pool:** finals-only (upstream, matches the paper, no selector at k=1) or mixed
  (current; the base can win when adaptation hurts)?
- **Q2 Skills:** keep them inline, or load them on demand?
  - Inline: then tell the proposer skills cost the same as always-on text, and count them
    toward an always-on cap of about 24k chars.
  - On demand: install the harness's skills through `skill_read`. That matches upstream, but it
    needs skills shipped into the image and their names listed (D5).
- **Q3 Executor realism:** run rollouts as a real custom agent (`model.agent`) with its own
  tools, and show the proposer the full system prompt the solver actually received (B1, B2)?
- **Q4 Closing the loop:** how does an adopted harness reach production? For example, through
  `PromotionController` shadow → canary with an `ExperimentService` verdict, or through workflow
  memory, with trading excluded as today.
- **Q5 Library scope:** per domain only (current), or per domain × solver model (minimum), or
  per run and mode (upstream)?

## 7. Reproduce

```
cd agents/lazy-agent-service            # the primary checkout, never a .worktrees/ copy
testrun --mem 2G -- npx tsx scripts/audit-harness2-loop.ts
```

The script imports the real `src/services/harness2` modules with fake executor and proposer
functions. It makes no network or model calls. Before any import, it points the run store, the
proxy-session store and the library root at an OS temp directory (as `test/isolation.ts` does),
and it removes that directory on every exit path. A run on 2026-10-22 left the primary checkout's
`git status` unchanged. Each line reads `R<n> [CONFIRMED|NOT REPRODUCED] <claim> ::
<observed>`. Output on 2026-10-22 (R16 was dropped while drafting; the ids match the script).
"Now" is the latest run (§9).

Since the finals-only default, a k=1 pool holds one final and is delivered without a selector.
So R1, R5, R18 and R19 pass `selectionPool: "mixed"` to keep their selector call. Their
claims are unchanged:

| Id | Finding | Observed at audit time | Now |
|---|---|---|---|
| R1 | A2 fixed order | 12 tasks, selector answers `a1` → `{"agg1":12}`; `shuffle([base1,agg1],0)=[agg1,base1]` | NOT REPRODUCED (`94883af`) |
| R2 | A5 empty reply | `inv1/dom1/agg1: keptBase=true, fellBack=false, notes=""` | NOT REPRODUCED (`a3993ea`) |
| R3 | A5 cut reply | accepted tree names the `totals` skill, `skills=[]` | NOT REPRODUCED (`a3993ea`) |
| R4 | A3 nothing delivered | `selection.error="no candidate delivered an output"`, entry written | NOT REPRODUCED (`94883af`) |
| R5 | A3 selector failed | `error="selector returned no valid id (none); took agg1"`, entry written | NOT REPRODUCED (`94883af`) |
| R6 | A7 self-read | 2nd run of `t-rerun` prompt contains `## Entry t-rerun` | NOT REPRODUCED (`a3993ea`) |
| R7 | A11 grader regex | "graded as BBB-" rejected; "graded by" lesson → `runHarness2` threw | NOT REPRODUCED (`94883af`) |
| R8 | A6 first error | 4 problems, message names only template braces | NOT REPRODUCED (`a3993ea`) |
| R9 | A7 eviction | newer `alpha-newer` dropped, older `zeta-older` kept | NOT REPRODUCED (`a3993ea`) |
| R10 | C3 traversal | `Library("..").dir` = `root/..`; `entryDir("..")` = domain dir | NOT REPRODUCED (`a3993ea`) |
| R11 | A13 metric | ours 0; line-Jaccard 0.961 | NOT REPRODUCED (`a3993ea`) |
| R12 | A4 base failed | improver calls `inv1.a1, dom1.a1, agg1.a1, experience` | NOT REPRODUCED (`94883af`) |
| R13 | A6 transport | `fellBack=true attempts=1 calls=1 error="proposer failed: ECONNRESET"` | NOT REPRODUCED (`a3993ea`) |
| R14 | A10 skills inline | 53 + 5,048 chars → 5,173-char system prompt | CONFIRMED, by design (Q2 default keeps skills inlined) |
| R15 | A10 no cap | 200,000-char `systemprompt.md` validates | NOT REPRODUCED (`a3993ea`) |
| R17 | A1 pool | k=1: 1 selector call; pool `{"a1":"agg1","a2":"base1"}` | NOT REPRODUCED (`94883af`) |
| R18 | A8 reflection | why cites `a2`; no id→label map; base shown as CURRENT and BASE | NOT REPRODUCED (`a3993ea`) |
| R19 | A9 truncation | marker shown, no disclaimer, FINISH rule present | NOT REPRODUCED (`94883af`) |
| R20 | A9 size | k=4, 20 tool calls/rollout → 394,106-char aggregator prompt | NOT REPRODUCED (`a3993ea`) |
| R21 | A6 blind retry | 2nd attempt has the rejection notice but not its own 1st reply | NOT REPRODUCED (`a3993ea`) |

## 8. Ledger

| Date | Item | Commit |
|---|---|---|
| 2026-10-19 | Harness² port + `POST /harness2/run` | `8e242aa` |
| 2026-10-19 | unchanged-candidate noise label; GLM default improver | `430d150` |
| 2026-10-22 | this audit, `scripts/audit-harness2-loop.ts`, plan banner | `05d49ea`, `1b3c000` |
| 2026-10-22 | Phase 1 chunk (a): learning gates, finals-only pool, per-task seed, base-failed stop, marker tripwire, run status (A1–A4, A11, A14 detection) | `94883af` |
| 2026-10-22 | Phase 1 chunk (b): proposer contract, retries, autotrigger, 24k cap, evidence budget, library scope/eviction/slugs, reflection input, prompts (A5–A10, A12, A13, C3, D3) | `a3993ea` |
| 2026-10-22 | Phase 1 chunk (c): async run jobs + records, cancel, one run per domain, request checks, model preflight, rollout deadline + ask_user stop, `.gitignore runtime-data/` (B1, C1–C4, A12, A14, D7) | `2ad3f48` |

## 9. Fixes and verification

### Chunk (a) — learning gates, selection, run status (`94883af`)

**What changed.**
- **Run result:** `runHarness2` now returns:
  - `status`: `ok`, `base-failed`, `improver-failed`, `no-output` or `selection-fallback`;
  - `errors[]`, for run-level problems;
  - `learned`, true when this run stored a library entry;
  - `chosenTreeIsBase`.
- **`selection`:** carries `ok`, `trivial`, `fallback` and `pool`.
- **Gates:** reflection and the library write happen only when the status is `ok` and the chosen
  run delivered.
- **Selection pool:** the k finals by default; `selectionPool: "mixed"` is the opt-in.
- **Selector prompt:** ports upstream's two pool texts, `ANSWER_FREE_SELECT`,
  `EVIDENCE_BOUNDARY_SELECT` and the FINISH rule's truncation-marker sentence.

**Evidence.**

| Check | Result |
|---|---|
| `vitest run src/services/harness2` on `main` @ `94883af` (testrun) | 2 files, **29/29 pass** (15 kept, one rewritten for the marker tripwire, 14 new in `Harness2Selection.test.ts`) |
| Revert check: each fix undone alone in a scratch copy, new test file rerun | **9/9 reverts turn their test red** (learning gate ×2, base-failed, seed, finals default, improver-failed, marker tripwire, library catch, raw-text check) |
| `tsc --noEmit` on `main` @ `94883af` (testrun) | 0 errors |
| `eslint src/services/harness2 src/routes/Harness2Routes.ts` | clean |
| `scripts/audit-harness2-loop.ts` on `main` @ `94883af` (testrun) | **13/20 confirmed**; R1, R4, R5, R7, R12, R17 and R19 now read NOT REPRODUCED; temp dir removed |
| `git status` of the primary checkout after the tests | unchanged (only another agent's ` M tool_schemas.json` and an untracked `.checks/` folder) |

### Chunk (b) — proposer contract, library hygiene, reflection input (`a3993ea`)

**What changed.**
- **Proposer contract:** transport retries, and empty or cut-off replies count as failures.
- **Retry:** edits the rejected tree.
- **Validation:** `autotrigger`, then `collectTreeErrors`.
- **Cap:** the Q2 default 24,000-char cap on the materialized prompt.
- **Evidence:** larger caps, plus a mission budget that compacts trajectories.
- **Library:** excludes the current task, evicts by stored time, uses safe slugs, gains `forget()`.
- **Reflection:** a new mission with the base once and the id map.
- **Prompts:** upstream's experience text and re-verify rule are back.

**Evidence.**

| Check | Result |
|---|---|
| `vitest run src/services/harness2` on `main` @ `a3993ea` (testrun) | 4 files, **62/62 pass** (two older tests narrowed; 33 new across `Harness2Proposer.test.ts`, `Harness2Library.test.ts`, and the selector-budget test) |
| Revert check: each fix undone alone in a scratch copy | **20/20 reverts turn their test red** |
| `tsc --noEmit` on `main` @ `a3993ea` (testrun) | 0 errors |
| `eslint src/services/harness2` | clean |
| `scripts/audit-harness2-loop.ts` on `main` @ `a3993ea` (testrun) | **1/20 confirmed**: only R14, by design; temp dir removed |
| `git status` of the primary checkout after the tests | unchanged |

**Two older tests changed, and why.**
- The "falls back after one retry" test used a skill with no trigger line. `autotrigger` now
  repairs that case, so the test uses a frontmatter name mismatch instead.
- The cross-domain test checked that the legal prompt held no "LIBRARY" anywhere. The restored
  re-verify rule names "the LIBRARY section" in every proposer prompt. The test now checks the
  section heading.

### Chunk (c) — route, run records, rollouts that end (`2ad3f48`)

**API after this chunk.**

| Call | Answer |
|---|---|
| `POST /harness2/run` | 202 `{runId, status: "running", poll, cancel}`; 400 on a bad request; 409 if the domain is busy; 502 if a provider cannot be listed |
| `POST /harness2/run` with `wait: true` | 200 with the finished run record; a client disconnect cancels the run |
| `GET /harness2/runs/:runId` | the run record: `running`, `done`, `cancelled`, `error` or `interrupted` |
| `POST /harness2/runs/:runId/cancel` | 202 while running; 409 after it finished; 404 if unknown |
| `GET /harness2/library/:domain` | `{domain, entries (oldest first), context}` |
| `DELETE /harness2/library/:domain/:taskId` | 200 `{removed}`; 404 if unknown; 409 while the domain runs |

New request fields: `selectionPool` (`finals` | `mixed`), `width` (1..4), `preflight` (default
on), `wait`.

**Evidence.**

| Check | Result |
|---|---|
| `vitest run src/services/harness2 src/routes/__tests__/Harness2Routes.test.ts` on `main` @ `2ad3f48` (testrun) | 6 files, **95/95 pass** (33 new: executor and cancellation, async job, records, validation, preflight, DELETE) |
| Revert check: each fix undone alone in a scratch copy | **16/16 reverts turn their test red** |
| `tsc --noEmit` on `main` @ `2ad3f48` (testrun) | 0 errors |
| `eslint` on the harness2 files, the route and its test | clean |
| **Full suite** `vitest run --maxWorkers=4` on `main` @ `2ad3f48` (testrun) | **174 files, 1,878/1,878 pass**, 34 s, peak 1.0 GB |
| `git status` of the primary checkout after the tests | unchanged |

