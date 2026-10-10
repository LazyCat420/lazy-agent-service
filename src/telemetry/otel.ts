// ============================================================
// OpenTelemetry tracing — loaded BEFORE the app:
//   node --import ./dist/src/telemetry/otel.js dist/boot.js
//
// Traces every incoming HTTP request (express), every outgoing
// fetch (undici) and every MongoDB command, and sends them to the
// NAS otel-collector → Tempo → Grafana (deploy-kit/infra/observability).
//
// Best-effort by construction: if a package is missing or the
// collector is down, the service runs exactly as before.
//
// Env:
//   OTEL_TRACING_ENABLED=0           turns tracing off
//   OTEL_EXPORTER_OTLP_ENDPOINT      default http://10.0.0.16:4318
//   OTEL_SERVICE_NAME                default lazy-agent-service
// ============================================================
import { register } from "node:module";

const IGNORED_PATHS = ["/health"];

/** Health checks every 30 s would bury the real traffic. */
export function isIgnoredPath(url: string | undefined): boolean {
  const path = (url ?? "").split("?")[0];
  return IGNORED_PATHS.includes(path);
}

export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.OTEL_TRACING_ENABLED ?? "1").trim());
}

async function start(): Promise<void> {
  // ESM packages are only patched when loaded through this hook.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [
    { NodeTracerProvider, BatchSpanProcessor },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME },
    { registerInstrumentations },
    { HttpInstrumentation },
    { ExpressInstrumentation },
    { UndiciInstrumentation },
    { MongoDBInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("@opentelemetry/instrumentation"),
    import("@opentelemetry/instrumentation-http"),
    import("@opentelemetry/instrumentation-express"),
    import("@opentelemetry/instrumentation-undici"),
    import("@opentelemetry/instrumentation-mongodb"),
  ]);

  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://10.0.0.16:4318").replace(/\/+$/, "");
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "lazy-agent-service",
    }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, timeoutMillis: 5000 })),
    ],
  });
  provider.register();

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => isIgnoredPath(req.url),
      }),
      new ExpressInstrumentation(),
      new UndiciInstrumentation(),
      // Command shapes only; query values can hold user data.
      new MongoDBInstrumentation({ enhancedDatabaseReporting: false }),
    ],
  });

  console.log(`[otel] tracing → ${endpoint} as ${process.env.OTEL_SERVICE_NAME || "lazy-agent-service"}`);
}

if (tracingEnabled()) {
  try {
    await start();
  } catch (err) {
    console.warn(`[otel] tracing off: ${(err as Error).message}`);
  }
} else {
  console.log("[otel] tracing disabled by OTEL_TRACING_ENABLED");
}
