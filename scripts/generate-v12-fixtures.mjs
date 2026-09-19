import fs from "node:fs";
import path from "node:path";

const targetDirs = [
  path.resolve("contracts", "fixtures"),
  path.resolve("docs", "contracts", "fixtures"),
];

for (const dir of targetDirs) {
  fs.mkdirSync(dir, { recursive: true });
}

const fixtures = {
  "success-text-only.json": {
    contract_version: "1.2.0",
    fixture_id: "success-text-only",
    description: "Pure LLM inference completion with zero tool invocations.",
    request: {
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      contract_version: "1.2.0",
      app_id: "html-notes",
      session_id: "sess_test_101",
      input: "Summarize the core premise of reactive architectures.",
      stream: false,
    },
    events: [
      {
        id: "evt-001",
        run_id: "run-text-101",
        type: "run.admitted",
        timestamp: "2026-09-19T11:00:00.000Z",
        data: { run_id: "run-text-101", status: "admitted", profile_id: "html-notes-researcher-v1" },
      },
      {
        id: "evt-002",
        run_id: "run-text-101",
        type: "run.started",
        timestamp: "2026-09-19T11:00:00.020Z",
        data: { status: "running" },
      },
      {
        id: "evt-003",
        run_id: "run-text-101",
        type: "message.completed",
        timestamp: "2026-09-19T11:00:01.100Z",
        data: { role: "assistant", content: "Reactive architectures prioritize responsiveness, resilience, and message-driven elasticity." },
      },
      {
        id: "evt-004",
        run_id: "run-text-101",
        type: "run.completed",
        timestamp: "2026-09-19T11:00:01.150Z",
        data: { status: "completed" },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-text-101",
      status: "completed",
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      messages: [{ role: "assistant", content: "Reactive architectures prioritize responsiveness, resilience, and message-driven elasticity." }],
      usage: { prompt_tokens: 32, completion_tokens: 18, total_tokens: 50, tool_calls_count: 0, retry_count: 0, duration_ms: 1150 },
      evidence_records: [],
    },
  },

  "success-global-web-search.json": {
    contract_version: "1.2.0",
    fixture_id: "success-global-web-search",
    description: "Shared runtime executes global.web.search, records evidence, and synthesizes response.",
    request: {
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      contract_version: "1.2.0",
      app_id: "html-notes",
      session_id: "sess_test_102",
      input: "Search for latest AI chip advances in 2026.",
    },
    events: [
      {
        id: "evt-010",
        run_id: "run-search-102",
        type: "run.admitted",
        timestamp: "2026-09-19T11:01:00.000Z",
        data: { run_id: "run-search-102", status: "admitted" },
      },
      {
        id: "evt-011",
        run_id: "run-search-102",
        type: "run.started",
        timestamp: "2026-09-19T11:01:00.030Z",
        data: { status: "running" },
      },
      {
        id: "evt-012",
        run_id: "run-search-102",
        type: "tool.invoked",
        timestamp: "2026-09-19T11:01:00.300Z",
        data: {
          tool_call_id: "tc_search_01",
          tool_name: "global.web.search",
          execution: "shared",
          effect: "read",
          arguments: { query: "latest AI chip advances 2026", max_results: 3 },
          authorization_receipt: {
            receipt_id: "auth_rec_001",
            issued_at: "2026-09-19T11:01:00.300Z",
            tool_name: "global.web.search",
            execution: "shared",
            effect: "read",
          },
        },
      },
      {
        id: "evt-013",
        run_id: "run-search-102",
        type: "tool.completed",
        timestamp: "2026-09-19T11:01:01.200Z",
        data: {
          tool_call_id: "tc_search_01",
          tool_name: "global.web.search",
          result: { query: "latest AI chip advances 2026", results: [{ title: "Next-gen Accelerators", url: "https://example.com/chips", snippet: "New architectures deliver 4x efficiency." }] },
          evidence_records: [{ evidence_id: "ev_search_01", source: "global.web.search", provenance_hash: "sha256-11223344" }],
        },
      },
      {
        id: "evt-014",
        run_id: "run-search-102",
        type: "run.completed",
        timestamp: "2026-09-19T11:01:01.800Z",
        data: { status: "completed" },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-search-102",
      status: "completed",
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      messages: [{ role: "assistant", content: "Recent 2026 AI accelerators deliver 4x efficiency gains." }],
      usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165, tool_calls_count: 1, retry_count: 0, duration_ms: 1800 },
      evidence_records: [{ evidence_id: "ev_search_01", source: "global.web.search", provenance_hash: "sha256-11223344" }],
    },
  },

  "success-local-tool-admission.json": {
    contract_version: "1.2.0",
    fixture_id: "success-local-tool-admission",
    description: "Runtime authorizes and admits a local application tool call without executing it in runtime.",
    request: {
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      contract_version: "1.2.0",
      app_id: "html-notes",
      session_id: "session_123",
      input: "Add an analytical widget to the canvas.",
    },
    events: [
      {
        id: "evt-loc-001",
        run_id: "run_123",
        type: "run.admitted",
        timestamp: "2026-09-19T11:02:00.000Z",
        data: { run_id: "run_123", status: "admitted" },
      },
      {
        id: "evt-loc-002",
        run_id: "run_123",
        type: "run.started",
        timestamp: "2026-09-19T11:02:00.020Z",
        data: { status: "running" },
      },
      {
        id: "evt-loc-003",
        run_id: "run_123",
        type: "tool.invoked",
        timestamp: "2026-09-19T11:02:00.400Z",
        data: {
          tool_call_id: "tc_123",
          tool_name: "html_notes.canvas.upsert_widget",
          execution: "local",
          effect: "write",
          arguments: { widget_type: "notes_card", title: "Key Findings" },
          authorization_receipt: {
            receipt_id: "auth_rec_123",
            issued_at: "2026-09-19T11:02:00.400Z",
            tool_name: "html_notes.canvas.upsert_widget",
            execution: "local",
            effect: "write",
            signature: "sha256-mock-auth-signature",
          },
          required_scope: {
            app_id: "html-notes",
            session_id: "session_123",
          },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run_123",
      status: "waiting_for_tool",
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      messages: [],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100, tool_calls_count: 1, retry_count: 0, duration_ms: 400 },
      evidence_records: [],
    },
  },

  "success-local-tool-completion.json": {
    contract_version: "1.2.0",
    fixture_id: "success-local-tool-completion",
    description: "Application completes local tool execution and relays result back to finalize run.",
    request: {
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      contract_version: "1.2.0",
      app_id: "html-notes",
      session_id: "session_123",
      input: "Add an analytical widget to the canvas.",
    },
    events: [
      {
        id: "evt-loc-010",
        run_id: "run_123",
        type: "tool.completed",
        timestamp: "2026-09-19T11:02:01.000Z",
        data: {
          tool_call_id: "tc_123",
          tool_name: "html_notes.canvas.upsert_widget",
          execution: "local",
          result: { widget_id: "widget_abc", status: "created", element_count: 1 },
          duration_ms: 600,
        },
      },
      {
        id: "evt-loc-011",
        run_id: "run_123",
        type: "run.completed",
        timestamp: "2026-09-19T11:02:01.200Z",
        data: { status: "completed" },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run_123",
      status: "completed",
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      messages: [{ role: "assistant", content: "Widget Key Findings added to canvas." }],
      usage: { prompt_tokens: 140, completion_tokens: 35, total_tokens: 175, tool_calls_count: 1, retry_count: 0, duration_ms: 1200 },
      evidence_records: [],
    },
  },

  "denied-global-tool.json": {
    contract_version: "1.2.0",
    fixture_id: "denied-global-tool",
    description: "Agent attempts to call a global capability not whitelisted by the profile policy.",
    request: {
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      contract_version: "1.2.0",
      input: "Transcribe audio stream.",
    },
    events: [
      {
        id: "evt-denied-001",
        run_id: "run-denied-01",
        type: "run.started",
        timestamp: "2026-09-19T11:03:00.000Z",
        data: { status: "running" },
      },
      {
        id: "evt-denied-002",
        run_id: "run-denied-01",
        type: "tool.failed",
        timestamp: "2026-09-19T11:03:00.250Z",
        data: {
          tool_name: "global.media.transcribe",
          error: {
            code: "POLICY_VIOLATION",
            category: "POLICY",
            message: "Capability 'global.media.transcribe' is not permitted by profile 'html-notes-researcher-v1'",
            retryable: false,
          },
        },
      },
      {
        id: "evt-denied-003",
        run_id: "run-denied-01",
        type: "run.failed",
        timestamp: "2026-09-19T11:03:00.300Z",
        data: {
          error: {
            code: "POLICY_VIOLATION",
            category: "POLICY",
            message: "Capability 'global.media.transcribe' is not permitted by profile 'html-notes-researcher-v1'",
            retryable: false,
          },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-denied-01",
      status: "failed",
      profile_id: "html-notes-researcher-v1",
      messages: [],
      error: {
        code: "POLICY_VIOLATION",
        category: "POLICY",
        message: "Capability 'global.media.transcribe' is not permitted by profile 'html-notes-researcher-v1'",
        retryable: false,
      },
    },
  },

  "denied-local-tool.json": {
    contract_version: "1.2.0",
    fixture_id: "denied-local-tool",
    description: "Agent attempts to call an unwhitelisted or cross-session local tool.",
    request: {
      profile_id: "html-notes-researcher-v1",
      profile_version: "1.2.0",
      contract_version: "1.2.0",
      app_id: "html-notes",
      session_id: "sess_alpha",
      input: "Delete widget in foreign session sess_beta.",
    },
    events: [
      {
        id: "evt-dloc-001",
        run_id: "run-dloc-01",
        type: "run.started",
        timestamp: "2026-09-19T11:04:00.000Z",
        data: { status: "running" },
      },
      {
        id: "evt-dloc-002",
        run_id: "run-dloc-01",
        type: "tool.failed",
        timestamp: "2026-09-19T11:04:00.200Z",
        data: {
          tool_name: "html_notes.canvas.remove_widget",
          error: {
            code: "SCOPE_VIOLATION",
            category: "POLICY",
            message: "Tool invocation lacks valid session scope for 'sess_beta'",
            retryable: false,
          },
        },
      },
      {
        id: "evt-dloc-003",
        run_id: "run-dloc-01",
        type: "run.failed",
        timestamp: "2026-09-19T11:04:00.250Z",
        data: {
          error: {
            code: "SCOPE_VIOLATION",
            category: "POLICY",
            message: "Tool invocation lacks valid session scope for 'sess_beta'",
            retryable: false,
          },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-dloc-01",
      status: "failed",
      profile_id: "html-notes-researcher-v1",
      messages: [],
      error: {
        code: "SCOPE_VIOLATION",
        category: "POLICY",
        message: "Tool invocation lacks valid session scope for 'sess_beta'",
        retryable: false,
      },
    },
  },

  "cancellation.json": {
    contract_version: "1.2.0",
    fixture_id: "cancellation",
    description: "Run execution is aborted midway via cancellation signal.",
    request: {
      profile_id: "html-notes-researcher-v1",
      contract_version: "1.2.0",
      input: "Long running synthesis.",
    },
    events: [
      {
        id: "evt-can-001",
        run_id: "run-can-01",
        type: "run.started",
        timestamp: "2026-09-19T11:05:00.000Z",
        data: { status: "running" },
      },
      {
        id: "evt-can-002",
        run_id: "run-can-01",
        type: "run.cancelled",
        timestamp: "2026-09-19T11:05:00.500Z",
        data: {
          status: "cancelled",
          error: { code: "RUN_CANCELLED", category: "CLIENT", message: "Run cancelled by user", retryable: false },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-can-01",
      status: "cancelled",
      profile_id: "html-notes-researcher-v1",
      messages: [],
      error: { code: "RUN_CANCELLED", category: "CLIENT", message: "Run cancelled by user", retryable: false },
    },
  },

  "timeout.json": {
    contract_version: "1.2.0",
    fixture_id: "timeout",
    description: "Run execution exceeds configured deadline budget and transitions to timed_out.",
    request: {
      profile_id: "html-notes-researcher-v1",
      contract_version: "1.2.0",
      budget: { max_duration_ms: 1000 },
      input: "Process massive dataset.",
    },
    events: [
      {
        id: "evt-to-001",
        run_id: "run-to-01",
        type: "run.started",
        timestamp: "2026-09-19T11:06:00.000Z",
        data: { status: "running" },
      },
      {
        id: "evt-to-002",
        run_id: "run-to-01",
        type: "run.failed",
        timestamp: "2026-09-19T11:06:01.050Z",
        data: {
          error: { code: "DEADLINE_EXCEEDED", category: "RESOURCE", message: "Run exceeded max_duration_ms limit of 1000ms", retryable: false },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-to-01",
      status: "timed_out",
      profile_id: "html-notes-researcher-v1",
      messages: [],
      error: { code: "DEADLINE_EXCEEDED", category: "RESOURCE", message: "Run exceeded max_duration_ms limit of 1000ms", retryable: false },
    },
  },

  "provider-retry.json": {
    contract_version: "1.2.0",
    fixture_id: "provider-retry",
    description: "Upstream provider 503 error is automatically retried within budget limits.",
    request: {
      profile_id: "html-notes-researcher-v1",
      contract_version: "1.2.0",
      input: "Query during transient upstream blip.",
    },
    events: [
      {
        id: "evt-ret-001",
        run_id: "run-ret-01",
        type: "run.started",
        timestamp: "2026-09-19T11:07:00.000Z",
        data: { status: "running" },
      },
      {
        id: "evt-ret-002",
        run_id: "run-ret-01",
        type: "run.completed",
        timestamp: "2026-09-19T11:07:02.100Z",
        data: { status: "completed" },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-ret-01",
      status: "completed",
      profile_id: "html-notes-researcher-v1",
      messages: [{ role: "assistant", content: "Successfully resolved after transient retry." }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70, tool_calls_count: 0, retry_count: 1, duration_ms: 2100 },
      evidence_records: [],
    },
  },

  "malformed-event.json": {
    contract_version: "1.2.0",
    fixture_id: "malformed-event",
    description: "Provider emits malformed chunk; runtime catches and terminates safely with structured error.",
    request: {
      profile_id: "html-notes-researcher-v1",
      contract_version: "1.2.0",
      input: "Input that triggers malformed provider chunk.",
    },
    events: [
      {
        id: "evt-mal-001",
        run_id: "run-mal-01",
        type: "run.started",
        timestamp: "2026-09-19T11:08:00.000Z",
        data: { status: "running" },
      },
      {
        id: "evt-mal-002",
        run_id: "run-mal-01",
        type: "run.failed",
        timestamp: "2026-09-19T11:08:00.400Z",
        data: {
          error: { code: "PROVIDER_PARSE_ERROR", category: "PROVIDER", message: "Malformed JSON token in model response stream", retryable: false },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-mal-01",
      status: "failed",
      profile_id: "html-notes-researcher-v1",
      messages: [],
      error: { code: "PROVIDER_PARSE_ERROR", category: "PROVIDER", message: "Malformed JSON token in model response stream", retryable: false },
    },
  },

  "runtime-unavailable.json": {
    contract_version: "1.2.0",
    fixture_id: "runtime-unavailable",
    description: "Client connects while runtime is down or degraded; emits structured unavailable error.",
    request: {
      profile_id: "html-notes-researcher-v1",
      contract_version: "1.2.0",
      input: "Attempted request during outage.",
    },
    events: [
      {
        id: "evt-unavail-001",
        run_id: "run-unavail-01",
        type: "run.failed",
        timestamp: "2026-09-19T11:09:00.000Z",
        data: {
          error: { code: "RUNTIME_UNAVAILABLE", category: "RUNTIME", message: "Shared runtime is currently unavailable", retryable: true },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-unavail-01",
      status: "failed",
      messages: [],
      error: { code: "RUNTIME_UNAVAILABLE", category: "RUNTIME", message: "Shared runtime is currently unavailable", retryable: true },
    },
  },

  "incompatible-contract-version.json": {
    contract_version: "1.2.0",
    fixture_id: "incompatible-contract-version",
    description: "Client submits an incompatible major contract version (e.g. 2.0.0).",
    request: {
      profile_id: "html-notes-researcher-v1",
      contract_version: "2.0.0",
      input: "Query with v2 contract.",
    },
    events: [
      {
        id: "evt-inc-001",
        run_id: "run-inc-01",
        type: "run.failed",
        timestamp: "2026-09-19T11:10:00.000Z",
        data: {
          error: { code: "CONTRACT_VERSION_MISMATCH", category: "CLIENT", message: "Incompatible contract version '2.0.0'. Supported major versions: 1.x.x", retryable: false },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-inc-01",
      status: "failed",
      messages: [],
      error: { code: "CONTRACT_VERSION_MISMATCH", category: "CLIENT", message: "Incompatible contract version '2.0.0'. Supported major versions: 1.x.x", retryable: false },
    },
  },

  "duplicate-event-replay.json": {
    contract_version: "1.2.0",
    fixture_id: "duplicate-event-replay",
    description: "Client reconnects and replays cached terminal run event idempotently.",
    request: {
      profile_id: "html-notes-researcher-v1",
      contract_version: "1.2.0",
      idempotency_key: "idem-replay-key-01",
      input: "Durable idempotent query.",
    },
    events: [
      {
        id: "evt-rep-001",
        run_id: "run-rep-01",
        type: "run.completed",
        timestamp: "2026-09-19T11:11:00.000Z",
        data: { status: "completed", cached: true },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-rep-01",
      status: "completed",
      profile_id: "html-notes-researcher-v1",
      messages: [{ role: "assistant", content: "Durable result returned from cache." }],
      usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55, tool_calls_count: 0, retry_count: 0, duration_ms: 50 },
    },
  },

  "idempotency-race.json": {
    contract_version: "1.2.0",
    fixture_id: "idempotency-race",
    description: "Concurrent second request with active idempotency key receives conflict error.",
    request: {
      profile_id: "html-notes-researcher-v1",
      contract_version: "1.2.0",
      idempotency_key: "idem-concurrent-race-key",
      input: "Concurrent race query.",
    },
    events: [
      {
        id: "evt-race-001",
        run_id: "run-race-02",
        type: "run.failed",
        timestamp: "2026-09-19T11:12:00.010Z",
        data: {
          error: { code: "IDEMPOTENCY_CONFLICT", category: "CLIENT", message: "Concurrent run active under idempotency key 'idem-concurrent-race-key'", retryable: true },
        },
      },
    ],
    result: {
      contract_version: "1.2.0",
      run_id: "run-race-02",
      status: "failed",
      messages: [],
      error: { code: "IDEMPOTENCY_CONFLICT", category: "CLIENT", message: "Concurrent run active under idempotency key 'idem-concurrent-race-key'", retryable: true },
    },
  },
};

for (const [filename, content] of Object.entries(fixtures)) {
  const jsonStr = JSON.stringify(content, null, 2);
  for (const dir of targetDirs) {
    fs.writeFileSync(path.join(dir, filename), jsonStr, "utf-8");
  }
}

console.log(`Successfully generated ${Object.keys(fixtures).length} v1.2 fixtures in contracts/fixtures and docs/contracts/fixtures.`);
