import { describe, it, expect } from "vitest";
import contractRouter from "../../src/routes/ContractRoutes.ts";

describe("ContractRoutes HTTP Endpoints", () => {
  function getRouteHandler(path: string) {
    const layer = (contractRouter as any).stack.find(
      (l: any) => l.route?.path === path,
    );
    expect(layer, `Route handler for ${path} should exist`).toBeTruthy();
    return layer.route.stack[0].handle;
  }

  it("GET /spec returns contract specification metadata and version 1.1.0", async () => {
    const handler = getRouteHandler("/spec");
    const headers: Record<string, string> = {};
    let status = 200;
    let body: any = null;

    const res: any = {
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      status(c: number) {
        status = c;
        return res;
      },
      json(payload: any) {
        body = payload;
        return res;
      },
    };

    await handler({}, res, (err: any) => {
      if (err) throw err;
    });

    expect(status).toBe(200);
    expect(headers["x-contract-version"]).toBe("1.2.0");
    expect(body.title).toBe("AgentRuntimeContractV1");
    expect(body.version).toBe("1.2.0");
    expect(body.status).toBe("CANONICAL");
    expect(body.capabilities_count).toBeGreaterThanOrEqual(12);
  });

  it("GET /capabilities returns list of registered global capabilities", async () => {
    const handler = getRouteHandler("/capabilities");
    const headers: Record<string, string> = {};
    let status = 200;
    let body: any = null;

    const res: any = {
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      status(c: number) {
        status = c;
        return res;
      },
      json(payload: any) {
        body = payload;
        return res;
      },
    };

    await handler({}, res, (err: any) => {
      if (err) throw err;
    });

    expect(status).toBe(200);
    expect(headers["x-contract-version"]).toBe("1.2.0");
    expect(body.capabilities.length).toBeGreaterThanOrEqual(12);
    const ids = body.capabilities.map((c: any) => c.id);
    expect(ids).toContain("global.web.search");
    expect(ids).toContain("global.data.sort");
  });

  it("GET /bundle returns full self-contained contract bundle for clients without sibling checkouts", async () => {
    const handler = getRouteHandler("/bundle");
    const headers: Record<string, string> = {};
    let status = 200;
    let body: any = null;

    const res: any = {
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      status(c: number) {
        status = c;
        return res;
      },
      json(payload: any) {
        body = payload;
        return res;
      },
    };

    await handler({}, res, (err: any) => {
      if (err) throw err;
    });

    expect(status).toBe(200);
    expect(headers["x-contract-version"]).toBe("1.2.0");
    expect(body.bundle_version).toBe("1.2.0");
    expect(body.run_contract).toBeDefined();
    expect(body.run_contract.definitions.CreateRunRequest).toBeDefined();
    expect(body.global_capabilities.length).toBeGreaterThanOrEqual(12);
  });
});
