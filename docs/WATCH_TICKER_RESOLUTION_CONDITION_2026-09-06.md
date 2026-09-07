# watch_ticker — the open question, and the catalog that nearly ate it (2026-09-06)

Shipped as `c8baee3`. Source edit in `tool_schemas/trading/watch_desk.json`,
flat artifacts rebuilt into all three repos. Consumed by
`trading-service@1ac0125c` (full write-up: trading-client documentation
ch.115, `http://10.0.0.16:8888/documentation`).

---

## 1. What the tool was missing

`watch_ticker` let a trading agent leave a "wake me if…" note so the expensive
cycle stays off until something thesis-relevant happens. It accepted a
`thesis_summary` (prose) and a list of code-checkable `triggers` (price levels,
news categories, a staleness backstop).

Measured on the live desk, 2026-09-06: **0 of 185 active watches recorded what
the deciding agent did not know.** So the Watch Desk's only screen on incoming
news could ask *"is this headline about the company?"* — and never *"does it
bear on the open question?"*, because nothing on the record said what that was.

Three live wakes that a trade-enabled cycle burned on:

```
C     "Citigroup delays Fed rate cut forecast to June 2027"     -> flipped HOLD to BUY
C     "…CFO William Bardeen to Participate in the Citi 2026 Global TMT"
FCF   "Marvell Technology Posts Lower FCF Margins…"
```

The first is Citi's *research desk* making a macro call — it carries no
information about Citi's own equity, and it changed a decision. The second is a
conference sponsorship notice. The third is the ticker `FCF` (First Commonwealth
Financial) colliding with *free cash flow*.

**This is the same shape as the news_search region defect
(`NEWS_REGION_AND_TOP_HEADLINES_2026-09-05.md`): the downstream gate asked a
question whose honest answer was "yes".** Every one of those headlines really is
about, or really does name, the company. A relevance filter cannot repair a
request that was never scoped — and the missing scope here is the *question the
watch exists to answer*.

## 2. What was added

`resolution_condition`, plus `decision_action` and `decision_confidence`:

```json
"resolution_condition": {
  "open_question":   "Does Q3 net interest margin hold above 3.4%?",
  "resolving_fact":  "Q3 net interest margin on the October earnings call",
  "resolves_by":     "2026-10-14T20:30:00Z",
  "invalidates_if":  {"type": "price_below", "level": 61.0},
  "becomes_if_true": "BUY",
  "becomes_if_false": "SELL"
}
```

The description says why omitting it is not a neutral choice, and tells the model
to state the question in **specific** words — `"will they beat earnings"` matches
every headline ever written and screens nothing. (The consumer screens against
the terms left after generic equity vocabulary is stripped; a question made only
of generic words has an empty specific tier.)

`open_question` + `resolving_fact` are the required pair. A condition carrying
only `invalidates_if` is refused by the consumer: a price level cannot refuse the
Citi macro headline, and that shape — a level and nothing else — was already what
102 of the 185 live watches had.

## 3. The part worth remembering: the catalog is a cache with no invalidation

`resolution_condition` was added to trading-service's `@registry.register`
decorator and to `create_watch`. **271 tests green — and the model would never
have seen the field.**

`trading-service/app/tools/registry.py` prefers the generated flat
`tool_schemas.json` and falls back to the live decorators only when that file is
**absent**. The flat file is gitignored there, so:

| checkout | `tool_schemas.json` | what the test read | verdict |
|---|---|---|---|
| fresh `git worktree` | absent | the live decorator | **passed — worthlessly** |
| primary checkout | present, stale | the shipped catalog | **failed — correctly** |

A test written specifically to assert the parameter reaches the *schema* rather
than the Python signature passed for the wrong reason, in the place the work was
being done. This is the second occurrence of the class — the first cost the
Parameter Governor 20 days of being unreachable while four independent things
(handler, registry schema, whitelist, prism persona) all said the tool existed.

**The edit path is three steps and skipping the first two is silent:**

1. `tool_schemas/trading/<domain>.json` — the source of truth (this repo)
2. `python3 ../trading-service/scripts/build_tool_schemas.py` — writes
   byte-identical flat files to lazy-agent-service, trading-service and
   trading-client (91 tools, 3 targets)
3. commit **both** here — this repo tracks its `tool_schemas.json`;
   trading-service and trading-client gitignore theirs

Edit the source with a targeted text replace, not a `json.load`/`json.dump`
round-trip: the files use a compact one-line style for simple objects, and a
reserialize turned a 16-line diff into 117 lines of pure reformatting.

## Open items

- **A parameter added only to a Python decorator is invisible, and no test in
  this repo can catch it.** The guard lives in trading-service
  (`test_the_tool_advertises_the_field_it_needs`) and only bites on a checkout
  that has the generated file. A repo-local check that every tool's source entry
  matches its handler signature would catch it at the right layer; none exists.
- `deploy.sh` runs the generator, so a deploy repairs a forgotten rebuild — but
  only for whoever deploys next, and the stale catalog ships in every image built
  before then.
- The other three `trading/` domain files have not been audited for parameters
  that drifted the same way.
