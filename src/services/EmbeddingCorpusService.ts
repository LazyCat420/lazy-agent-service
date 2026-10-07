import { createHash } from "node:crypto";
import { Binary, type Document } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME, TRADING_MONGO_DB } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import { EmbeddingGemma2Client, embeddingSpace } from "./EmbeddingGemma2Client.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

/**
 * Re-embeds every registered corpus into the current embedding space, inside this
 * process.
 *
 * Every repo's vectors come from this service's `/embed`, so a model change makes
 * every stored vector stale at once. The corpora are registered here, and this worker
 * finds docs whose space differs from the current one and re-embeds them through the
 * shared Jetson queue — the queue live agent calls use. A reindex therefore needs no
 * container of its own and does not starve live calls: on 2026-10-06 a reindex run
 * as a separate process held the Jetson and every live `/embed` call got HTTP 429.
 *
 * A repo joins by storing, next to each vector, the exact text it embedded; the
 * corpus definition names that field. Old vectors (other fields, other spaces) are
 * never read or compared.
 */

/** Minimal surface of a Mongo collection the worker uses (the tests fake it). */
export interface CorpusCollection {
  find(filter: Document, options?: Document): { sort(spec: Document): { limit(n: number): { toArray(): Promise<Document[]> } } };
  bulkWrite(operations: Document[], options?: Document): Promise<{ matchedCount: number; modifiedCount: number }>;
  countDocuments(filter: Document): Promise<number>;
}

export interface CorpusDefinition {
  name: string;
  database: string;
  collection: string;
  /** Docs that belong to the corpus at all. */
  filter: Document;
  /** Fields the text is built from; a write only lands if they did not change meanwhile. */
  fields: string[];
  /** The text to embed for a doc, or "" to skip it. May read other collections. */
  text(doc: Document, collectionOf: (name: string) => CorpusCollection): Promise<string> | string;
  /** `object`: `{vector, space, sourceHash}` at `vectorField` (harness collections).
   *  `float32`: packed little-endian float32 at `vectorField`, the space at `spaceField`. */
  layout: "object" | "float32";
  vectorField: string;
  spaceField?: string;
  dimField?: string;
}

const join = (...parts: unknown[]) => parts.filter(part => typeof part === "string" && part.trim()).join("\n");

/** Built-in harness corpora plus repos that store their own embedded text. */
export const CORPORA: CorpusDefinition[] = [
  {
    name: "harness.memories", database: MONGO_DB_NAME, collection: COLLECTIONS.MEMORIES, filter: {},
    fields: ["title", "content"], layout: "object", vectorField: "semanticEmbedding",
    text: doc => doc.title ? `${doc.title}: ${doc.content || ""}` : doc.content || "",
  },
  {
    name: "harness.agent_skills", database: MONGO_DB_NAME, collection: COLLECTIONS.AGENT_SKILLS, filter: {},
    fields: ["name", "description", "content"], layout: "object", vectorField: "semanticEmbedding",
    text: doc => join(doc.name, doc.description, doc.content),
  },
  {
    name: "harness.workflow_memories", database: MONGO_DB_NAME, collection: COLLECTIONS.WORKFLOW_MEMORIES, filter: {},
    fields: ["summary"], layout: "object", vectorField: "semanticEmbedding",
    text: doc => (doc.summary || "").slice(0, 2000),
  },
  {
    // Only conversations that were indexed before; new ones are indexed by the hook.
    name: "harness.agent_conversations", database: MONGO_DB_NAME, collection: COLLECTIONS.AGENT_CONVERSATIONS,
    filter: { $or: [{ summaryEmbedding: { $exists: true } }, { summarySemanticEmbedding: { $exists: true } }] },
    fields: ["title", "compactionSummary", "agent", "id"], layout: "object", vectorField: "summarySemanticEmbedding",
    text: async (doc, collectionOf) => {
      const memories = await collectionOf(COLLECTIONS.MEMORIES)
        .find({ conversationId: doc.id, agent: doc.agent || "CODING" }, { projection: { title: 1, content: 1 } })
        .sort({ createdAt: -1 }).limit(20).toArray();
      const lines = memories.map(memory => memory.title ? `${memory.title}: ${memory.content || ""}` : memory.content || "");
      return join(doc.title, doc.compactionSummary, ...lines).slice(0, 2000);
    },
  },
  {
    // trading-service stores each chunk's embedded text in `embed_text`.
    name: "trading.embeddings", database: TRADING_MONGO_DB, collection: "embeddings",
    filter: { embed_text: { $type: "string", $ne: "" } },
    fields: ["embed_text"], layout: "float32", vectorField: "semantic_embedding", spaceField: "space", dimField: "semantic_dim",
    text: doc => doc.embed_text,
  },
];

const BATCH = 8;
const BUSY_RETRIES = 6;

function staleFilter(def: CorpusDefinition, space: string): Document {
  const key = def.layout === "object" ? `${def.vectorField}.space` : def.spaceField!;
  return { $and: [def.filter, { [key]: { $ne: space } }] };
}

function vectorUpdate(def: CorpusDefinition, vector: number[], space: string, text: string): Document {
  if (def.layout === "object") {
    return { [def.vectorField]: { vector, space, sourceHash: createHash("sha256").update(text).digest("hex") } };
  }
  const packed = Buffer.from(new Float32Array(vector).buffer);
  return { [def.vectorField]: new Binary(packed), [def.spaceField!]: space, ...(def.dimField ? { [def.dimField]: vector.length } : {}) };
}

export interface PassResult {
  updated: number;
  skippedEmpty: number;
  changedDuringPass: number;
  refused: number;
}

const statusCode = (error: unknown) => (error as { statusCode?: number })?.statusCode;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One pass over a corpus, newest `_id` first: every doc stale at the start is
 * re-embedded once. Docs skipped (empty text, refused) or changed meanwhile stay
 * stale for the next pass. Quarantine/identity failures and a Jetson that stays
 * busy end the pass by throwing.
 */
export async function reembedCorpus(
  def: CorpusDefinition,
  collectionOf: (name: string) => CorpusCollection,
  options: { shouldStop?: () => boolean; pauseMs?: number } = {},
): Promise<PassResult> {
  const space = embeddingSpace();
  const collection = collectionOf(def.collection);
  const stale = staleFilter(def, space);
  const projection = Object.fromEntries(def.fields.map(field => [field, 1]));
  const result: PassResult = { updated: 0, skippedEmpty: 0, changedDuringPass: 0, refused: 0 };
  let cursor: unknown;
  while (!options.shouldStop?.()) {
    const filter = cursor === undefined ? stale : { $and: [stale, { _id: { $lt: cursor } }] };
    const docs = await collection.find(filter, { projection }).sort({ _id: -1 }).limit(BATCH).toArray();
    if (!docs.length) break;
    cursor = docs[docs.length - 1]._id;
    const items: { doc: Document; text: string }[] = [];
    for (const doc of docs) {
      const text = String((await def.text(doc, collectionOf)) || "").trim();
      if (text) items.push({ doc, text });
      else result.skippedEmpty++;
    }
    if (!items.length) continue;
    const vectors = await embedWithRetry(items, result);
    const operations = items.flatMap((item, index) => vectors[index] ? [{ updateOne: {
      filter: { _id: item.doc._id, ...Object.fromEntries(def.fields.map(field => [field, item.doc[field] ?? null])) },
      update: { $set: vectorUpdate(def, vectors[index]!, space, item.text) },
    } }] : []);
    if (operations.length) {
      const written = await collection.bulkWrite(operations, { ordered: false });
      result.updated += written.modifiedCount;
      result.changedDuringPass += operations.length - written.matchedCount;
    }
    if (options.pauseMs) await sleep(options.pauseMs);
  }
  return result;
}

/** Batch first; a refused batch (e.g. a token limit) is retried text by text so
 * one bad doc does not block its neighbours. */
async function embedWithRetry(items: { text: string }[], result: PassResult): Promise<(number[] | null)[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await EmbeddingGemma2Client.embedMany(items.map(item => item.text), "document");
    } catch (error) {
      const code = statusCode(error);
      if (code === 429 && attempt < BUSY_RETRIES) { await sleep(5_000 * (attempt + 1)); continue; }
      if (code !== 400 && code !== 413) throw error;
      break;
    }
  }
  const vectors: (number[] | null)[] = [];
  for (const item of items) {
    try {
      vectors.push((await EmbeddingGemma2Client.embedMany([item.text], "document"))[0]);
    } catch (error) {
      const code = statusCode(error);
      if (code !== 400 && code !== 413) throw error;
      result.refused++;
      vectors.push(null);
    }
  }
  return vectors;
}

interface CorpusState {
  lastPass?: PassResult & { passes: number; startedAt: string; finishedAt: string };
  lastError?: string;
}

const state: Record<string, CorpusState> = {};
let running = false;
let stopRequested = false;
let timer: NodeJS.Timeout | undefined;

const collectionsFor = (def: CorpusDefinition) => (name: string) =>
  MongoWrapper.getCollection(def.database, name) as unknown as CorpusCollection;

const EmbeddingCorpusService = {
  /** Re-embed every corpus that has stale docs, one corpus at a time. */
  async runAll(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const def of CORPORA) {
        if (stopRequested) break;
        try {
          // A pass walks down from the newest _id at its start, so docs that
          // arrive meanwhile sit above its cursor: pass again until one finds
          // nothing to do (2026-10-06: trading's backfill restored ~25k chunks
          // during the first pass).
          const startedAt = new Date().toISOString();
          const run: PassResult & { passes: number } = { updated: 0, skippedEmpty: 0, changedDuringPass: 0, refused: 0, passes: 0 };
          for (let updated = -1; updated !== 0 && !stopRequested;) {
            const pass = await reembedCorpus(def, collectionsFor(def), { shouldStop: () => stopRequested, pauseMs: 25 });
            run.passes++;
            run.updated += pass.updated;
            run.refused += pass.refused;
            run.changedDuringPass += pass.changedDuringPass;
            run.skippedEmpty = pass.skippedEmpty; // skipped docs recur on every pass
            state[def.name] = { lastPass: { ...run, startedAt, finishedAt: new Date().toISOString() } };
            updated = pass.updated;
          }
          if (run.updated || run.refused) logger.info(`[EmbeddingCorpus] ${def.name}: ${JSON.stringify(run)}`);
        } catch (error) {
          state[def.name] = { ...state[def.name], lastError: getErrorMessage(error) };
          logger.warn(`[EmbeddingCorpus] ${def.name} stopped: ${getErrorMessage(error)}`);
          // Quarantine, identity mismatch or a Jetson that stays busy: the next
          // scheduled run tries again; retrying now would not clear them.
          if ([429, 502, 503].includes(statusCode(error) ?? 0)) break;
        }
      }
    } finally {
      running = false;
    }
  },

  /** Stale and current docs per corpus, plus the last pass. */
  async status() {
    const space = embeddingSpace();
    const corpora = await Promise.all(CORPORA.map(async def => {
      try {
        const collection = collectionsFor(def)(def.collection);
        const [total, stale] = await Promise.all([
          collection.countDocuments(def.filter),
          collection.countDocuments(staleFilter(def, space)),
        ]);
        return { name: def.name, database: def.database, collection: def.collection, total, stale, ...state[def.name] };
      } catch (error) {
        return { name: def.name, database: def.database, collection: def.collection, error: getErrorMessage(error), ...state[def.name] };
      }
    }));
    return { space, running, corpora };
  },

  /** Run now and every `intervalMs` after a start-up delay. */
  start(intervalMs = Number(process.env.EMBEDDING_REINDEX_INTERVAL_MS) || 15 * 60_000, delayMs = 120_000) {
    if (process.env.EMBEDDING_REINDEX_ENABLED === "false") {
      logger.info("[EmbeddingCorpus] disabled by EMBEDDING_REINDEX_ENABLED=false");
      return;
    }
    stopRequested = false;
    const tick = () => { this.runAll().catch(error => logger.error(`[EmbeddingCorpus] ${getErrorMessage(error)}`)); };
    timer = setTimeout(function schedule() { tick(); timer = setTimeout(schedule, intervalMs); }, delayMs);
    logger.info(`[EmbeddingCorpus] re-embedding ${CORPORA.length} corpora into the current space every ${intervalMs / 60_000} min`);
  },

  stop() {
    stopRequested = true;
    if (timer) clearTimeout(timer);
  },
};

export default EmbeddingCorpusService;
