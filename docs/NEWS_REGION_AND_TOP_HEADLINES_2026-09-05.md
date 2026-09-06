# news_search — region filtering and top headlines (2026-09-05)

Two defects in `NewsSearchService`, both reported from html-notes as "the news is
random", both invisible from inside this service because **nothing it returned
was wrong on its own terms**.

---

## 1. `language: "en"` is not a region

Every provider was sent `language: "en"` and no country. English-language outlets
from any country match an English query, and Indian English-language press
publishes enormous volume — so a generic query was reliably dominated by it.

Reported live through html-notes for **"stock market news"**:

```
7.8% GDP growth fails to lift Indian indices amid oil surge
Former Tata Technologies CEO sells Rs 165 crore stake
TWSE deepens London partnerships to attract global capital
economictimes.indiatimes.com
```

**This is the interesting part: those ARE stock market stories.** That is why the
downstream relevance gate in html-notes could not fix it — the gate asks "is this
about the subject?", and the honest answer was yes. They are on-topic and still
wrong, because they are about a different *market* than the caller's. A relevance
filter cannot repair a retrieval that was never scoped.

Confirmed directly against gnews, same query, one parameter apart:

```
worldwide : Livemint | Manila Times | TWSE (Taiwan) | Reuters | Business Insider
country=us: Breitbart | Reuters | Business Insider | Seeking Alpha | WTOP
```

Each API spells the region differently, which is why it had been skipped:

| provider | parameter | note |
|---|---|---|
| gnews | `country` | lowercase ISO-2 |
| worldnewsapi | `source-country` | |
| currentsapi | `country` | **uppercased** |
| thenewsapi | `locale` | |
| newsapi | — | `/everything` has none; only `/top-headlines` does |

`newsapi` therefore stays unfiltered. It is already the deliberate last-resort
backstop, so an unscoped answer from it is better than no answer.

Default `us`, overridable per call (`country: "gb"`) or per deployment
(`NEWS_DEFAULT_COUNTRY`). **`""` restores worldwide** — the previous behaviour is
still reachable rather than deleted.

---

## 2. An empty topic is a request, not a missing argument

`news_search` rejected an empty topic, so callers had to invent a query for
"what's going on in the news". html-notes invented the literal string
`"top stories"` — which the providers then **keyword-searched**.

That matches roundup pages *containing the phrase*. Live, the general news card
returned:

```
Alix Earle sheds light on her feud with Alex Cooper and other TOP STORIES
highlighted by Us for September 4
```

The phrase was the match. Alongside it: a 228-year-old London restaurant, a Penn
State coaching hire, and **"Mechanicsburg Patriot News"** — a publisher name that
had become a headline. None of that is a top story; all of it is what you get
when you search for two very common words.

Every provider has a dedicated top-headlines endpoint, so an empty topic now
routes to it:

| provider | endpoint |
|---|---|
| gnews | `/api/v4/top-headlines` |
| newsapi | `/v2/top-headlines` (**does** take a country, unlike `/everything`) |
| thenewsapi | `/v1/news/top` |
| currentsapi | `/v1/latest-news` |

`top` is **optional** on the `Provider` interface. A provider without one is
skipped for general asks rather than being handed a synthetic query — which is
precisely the mistake this replaces.

---

## The shape of both bugs

Neither was a wrong answer. The service was asked a well-formed question and gave
a correct one; the question just wasn't the one the user had. **When a retrieval
is unscoped, no amount of downstream filtering can recover it** — the filter can
only see what came back, and what came back was defensible.

The general rule this suggests: a retrieval boundary should carry *every*
dimension the caller cares about — topic, region, recency, kind — or it silently
picks its own defaults for the ones you left out.

---

## Verification

`tsc --noEmit` clean; **589 tests pass**. Verified live end-to-end through
html-notes after deploy:

- `stock market news` → Labor Day closures, Broadcom AI upgrade, micro-caps,
  jobs report. No Indian indices, no Economic Times. **20s.**
- `whats going on in the news` → Tupac conviction, Greek air force jet crash, LSU
  roster, Cardinals ejection. Real events, not phrase matches. **32s.**

## Open items

- **No test covers the region parameter.** The 589 existing tests do not exercise
  provider query construction; this was verified by hand against the live gnews
  API. A unit test asserting each provider's spelling of "country" would be worth
  having — the per-provider parameter names are exactly the kind of detail that
  rots silently.
- **The general feed leaned sporty** in the one post-fix sample (2 of 4 items).
  One snapshot of a US headline feed; not enough to act on. A cross-category merge
  (general + business + world) is the obvious next lever if it persists.
