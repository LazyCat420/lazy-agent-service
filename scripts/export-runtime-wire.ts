#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RUNTIME_WIRE_CONTRACT_VERSION, RuntimeWireSchema } from "../src/contracts/RuntimeWire.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "contracts", "generated", "runtime-wire-v1.json");
const schema = z.toJSONSchema(RuntimeWireSchema, { target: "draft-2020-12", unrepresentable: "any" });
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
};
const canonical = JSON.stringify(stable(schema));
const digest = `sha256-${crypto.createHash("sha256").update(canonical).digest("hex")}`;
const document = {
  contract_version: RUNTIME_WIRE_CONTRACT_VERSION,
  digest,
  generated_by: "scripts/export-runtime-wire.ts",
  schema,
};
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(document, null, 2)}\n`, "utf8");
console.log(`[runtime-wire] wrote ${path.relative(root, destination)} (${digest})`);
