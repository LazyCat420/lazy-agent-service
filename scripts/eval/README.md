# Basic fetch eval

Permanent live benchmark for deployed **lazy-agent-service (LAS)**: sends the shared
8 basic web questions through `POST /v1/runs` (SSE, `stream: true`) for one or more
app profiles, grades each final answer with a local GLM judge against the shared
PASS/WEAK/FAIL rubric, and guards against LAS container restarts during the run.

## Run

```sh
node scripts/eval/run-basic-eval.mjs --profiles trading,html-notes --questions 1-8 --out <dir> [--concurrency 1]
```

- `--profiles`: comma-separated; `trading`, `html-notes` (default: both)
- `--questions`: ids and ranges, e.g. `7` or `1-8` (default: all 8)
- `--out`: output dir (required); only temp/scratch files are written here
- `--concurrency`: parallel runs (default 1)

Writes `<out>/results.json` (all raw records: event types, tool calls, usage,
final answer, grade) and `<out>/summary.md` (markdown table). Only the summary
table is printed to stdout.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `LAS_URL` | `http://10.0.0.16:5591` | LAS base URL |
| `INTERNAL_EXECUTE_TOKEN` | — | auth token; falls back to `deploy-kit/.env.deploy`. Never printed. |
| `JUDGE_URL` | `http://10.0.0.141:8000/v1/chat/completions` | vLLM GLM judge endpoint |
| `JUDGE_MODEL` | `GLM-5.3-Flash-EXL3-TF` | judge model |

Profiles (request shapes matched to `src/routes/RunRoutes.ts`, `src/types/run.ts`
and trading-client `app/chat/runtime_strategy.py`):

- `trading`: `profile_id: trading-strategy-chat-v1` (v1.2.0), `app_id: trading`,
  project `trading`, username `strategy-chat`,
  `budget: { max_tool_calls: 20, max_tokens: 49152 }`, array input.
- `html-notes`: `profile_id: html-notes-canvas-v1`, `app_id: html-notes`,
  project `html-notes`, username `eval`, plain-string input.

## Exit codes

- `0` — eval ran, no LAS restart detected
- `2` — restart detected (LAS container `RestartCount`/`StartedAt` changed between
  the first and last run, via `ssh nas sudo docker inspect lazy-agent-service`;
  falls back to `GET $LAS_URL/health` if SSH is unavailable)
- `1` — script error

## Grading

Each run is graded by GLM (temperature 0) with the rubric from `questions.json`;
"today" in a question means the date the eval runs (passed to the judge). Runs
that did not reach `run.completed` are FAIL without calling the judge.

## Chaos mode

Chaos questions live in `scripts/eval/chaos-questions.json` (profile `chaos`,
`profile_id` `eval-chaos-v1`). The server must run with `LAS_EVAL_CHAOS=1`.

```
node scripts/eval/run-basic-eval.mjs --questions-file scripts/eval/chaos-questions.json --profiles chaos --questions 1-5 --no-judge --concurrency 5 --out <dir>
```

For 10-parallel (each question twice):

```
node scripts/eval/run-basic-eval.mjs --questions-file scripts/eval/chaos-questions.json --profiles chaos --questions 1,2,3,4,5,1,2,3,4,5 --no-judge --concurrency 10 --out <dir>
```

`--no-judge` skips the GLM judge: grade is `PASS` when the run completed with a
non-empty answer, else `FAIL`.

## Baseline

Baseline on **2026-10-17**: trading **3/8**, html-notes **4/8** PASS.
