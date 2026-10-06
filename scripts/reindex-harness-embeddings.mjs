// Run inside the deployed image (or with MONGO_URI and compiled runtime locally).
// Existing embedding/summaryEmbedding fields remain available for rollback.
import { MongoClient } from "mongodb";
import { createHash } from "node:crypto";
import { EmbeddingGemma2Client, embeddingSpace } from "../dist/src/services/EmbeddingGemma2Client.js";

const client = await MongoClient.connect(process.env.MONGO_URI);
const db = client.db(process.env.PRISM_SERVICE_MONGO_DB_NAME || process.env.PRISM_MONGO_DB_NAME || process.env.MONGO_DB_NAME || "prism");
const report = { space: embeddingSpace(), startedAt: new Date().toISOString(), collections: {} };
const definitions = [
  ["memories", "semanticEmbedding", ["title", "content"], doc => doc.title ? `${doc.title}: ${doc.content || ""}` : doc.content || ""],
  ["agent_skills", "semanticEmbedding", ["name", "description", "content"], doc => [doc.name, doc.description, doc.content].filter(Boolean).join("\n")],
  ["workflow_memories", "semanticEmbedding", ["summary"], doc => (doc.summary || "").slice(0, 2000)],
  ["agent_conversations", "summarySemanticEmbedding", ["title", "compactionSummary", "agent", "id"], doc => [doc.title, doc.compactionSummary].filter(Boolean).join("\n").slice(0, 2000)],
];
try {
  for (const [name, field, fields, source] of definitions) {
    const collection = db.collection(name);
    const stats = { updated: 0, skippedEmpty: 0, changedDuringMigration: 0 };
    report.collections[name] = stats;
    const filter = { [`${field}.space`]: { $ne: embeddingSpace() } };
    // Summary index previously existed only on these conversations. New sessions
    // in any repo are indexed by the hook; don't index ordinary chat retrospectively.
    if (name === "agent_conversations") filter.summaryEmbedding = { $exists: true };
    const cursor = collection.find(filter, { projection: Object.fromEntries(fields.map(key => [key, 1])) }).batchSize(32);
    let pending = [];
    async function flush() {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      const vectors = await EmbeddingGemma2Client.embedMany(batch.map(item => item.text), "document");
      const operations = batch.map((item, index) => ({ updateOne: {
        filter: { _id: item.doc._id, ...Object.fromEntries(fields.map(key => [key, item.doc[key] ?? null])) },
        update: { $set: { [field]: { vector: vectors[index], space: embeddingSpace(), sourceHash: createHash("sha256").update(item.text).digest("hex") } } },
      } }));
      const result = await collection.bulkWrite(operations, { ordered: true });
      stats.updated += result.modifiedCount;
      stats.changedDuringMigration += batch.length - result.matchedCount;
      if (stats.updated % 100 < batch.length) console.log(JSON.stringify({ collection: name, ...stats }));
    }
    for await (const doc of cursor) {
      let text = source(doc);
      if (name === "agent_conversations") {
        const memories = await db.collection("memories").find({ conversationId: doc.id, agent: doc.agent || "CODING" }, { projection: { title: 1, content: 1 } }).sort({ createdAt: -1 }).limit(20).toArray();
        text = [doc.title, doc.compactionSummary, ...memories.map(memory => memory.title ? `${memory.title}: ${memory.content || ""}` : memory.content || "")].filter(Boolean).join("\n").slice(0, 2000);
      }
      if (!text.trim()) { stats.skippedEmpty++; continue; }
      pending.push({ doc, text });
      if (pending.length === 8) await flush();
    }
    await flush();
    console.log(JSON.stringify({ collection: name, ...stats, complete: true }));
  }
  report.completedAt = new Date().toISOString();
  console.log(JSON.stringify(report));
} finally { await client.close(); }
