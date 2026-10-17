import { describe, expect, it } from "vitest";
import { wantsSse } from "../StreamNegotiation.ts";

type Query = "true" | "false" | undefined;
type BodyStream = true | false | undefined;
type Accept = "text/event-stream" | "application/json" | "application/json, text/event-stream" | "*/*" | undefined;

const QUERIES: Query[] = [undefined, "true", "false"];
const BODIES: BodyStream[] = [undefined, true, false];
const ACCEPTS: Accept[] = [undefined, "*/*", "text/event-stream", "application/json", "application/json, text/event-stream"];

/** The contract, written out independently of the implementation's branching. */
function expected(query: Query, body: BodyStream, accept: Accept): boolean {
  if (query !== undefined) return query === "true";
  if (body !== undefined) return body;
  if (accept === "application/json") return false;
  return true;
}

function req(query: Query, body: BodyStream, accept: Accept) {
  return {
    query: query === undefined ? {} : { stream: query },
    headers: accept === undefined ? {} : { accept },
    body: body === undefined ? { messages: [] } : { messages: [], stream: body },
  } as unknown as Parameters<typeof wantsSse>[0];
}

describe("wantsSse — every combination of query, body and Accept", () => {
  const cases = QUERIES.flatMap((query) =>
    BODIES.flatMap((body) => ACCEPTS.map((accept) => [query, body, accept] as const)),
  );

  it.each(cases)("?stream=%s, body.stream=%s, Accept=%s", (query, body, accept) => {
    expect(wantsSse(req(query, body, accept))).toBe(expected(query, body, accept));
  });
});

describe("wantsSse — named rules", () => {
  it("streams when the caller sends no signal at all", () => {
    expect(wantsSse({ query: {}, headers: {}, body: undefined } as unknown as Parameters<typeof wantsSse>[0])).toBe(true);
  });

  it("streams for the fetch/undici/httpx default Accept: */*", () => {
    expect(wantsSse(req(undefined, undefined, "*/*"))).toBe(true);
  });

  it("returns JSON for each explicit opt-out on its own", () => {
    expect(wantsSse(req("false", undefined, undefined))).toBe(false);
    expect(wantsSse(req(undefined, false, undefined))).toBe(false);
    expect(wantsSse(req(undefined, undefined, "application/json"))).toBe(false);
  });

  it("always streams on ?stream=true, whatever the body or Accept say", () => {
    for (const body of BODIES) {
      for (const accept of ACCEPTS) expect(wantsSse(req("true", body, accept))).toBe(true);
    }
  });

  it("lets ?stream=false beat Accept: text/event-stream", () => {
    expect(wantsSse(req("false", undefined, "text/event-stream"))).toBe(false);
  });

  it("lets body stream:false beat Accept: text/event-stream", () => {
    expect(wantsSse(req(undefined, false, "text/event-stream"))).toBe(false);
  });

  it("streams when Accept lists both application/json and text/event-stream", () => {
    expect(wantsSse(req(undefined, undefined, "application/json, text/event-stream"))).toBe(true);
  });

  it("matches Accept case-insensitively", () => {
    const upper = { query: {}, headers: { accept: "Application/JSON" }, body: {} } as unknown as Parameters<typeof wantsSse>[0];
    expect(wantsSse(upper)).toBe(false);
  });

  it("ignores query values other than true/false", () => {
    const odd = { query: { stream: "1" }, headers: { accept: "application/json" }, body: {} } as unknown as Parameters<typeof wantsSse>[0];
    expect(wantsSse(odd)).toBe(false);
    const oddDefault = { query: { stream: "0" }, headers: {}, body: {} } as unknown as Parameters<typeof wantsSse>[0];
    expect(wantsSse(oddDefault)).toBe(true);
  });
});
