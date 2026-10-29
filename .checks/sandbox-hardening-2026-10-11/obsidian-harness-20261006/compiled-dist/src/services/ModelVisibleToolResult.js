/** What an MCP tool result says to the model, sized to what prism passes through whole.
 *
 * prism (the build deployed 2026-09-27 19:36 PDT) hands a tool result to the model unchanged only
 * while `JSON.stringify(result)` is at most 8,000 characters, and only while no array in it trips
 * its list cap (FunctionCallingUtilities.truncateToolResult). Past either, the result is offloaded
 * and the model gets a preview plus a pointer to `retrieve_offloaded_content` — a prism tool no
 * trading role is granted, so the model shim refuses the call and ends the stream, and prism now
 * fails the whole pass on a stream that ends early.
 *
 * Every trading tool answers through the Python bridge as an OpenAI tool message —
 * `{role, tool_call_id: "call_lazy_tool_bridge", name, content: "<the result, JSON-escaped>",
 * service_source}` — so prism's pretty-printed copy was seven lines with the whole result on ONE of
 * them, and the preview (whole leading lines) showed the four wrapper keys and nothing else. On
 * 2026-09-28 that stub replaced 13 of 13 get_finnhub_news results and 7 of 22 whiteboard_read
 * results (0 of 249 tool results on 2026-09-25, before the prism deploy), and five junior-analyst
 * passes died on the refused retrieval.
 *
 * So the model now gets the result itself — no wrapper, no second layer of escaping — cut here,
 * where a cut can keep whole lines or whole items and say what it left out, to stay inside both
 * prism rules. The trading service still records the full result: it executed the tool.
 */
/** prism inlines a result while JSON.stringify(result) is at most this many characters. */
export const PRISM_INLINE_RESULT_CHARS = 8000;
/** Where we cut: under prism's limit, with room for a field prism may add (an image stamp). */
export const RESULT_BUDGET_CHARS = 7600;
/** prism caps a top-level array, or an array under one of these keys, at 10 items whatever its size. */
export const PRISM_CAPPED_ARRAY_KEYS = ["events", "products", "trends", "articles", "earnings", "predictions", "commodities"];
export const PRISM_ARRAY_ITEMS = 10;
const MIN_STRING_CHARS = 120;
/** The trading bridge's tool-message content, or null for any other result. */
export function bridgeContent(result) {
    if (!result || typeof result !== "object" || Array.isArray(result))
        return null;
    const record = result;
    return record.role === "tool" && typeof record.content === "string" ? record.content : null;
}
function parse(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    }
    catch {
        return { ok: false };
    }
}
const size = (value) => JSON.stringify(value).length;
/** The characters prism measures for this MCP text (MCPClientService.transformCallResult then
 * truncateToolResult): a JSON object or array as compact JSON, anything that is not JSON as
 * `{result: text}`, a JSON string as itself. Other JSON scalars pass through unmeasured. */
export function prismMeasure(text) {
    const parsed = parse(text);
    if (!parsed.ok)
        return size({ result: text });
    if (typeof parsed.value === "string")
        return parsed.value.length;
    if (parsed.value === null || typeof parsed.value !== "object")
        return 0;
    return size(parsed.value);
}
/** Whether prism's list cap would fire on this value regardless of its size. */
function tripsListCap(value) {
    if (Array.isArray(value))
        return value.length > PRISM_ARRAY_ITEMS;
    if (!value || typeof value !== "object")
        return false;
    return PRISM_CAPPED_ARRAY_KEYS.some((key) => {
        const items = value[key];
        return Array.isArray(items) && items.length > PRISM_ARRAY_ITEMS;
    });
}
/** Strings over `maxChars` and arrays over `maxItems` shortened, each with a note of what went.
 * An array prism caps by rule keeps at most PRISM_ARRAY_ITEMS entries INCLUDING the note. */
function limit(value, maxChars, maxItems, capped = false) {
    if (typeof value === "string") {
        return value.length > maxChars ? `${value.slice(0, maxChars)}… [${value.length - maxChars} chars cut]` : value;
    }
    if (Array.isArray(value)) {
        const keep = Math.min(maxItems, capped ? PRISM_ARRAY_ITEMS - 1 : maxItems);
        if (value.length <= Math.min(maxItems, capped ? PRISM_ARRAY_ITEMS : maxItems)) {
            return value.map((item) => limit(item, maxChars, maxItems));
        }
        return [...value.slice(0, keep).map((item) => limit(item, maxChars, maxItems)),
            `[${value.length - keep} more items cut to fit the per-result limit]`];
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            out[key] = limit(item, maxChars, maxItems, PRISM_CAPPED_ARRAY_KEYS.includes(key));
        }
        return out;
    }
    return value;
}
function longest(value, pick) {
    let best = pick(value);
    if (Array.isArray(value))
        for (const item of value)
            best = Math.max(best, longest(item, pick));
    else if (value && typeof value === "object")
        for (const item of Object.values(value))
            best = Math.max(best, longest(item, pick));
    return best;
}
/** The largest n in [low, high] with fits(n), or null when fits(low) is false. fits is monotone. */
function largest(low, high, fits) {
    if (!fits(low))
        return null;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(mid))
            low = mid;
        else
            high = mid - 1;
    }
    return low;
}
/** A JSON value shortened until prism takes it whole: first long strings, then long lists. */
function fitJson(value, budget) {
    const root = Array.isArray(value);
    const shaped = (maxChars, maxItems) => {
        const limited = limit(value, maxChars, maxItems, root);
        if (!limited || typeof limited !== "object" || Array.isArray(limited))
            return limited;
        return { ...limited, _cut: "lazy-agent-service shortened this result to fit the model's per-result limit" };
    };
    const fits = (candidate) => size(candidate) <= budget && !tripsListCap(candidate);
    const maxString = longest(value, (v) => (typeof v === "string" ? v.length : 0));
    const maxArray = longest(value, (v) => (Array.isArray(v) ? v.length : 0));
    const chars = largest(MIN_STRING_CHARS, Math.max(MIN_STRING_CHARS, maxString), (n) => fits(shaped(n, Number.MAX_SAFE_INTEGER)));
    if (chars !== null)
        return shaped(chars, Number.MAX_SAFE_INTEGER);
    const items = largest(1, Math.max(1, maxArray), (n) => fits(shaped(MIN_STRING_CHARS, n)));
    return items === null ? null : shaped(MIN_STRING_CHARS, items);
}
/** Text cut to whole leading lines (or the head of the first line) under the budget, as prism
 * will wrap it: {result: text}. */
function fitText(text, budget) {
    const lines = text.split("\n");
    const note = (shown, chars) => `\n[lazy-agent-service: cut to fit the model's per-result limit — showing ${shown} of ${lines.length} lines, ${chars} of ${text.length} characters]`;
    const fits = (candidate) => size({ result: candidate }) <= budget;
    const kept = largest(0, lines.length, (n) => {
        const head = lines.slice(0, n).join("\n");
        return fits(head + note(n, head.length));
    });
    if (kept && kept > 0) {
        const head = lines.slice(0, kept).join("\n");
        return head + note(kept, head.length);
    }
    const chars = largest(0, lines[0].length, (n) => fits(`${lines[0].slice(0, n)}…${note(0, n)}`)) ?? 0;
    return `${lines[0].slice(0, chars)}…${note(0, chars)}`;
}
/** The trading bridge's result as the model should read it: unwrapped, and within prism's rules. */
export function fitForPrism(content, budget = RESULT_BUDGET_CHARS) {
    const before = prismMeasure(content);
    const parsed = parse(content);
    if (parsed.ok && parsed.value !== null && typeof parsed.value === "object") {
        if (before <= budget && !tripsListCap(parsed.value))
            return { text: content, before, after: before, cut: false };
        const fitted = fitJson(parsed.value, budget);
        if (fitted !== null) {
            const text = JSON.stringify(fitted);
            return { text, before, after: prismMeasure(text), cut: true };
        }
        const text = fitText(JSON.stringify(parsed.value, null, 1), budget);
        return { text, before, after: prismMeasure(text), cut: true };
    }
    if (before <= budget)
        return { text: content, before, after: before, cut: false };
    const text = fitText(parsed.ok && typeof parsed.value === "string" ? parsed.value : content, budget);
    return { text, before, after: prismMeasure(text), cut: true };
}
/** The MCP text for a dispatched result: a bridge tool message becomes its fitted content; every
 * other result keeps the text it always had. */
export function modelVisibleText(result) {
    const content = bridgeContent(result);
    if (content === null)
        return { text: typeof result === "string" ? result : JSON.stringify(result), cut: false };
    return fitForPrism(content);
}
//# sourceMappingURL=ModelVisibleToolResult.js.map