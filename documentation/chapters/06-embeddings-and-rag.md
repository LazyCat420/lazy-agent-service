---
part: Runtime & Pipeline
type: spec
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:src/services/EmbeddingGemma2Client.ts, lazy-agent-service:src/services/EmbeddingService.ts, lazy-agent-service:src/services/ConversationEmbeddingService.ts, lazy-agent-service:src/services/MemoryExtractor.ts, lazy-agent-service:src/routes/EmbedRoutes.ts
---

# Embeddings and RAG

Embeddings belong to this service, not to any one consumer. `EmbeddingGemma2Client` is the
**single shared client** for representation generation: default provider `jetson-embedding`,
model `embeddinggemma-2` (`google/embeddinggemma-2`, revision `914f7f89142e33e77833254d9c9b90c3cef7303b`)
at `http://10.0.0.30:8001/v1`, **768** native dimensions. `HARNESS_EMBEDDING_URL` overrides
the endpoint; no API key is required. The client verifies model, revision, dimensions and the
instance's readiness/quarantine state before use. Explicit cloud provider/model selections
remain supported and take precedence over provider defaults.

## Two entry points, one queue

| Entry | Shape |
|---|---|
| `POST /embed` | `{"text": "...", "input_type": "query"|"document"|"similarity", "dimensions": 768}` — or `"texts": [1..32 strings]` for corpus indexing (batch release `b772cac`). Replies carry `embedding(s)`, `dimensions`, `provider`, `model`, `space`; batch rows are logged with counts only, never the texts. |
| `POST /v1/embeddings` | OpenAI-compatible (`input` string or ≤32, `model`, `encoding_format`, `dimensions`) for off-the-shelf SDKs against base URL `http://10.0.0.16:5591/v1`. Without `input_type` it uses the symmetric `similarity` task. |

Callers send plain text; **the server owns the task prefixes**. `taskType` aliases
`RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT` / `SEMANTIC_SIMILARITY` work too. Same model, same
queue, same spaces from both.

**Index through this endpoint, never the Jetson directly**: a separate process gets its own
queue and collides — while one such job ran on 2026-10-06, every live `/embed` call failed
HTTP 429 after its three retries. Keep batches small (trading sends 8).

## Long text: bounded chunking

Text is split at Unicode character boundaries into ≤**1,800 UTF-8 bytes** per chunk; a
request packs ≤8 chunks within **7,000 total UTF-8 bytes**; chunk vectors are summed and
L2-normalized into one document vector. Token-limit refusals are surfaced, never silently
truncated. Index identity records the chunking/aggregation policy, model revision and
dimensions — and **vectors from different spaces never compare**. Use the same client and
policy for query and document sides.

## Flow control

Calls serialize within the process; 60 s inference timeout; HTTP 429 honours numeric
`Retry-After`, ≤3 attempts, ≤10 s delay; 503/quarantine surfaces immediately. The Jetson's
own single-inference guard stays authoritative.

## What consumes embeddings

- **Prompt assembly**: agent memories, skills and workflows are retrieved by similarity,
  scoped to project + agent.
- **Memory extraction/consolidation**: document/query tasks; dedup considers the latest 500
  matching documents, dedups the latest 200.
- **Skills**: document vector on save; query vector at selection; vectorless skills stay
  available as an unranked fallback.
- **Workflows**: a successful trajectory (≥4 messages, ≥3 tool calls, success, session ids;
  1-minute storage cooldown) is embedded for recall (latest 50 considered).
- **Conversation summaries**: from title + compaction summary + linked memories, ≥6 messages,
  5-minute cooldown, source capped at 2,000 chars.
- **Trading-service RAG**: batch calls through `/embed` since 2026-10-06 (trading-service
  `9f29927f`); it keeps versioned `semantic_embedding` + `space` rows in its own Mongo store.
- **`/embed` callers generally** (`src/routes/EmbedRoutes.ts`,
  `ConversationEmbeddingService`, `MemoryExtractor`).

Not migrated: the LLMSortObsidian plugin still calls the Jetson directly with the legacy
`embeddinggemma` alias and no task type (tracked as debt, ledger). Cloud embedding providers
keep their own modality capabilities; the Jetson adapter is text-only.
