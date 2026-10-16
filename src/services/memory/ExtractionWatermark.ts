import crypto from "crypto";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../../config.ts";
import { COLLECTIONS } from "../../constants.ts";
import logger from "../../utils/logger.ts";

// ────────────────────────────────────────────────────────────
// Memory-extraction watermark — the `memory:extract` diet.
// Simplified port of prism-service services/memory/ExtractionWatermark.ts:
// extraction runs after every response and used to re-read the whole
// transcript every time. Now each extraction reads only the messages after
// the last one already extracted, and a span with no user-authored message
// makes no call at all.
//
// IDENTITY. A message is identified by a hash of its role + normalized
// text (content and rawContent both — persistence swaps them on user
// messages, so the copy extracted this turn and the copy sent back next
// turn share the pair, not the field). A repeated short reply ("Done.")
// is disambiguated by also matching the message before it (the anchor).
//
// WHEN THE WATERMARK IS NOT FOUND (history edited, compaction removed the
// message) → the whole transcript, i.e. what every call read before the
// diet. Logged.
// ────────────────────────────────────────────────────────────

/** One message as the extractor sees it. */
export interface WatermarkEntry {
  role: string;
  /** Content-derived identities — content and rawContent both. */
  identities: string[];
}

export interface ExtractionSpan {
  /** Not yet extracted — the original message objects. */
  span: Array<Record<string, unknown>>;
  /** Why this span was chosen. */
  reason: "first" | "watermark" | "watermark-lost";
  /** True when the span carries at least one message the user wrote. */
  hasUserAuthored: boolean;
}

export interface ExtractionWatermarkDoc {
  memoryExtractedThroughMessageId: string;
  throughMessageIdentities: string[];
  anchorMessageIdentities: string[];
}

function hashIdentity(role: string, text: string): string {
  return crypto
    .createHash("sha256")
    .update(`${role}:${text.trim()}`)
    .digest("hex");
}

/** Content-derived identities for one message (content and rawContent both). */
export function messageIdentities(message: {
  role: string;
  content?: string;
  rawContent?: string;
}): string[] {
  const identities = new Set<string>();
  if (typeof message.content === "string" && message.content.trim()) {
    identities.add(hashIdentity(message.role, message.content));
  }
  if (typeof message.rawContent === "string" && message.rawContent.trim()) {
    identities.add(hashIdentity(message.role, message.rawContent));
  }
  return [...identities];
}

function toEntries(messages: Array<Record<string, unknown>>): WatermarkEntry[] {
  return messages.map((message) => ({
    role: String(message.role ?? ""),
    identities: messageIdentities(
      message as { role: string; content?: string; rawContent?: string },
    ),
  }));
}

/**
 * Select the not-yet-extracted span: everything after the stored watermark
 * message (matched by its identities, disambiguated by the anchor), or the
 * whole transcript when the watermark is gone.
 */
export function selectExtractionSpan(
  messages: Array<Record<string, unknown>>,
  watermark: ExtractionWatermarkDoc | null,
): ExtractionSpan {
  const entries = toEntries(messages);
  const hasUserAuthored = messages.some(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.trim().length > 0 &&
      message.content !== "[tool-only turn]" &&
      !(message as { _isSystemWarning?: boolean })._isSystemWarning,
  );

  if (
    !watermark ||
    !watermark.throughMessageIdentities ||
    watermark.throughMessageIdentities.length === 0
  ) {
    return { span: messages, reason: "first", hasUserAuthored };
  }

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const matchesWatermark = entry.identities.some((identity) =>
      watermark.throughMessageIdentities.includes(identity),
    );
    if (!matchesWatermark) continue;

    // Disambiguate a repeated short reply: the message before it must also
    // match the stored anchor. A match without the anchor is an older
    // identical exchange — keep scanning.
    if (index > 0) {
      const anchor = entries[index - 1];
      const anchorMatches =
        watermark.anchorMessageIdentities.length === 0 ||
        anchor.identities.some((identity) =>
          watermark.anchorMessageIdentities.includes(identity),
        );
      if (!anchorMatches) continue;
    } else if (watermark.anchorMessageIdentities.length > 0) {
      continue;
    }

    const span = messages.slice(index + 1);
    return { span, reason: "watermark", hasUserAuthored };
  }

  logger.info(
    "[ExtractionWatermark] Watermark message not found in transcript — extracting the whole transcript.",
  );
  return { span: messages, reason: "watermark-lost", hasUserAuthored };
}

function collection() {
  return MongoWrapper.getCollection(
    MONGO_DB_NAME,
    COLLECTIONS.EXTRACTION_WATERMARKS,
  );
}

/** Read the watermark for one conversation scope. Null when none stored (or Mongo is down). */
export async function readWatermark(
  scopeKey: string,
): Promise<ExtractionWatermarkDoc | null> {
  try {
    const col = collection();
    if (!col) return null;
    const doc = (await col.findOne({ key: scopeKey })) as unknown as
      | (ExtractionWatermarkDoc & { key: string })
      | null;
    return doc
      ? {
          memoryExtractedThroughMessageId: doc.memoryExtractedThroughMessageId,
          throughMessageIdentities: doc.throughMessageIdentities || [],
          anchorMessageIdentities: doc.anchorMessageIdentities || [],
        }
      : null;
  } catch (error) {
    logger.warn(
      `[ExtractionWatermark] read failed for ${scopeKey}: ${error instanceof Error ? error.message : String(error)} — extracting the whole transcript.`,
    );
    return null;
  }
}

/** Persist the watermark (last extracted message of this transcript). */
export async function writeWatermark(
  scopeKey: string,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  const previous = messages.length > 1 ? messages[messages.length - 2] : null;
  const through = messageIdentities(
    last as { role: string; content?: string; rawContent?: string },
  );
  if (through.length === 0) return;
  const doc: ExtractionWatermarkDoc & { key: string; updatedAt: Date } = {
    key: scopeKey,
    memoryExtractedThroughMessageId:
      (last.id as string) || through[0].slice(0, 16),
    throughMessageIdentities: through,
    anchorMessageIdentities: previous
      ? messageIdentities(
          previous as { role: string; content?: string; rawContent?: string },
        )
      : [],
    updatedAt: new Date(),
  };
  try {
    const col = collection();
    if (!col) return;
    await col.updateOne({ key: scopeKey }, { $set: doc }, { upsert: true });
  } catch (error) {
    logger.warn(
      `[ExtractionWatermark] write failed for ${scopeKey}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
