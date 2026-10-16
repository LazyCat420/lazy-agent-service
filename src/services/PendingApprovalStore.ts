import type { Collection, Document } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS, PENDING_DECISIONS } from "../constants.ts";

/**
 * PendingApprovalStore — the durable half of a tool approval wait.
 * ported from prism-service src/services/PendingDecisionStore.ts (tool
 * approvals only; questions, plans and budget pauses are not stored here).
 *
 * One record per pending tool call in `pending_decisions`. ApprovalGate
 * writes the records BEFORE the `approval_required` card goes out, and every
 * decision is a conditional write (`status: "pending"` -> decided), so the
 * database — not a Map in the process that asked — says what is pending and
 * what was decided. A pending record therefore survives a restart, and a
 * second decision loses the conditional write (HTTP 409).
 *
 * Without a connected database (unit tests, a degraded boot) records live in
 * a per-instance map with the same semantics.
 */

export type PendingApprovalStatus = "pending" | "decided" | "cancelled";

export interface StoredApprovalDecision {
  decision: "allow" | "deny";
  scope: "call" | "batch" | "conversation";
  source: "user" | "superseded" | "timeout" | "turn_ended";
  reason?: string;
  editedArgs?: Record<string, unknown>;
}

export interface PendingApprovalRecord {
  /** `<conversationId>/<batchId>/<itemId>` — unique. */
  id: string;
  conversationId: string;
  batchId: string;
  /** The tool call's id (or `call-<position>` when the model gave none). */
  itemId: string;
  /** Position in the batch — results keep the model's order. */
  position: number;
  status: PendingApprovalStatus;
  name: string;
  args: Record<string, unknown>;
  tier?: string;
  tierLabel?: string;
  /** The tool's JSON-Schema `parameters` — edited arguments must satisfy it. */
  argsSchema: Record<string, unknown> | null;
  createdAt: string;
  decidedAt?: string;
  decision?: StoredApprovalDecision;
  /** False: decided with no live turn to take it. */
  delivered?: boolean;
  /** Set when the record leaves `pending`; the TTL index removes it after. */
  expiresAt?: Date;
}

export type NewPendingApproval = Omit<
  PendingApprovalRecord,
  "id" | "status" | "createdAt" | "decidedAt" | "decision" | "delivered" | "expiresAt"
>;

export type SettlePatch =
  | { status: "decided"; decision: StoredApprovalDecision; delivered: boolean }
  | { status: "cancelled"; source: StoredApprovalDecision["source"] };

function stripMongoId(document: Document): PendingApprovalRecord {
  const { _id: _ignored, ...rest } = document;
  return rest as unknown as PendingApprovalRecord;
}

export default class PendingApprovalStore {
  private readonly memory = new Map<string, PendingApprovalRecord>();

  private collection(): Collection<Document> | null {
    try {
      return MongoWrapper.getDb(MONGO_DB_NAME)?.collection(COLLECTIONS.PENDING_DECISIONS) ?? null;
    } catch {
      return null;
    }
  }

  async create(items: NewPendingApproval[]): Promise<PendingApprovalRecord[]> {
    const now = new Date().toISOString();
    const records: PendingApprovalRecord[] = items.map((item) => ({
      ...item,
      id: `${item.conversationId}/${item.batchId}/${item.itemId}`,
      status: "pending",
      createdAt: now,
    }));
    const collection = this.collection();
    if (collection) {
      if (records.length > 0) await collection.insertMany(records.map((record) => ({ ...record })));
    } else {
      for (const record of records) this.memory.set(record.id, record);
    }
    return records;
  }

  /** Pending records of a conversation, in the model's order. */
  async listPending(conversationId: string): Promise<PendingApprovalRecord[]> {
    const collection = this.collection();
    const records = collection
      ? (await collection.find({ conversationId, status: "pending" }).toArray()).map(stripMongoId)
      : [...this.memory.values()].filter(
          (record) => record.conversationId === conversationId && record.status === "pending",
        );
    return records.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.position - right.position,
    );
  }

  /** The most recent record for a tool call id, whatever its status. */
  async findByItem(conversationId: string, itemId: string): Promise<PendingApprovalRecord | null> {
    const collection = this.collection();
    const records = collection
      ? (await collection.find({ conversationId, itemId }).toArray()).map(stripMongoId)
      : [...this.memory.values()].filter(
          (record) => record.conversationId === conversationId && record.itemId === itemId,
        );
    records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return records[0] ?? null;
  }

  /** True when the conversation has a settled (decided/cancelled) record still retained. */
  async hasSettled(conversationId: string): Promise<boolean> {
    const collection = this.collection();
    if (collection) {
      const decided = await collection.find({ conversationId, status: "decided" }).toArray();
      if (decided.length > 0) return true;
      return (await collection.find({ conversationId, status: "cancelled" }).toArray()).length > 0;
    }
    return [...this.memory.values()].some(
      (record) => record.conversationId === conversationId && record.status !== "pending",
    );
  }

  /** Conditional write: true only for the caller that moved the record out of `pending`. */
  async settle(id: string, patch: SettlePatch): Promise<boolean> {
    const now = new Date();
    const fields: Record<string, unknown> = {
      status: patch.status,
      decidedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PENDING_DECISIONS.SETTLED_RETENTION_DAYS * 86_400_000),
      ...(patch.status === "decided"
        ? { decision: patch.decision, delivered: patch.delivered }
        : {
            decision: { decision: "deny", scope: "call", source: patch.source },
            delivered: false,
          }),
    };
    const collection = this.collection();
    if (collection) {
      const result = await collection.updateOne({ id, status: "pending" }, { $set: fields });
      return result.modifiedCount === 1;
    }
    const record = this.memory.get(id);
    if (!record || record.status !== "pending") return false;
    Object.assign(record, fields);
    return true;
  }

  /** Cancel everything still pending for a conversation (turn ended / superseded / timed out). */
  async cancelPending(
    conversationId: string,
    source: Exclude<StoredApprovalDecision["source"], "user">,
  ): Promise<void> {
    for (const record of await this.listPending(conversationId)) {
      await this.settle(record.id, { status: "cancelled", source });
    }
  }
}

export const pendingApprovalStore = new PendingApprovalStore();
