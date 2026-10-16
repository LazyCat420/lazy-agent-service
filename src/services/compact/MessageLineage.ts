// ported from prism-service src/services/compact/MessageLineage.ts
// ────────────────────────────────────────────────────────────
// MessageLineage — view copies know their verbatim original
// ────────────────────────────────────────────────────────────
// The context pipeline shrinks what the MODEL sees by replacing message
// objects with smaller copies (micro-compaction stubs, truncated tool
// results, compressed assistant turns). What gets PERSISTED must stay
// verbatim. Once those layers reach the current run (recency protection
// instead of user-turn protection), the loop's message array holds view
// copies of messages the turn has not persisted yet.
//
// Every layer that copies a message to shrink it registers the copy here;
// persistence maps each message back to its original via pristineOf().
// A WeakMap keeps it free: nothing is held once the loop drops the copy.
// ────────────────────────────────────────────────────────────

const originalByCopy = new WeakMap<object, object>();

/** The verbatim original of a (possibly shrunk) message — itself if never copied. */
export function pristineOf<T extends object>(message: T): T {
  return (originalByCopy.get(message) as T | undefined) ?? message;
}

/** Record that `copy` is a shrunk view of `source` (or of `source`'s original). */
export function markDerivedMessage<T extends object>(copy: T, source: T): T {
  if (copy !== source) originalByCopy.set(copy, pristineOf(source));
  return copy;
}
