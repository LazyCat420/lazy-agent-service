---
part: Runtime
status: shipped
updated: 2026-10-06
review-by: 2026-11-06
---

# Shared harness embeddings and EmbeddingGemma 2 audit

Embedding generation already belonged to lazy-agent-service before this change. It is not a trading-only feature. Embeddings represent text for retrieval and clustering; they do not replace generation models or run on every reasoning/tool step.

## Shared integration

The default text embedding provider is now `jetson-embedding`, using `embeddinggemma-2` at `http://10.0.0.30:8001/v1`. The client verifies `google/embeddinggemma-2`, revision `914f7f89142e33e77833254d9c9b90c3cef7303b`, 768 native dimensions, readiness and quarantine state. `HARNESS_EMBEDDING_URL` can override the endpoint. No API key is required. Existing EmbeddingGemma settings and instance aliases resolve through the shared client. Explicit cloud provider/model selections remain supported, and configured models take precedence over provider defaults.

Any repository can use `POST /embed` on lazy-agent-service (NAS port 5591). Provider/model fields are optional. Supply the repository's `x-project` header and the caller's `x-username` header for attribution:

```json
{"text":"Find the deployment recovery procedure","input_type":"query","dimensions":768}
```

Use `input_type: "document"` for indexing and `"similarity"` for symmetric comparisons. The existing `taskType` values `RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT` and `SEMANTIC_SIMILARITY` work too. Unspecified tasks default to document retrieval. Send plain text; the server owns task prefixes. Responses include `embedding`, `dimensions`, `provider`, `model` and `space`.

To index a corpus, send `texts` (1–32 strings) instead of `text`. The response carries `embeddings` in input order, plus the same `dimensions`, `provider`, `model` and `space` as a single request. A batch is logged as one request row with counts only, never the texts. The whole batch holds the shared Jetson queue, so keep batches small (trading sends 8). Run corpus jobs through this endpoint rather than against the Jetson directly: a separate process has its own queue. While one ran on 2026-10-06, every live `/embed` call failed with HTTP 429 after its three retries.

The Jetson adapter is text-only. The existing cloud embedding providers retain their own modality capabilities. Long text is split at Unicode character boundaries into at most 1,800 UTF-8 bytes per chunk. Requests pack at most eight chunks within 7,000 total UTF-8 bytes; chunk vectors are summed and L2 normalized into one document vector. This is a bounded representation of the full text, not token-exact splitting or silent truncation. Token-limit refusals are surfaced. Index identity records the chunking/aggregation policy, model revision and dimensions. Use the same client and policy for query/document representations.

Calls are serialized within each service process, with a 60-second inference timeout. HTTP 429 observes numeric `Retry-After` with at most three attempts and a ten-second maximum delay. HTTP 503/quarantine and other refusals are surfaced immediately. Other callers on the LAN can still contend with this process; the Jetson's own single-inference guard remains authoritative.

## Coverage audit

| Process | Embedding use | Conditions and limits |
| --- | --- | --- |
| ReAct and vision-language harnesses | Shared prompt assembly retrieves agent memories, skills and workflows; response hooks store memory/workflow/summary representations | Retrieval uses scoped project and agent. Memory extraction needs a configured extraction model and meaningful messages. |
| Tree-of-thought and graph-of-thought harness strategies | Same standard lifecycle hooks | Strategy completion and existing minimum-message/tool guards apply. |
| General `/v1/runs` callers | Same shared harness; runtime now supplies its run ID as `agentConversationId` | Direct-mode runs now retrieve workflows. They can store successful workflows under arbitrary repo project names. |
| Schedules, timers and orchestrator callers | Enter the shared AgenticLoopService | Request scope and normal lifecycle conditions apply. |
| Temporary subagents | Shared embedding API and skill relevance are available | Existing long-term memory/workflow prompt injection is skipped for temporary workers. |
| Memory storage/search/consolidation | Document/query tasks, duplicate search and semantic clustering | New and old embedding spaces never compare. Memory scan considers the latest 500 matching documents; dedup the latest 200. |
| Skill creation/update and selection | Document task when saved; query task for selection | Skills without compatible vectors remain available as an unranked fallback. |
| Workflow memories | Document embedding of a successful tool trajectory and query embedding for recall | At least four messages, three tool calls, successful outcome and session IDs; one-minute storage cooldown. Latest 50 matching workflows considered. |
| Conversation summaries | Document embedding from title, compaction summary and linked memories | At least six messages; five-minute cooldown; source capped at 2,000 characters. Arbitrary repo projects now supported. General runs can create a scoped summary record. |
| Explicit workflow embedding nodes and `/embed` | Shared generation service | Caller can explicitly select another provider. |
| Trading-service RAG | Shared `/embed` batches since 2026-10-06 (trading-service `9f29927f`, landing via `handoff/harness-embeddings`): query/document tasks, versioned `semantic_embedding` + `space` in its own Mongo store | Its corpus is re-embedded separately; see below. Using `/prism-proxy` for chat does not run this repository's memory hooks. |
| LLMSortObsidian plugin | Calls the Jetson directly with the `embeddinggemma` alias and no task type; whole-note vectors cached in the vault's `.obsidian/embeddings.json` by the old model | Not migrated yet. |
| Independently launched agents in other repos | No automatic retrofit | Call this shared API or enter `/v1/runs`/the shared harness. Editing this service cannot change unrelated agent frameworks or Codex/Claude sessions automatically. |

Conversation summary vectors are persisted, but this repository has no local semantic session-search consumer of `summaryEmbedding`. Do not interpret storage as proof that every external `search_sessions` path reads the new summary index. Plain model chat, raw model requests and Prism's separately owned loops do not automatically run this repository's memory hooks.

## Trading-service migration

Before 2026-10-06, `trading-service/app/services/embedding_service.py` labelled its model `BAAI/bge-small-en-v1.5`, declared 384 dimensions and, because its primary URL defaulted to an unused `localhost`, always used Prism `/embed` with `provider: "vllm-3"`. It padded or sliced every vector to 384 and returned zero vectors on total failure. Its store had no model namespace. After the Jetson swap, that path returned EmbeddingGemma 2 vectors sliced to 384, while all 112,310 stored vectors came from the 300M model. Six live news docs re-embedded from their stored text scored cosine -0.047 to 0.095 against their own stored vectors: unrelated spaces.

Trading now calls this service's `/embed` with `texts` batches, `input_type` query or document, and requires the returned `space` to equal its recorded index identity. New vectors are stored in `semantic_embedding` with `space`; cosine search reads the current space only, and old vectors stay for rollback. The same change fixed a chunking defect: each chunk's write deleted the previous chunk, so 0 of 105,011 news sources held more than one doc. Trading re-embeds its corpus newest-first with its own script, through this endpoint. The operator guide is the trading-client chapter *Trading embeddings on the shared harness (EmbeddingGemma 2)*. Prism's repository is outside our ownership and was not modified.

`TinyModels/jetson_client.py` contains a legacy 15-second raw `embeddinggemma` client. The audit found no callers of its `create_embedding` method. Alias compatibility does not supply retrieval task formatting automatically.

## Harness index migration and rollback

The old `embedding` and `summaryEmbedding` fields are retained. New vectors live in `semanticEmbedding` and `summarySemanticEmbedding` objects with `{vector,space}`. Search and clustering require matching space/dimensions. This prevents old/new mixing during migration. Documents not yet migrated are absent from semantic memory/workflow results; skills fall back to inclusion until indexed.

`scripts/reindex-harness-embeddings.mjs` runs against the configured Mongo database from the built service image. It rebuilds memories, skills, workflows and previously indexed conversation summaries. It keeps one Jetson request in flight, logs counts without source texts/vectors, resumes by space marker, and checks source fields before writes. Existing legacy vectors remain untouched. Changed records can be refreshed by rerunning the script. New ordinary chat conversations are not retrospectively indexed.

The first migration run stopped part-way at 22:50 UTC: the Codex session that ran it ended on a context-compaction error, and its release script's exit trap stopped the migration container. By then memories (7,483) and skills (3) were complete, and workflow memories stood at 2,104 of 7,673. The script resumed from its space marker in a detached container (`harness-embeddinggemma2-reindex-20261006b`, 512 MiB cap) between 23:05:01 and 23:38:58 UTC. It updated the remaining 5,569 workflow memories and all 9,490 previously indexed conversation summaries. No source changed mid-migration and none was empty. Mongo afterwards: memories 7,483/7,483, skills 3/3, workflow memories 7,673/7,673, conversation summaries 9,490/9,490 carry the current space. The script talks to the Jetson from its own process, so live harness `/embed` calls got HTTP 429 for as long as it ran; a rerun should go off-hours.

Rollback requires the matching old service code and retained old fields. New records created by this release have only the new versioned vector, so a rollback must re-embed those records with the restored old model before expecting complete old-model recall. Restoring service code alone does not restore the old Jetson model.

## Validation and release evidence

Live Jetson health/models matched the pinned revision. A query request returned 768 unit-normalized floats in 0.365 seconds; an eight-item document batch returned eight ordered 768-dimensional unit vectors in 0.951 seconds. These synthetic timings do not establish sustained load or real-corpus quality.

Contract checks cover query/document task forwarding, returned ordering/dimensions, Unicode chunk preservation, no retries on quarantine, legacy-vector exclusion, provider/model resolution, and workflow/summary storage for a repo outside the persona list. All 46 tests in seven selected suites and the runtime build passed.

The first deployed release (`f602453`) passed all 929 tests and the NAS health gate. Consolidation projections and vector cleanup now read the versioned field as well; a regression check confirms that legacy/different-model vectors do not join new-model clusters. That release (`f583999`) passed all 930 tests and is healthy on the NAS. Through the deployed `/embed` it returned unit-normalized vectors: query 768 in 0.384 s, document 768 in 0.164 s, query 256 in 0.143 s.

The `texts` batch release (`b772cac`) passed all 935 tests and was deployed at 23:09 UTC. After the harness migration finished, a three-text document batch from the trading container returned three ordered, unit-length 768-dimension vectors in the current space in 1.02 s, while trading's own reindex was sharing the queue. Machine-readable evidence: `documentation/artifacts/embeddinggemma2-20261006.json`.
