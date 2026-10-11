/**
 * Run a model's tool calls: read-only ones concurrently in windows of
 * `concurrency`, then every call that can write one at a time in the order
 * the model asked for them. Callers keep results on each call, so message
 * order never depends on completion order.
 */
export async function scheduleToolCalls<T>(
  calls: T[],
  run: (call: T) => Promise<void>,
  isReadOnly: (call: T) => boolean,
  concurrency: number,
): Promise<void> {
  const readOnly = calls.filter(isReadOnly);
  const writes = calls.filter((call) => !readOnly.includes(call));
  const width = Math.max(1, Math.floor(concurrency));
  for (let start = 0; start < readOnly.length; start += width) {
    await Promise.all(readOnly.slice(start, start + width).map(run));
  }
  for (const call of writes) await run(call);
}
