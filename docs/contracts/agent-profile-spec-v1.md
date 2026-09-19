# Agent Profile Specification (v1.0.0)

> **Document ID:** `agent-profile-spec-v1`  
> **Status:** Canonical Platform Standard  
> **Owner:** Dev 1 (Runtime & Contracts Workstream)  
> **Target Service:** `lazy-agent-service`  
> **Consumers:** `trading-service`, `HTML-Notes`, deploy-kit  

---

## 1. Purpose & Design Principles

An **Agent Profile** is a declarative, version-controlled manifest that defines an agent's static configuration, behavioral boundaries, safety policies, and resource ceilings.

### Core Principles
1. **Immutable Configuration vs. Dynamic Run Input**:  
   System prompts, security whitelists, model tiers, and budget ceilings belong to the **Profile**. Task inputs, conversation history, and ephemeral context belong to the **RunRequest**. A run request can never escalate permissions or exceed profile ceilings.
2. **Declarative Deployment**:  
   Deploying or altering an agent does not require recompiling or re-architecting the runtime loop. Applications supply an `AgentProfile` manifest; `lazy-agent-service` enforces it uniformly.
3. **Domain Isolation**:  
   Domain policies (e.g. trading financial invariants or HTML canvas schemas) are declared as profile constraints and verifiers, not embedded into shared runtime code.

---

## 2. Schema Specification

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "AgentProfileV1",
  "type": "object",
  "required": [
    "profile_id",
    "version",
    "role",
    "system_prompt",
    "model_constraints",
    "tool_policy",
    "budget_limits",
    "retention_class"
  ],
  "properties": {
    "profile_id": {
      "type": "string",
      "pattern": "^[a-z0-9-]+$"
    },
    "version": {
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+$"
    },
    "role": {
      "type": "string",
      "description": "Functional agent role (e.g., 'financial-analyst', 'canvas-researcher')"
    },
    "description": {
      "type": "string"
    },
    "system_prompt": {
      "type": "string",
      "description": "Canonical Layer 0 system instructions and persona."
    },
    "model_constraints": {
      "type": "object",
      "required": ["default_model", "allowed_models", "allowed_providers"],
      "properties": {
        "default_model": { "type": "string" },
        "allowed_models": { "type": "array", "items": { "type": "string" } },
        "allowed_providers": { "type": "array", "items": { "type": "string" } },
        "temperature_range": {
          "type": "array",
          "items": { "type": "number" },
          "minItems": 2,
          "maxItems": 2
        }
      }
    },
    "tool_policy": {
      "type": "object",
      "required": ["mode", "whitelist"],
      "properties": {
        "mode": { "type": "string", "enum": ["STRICT_WHITELIST", "DENYLIST"] },
        "whitelist": { "type": "array", "items": { "type": "string" } },
        "denylist": { "type": "array", "items": { "type": "string" } },
        "require_signed_capability": { "type": "boolean" }
      }
    },
    "budget_limits": {
      "type": "object",
      "required": ["max_tokens", "max_tool_calls", "max_duration_ms"],
      "properties": {
        "max_tokens": { "type": "integer", "maximum": 32768 },
        "max_tool_calls": { "type": "integer", "maximum": 50 },
        "max_retries": { "type": "integer", "maximum": 5 },
        "max_duration_ms": { "type": "integer", "maximum": 300000 },
        "max_concurrent_workers": { "type": "integer", "maximum": 10 }
      }
    },
    "plugins": {
      "type": "object",
      "properties": {
        "context_contributors": { "type": "array", "items": { "type": "string" } },
        "verifiers": { "type": "array", "items": { "type": "string" } },
        "worker_plugins": { "type": "array", "items": { "type": "string" } }
      }
    },
    "retention_class": {
      "type": "string",
      "enum": ["EPHEMERAL", "AUDITED_SESSION", "PERMANENT_RECORD"]
    },
    "observability_policy": {
      "type": "object",
      "properties": {
        "telemetry_level": { "type": "string", "enum": ["OFF", "METRICS_ONLY", "FULL_SPANS"] },
        "redact_keys": { "type": "array", "items": { "type": "string" } },
        "sample_rate": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    }
  }
}
```

---

## 3. Concrete Profile Definitions

### 3.1 Trading Junior Analyst Profile (`trading-analyst-v1`)

```json
{
  "profile_id": "trading-analyst-v1",
  "version": "1.0.0",
  "role": "junior-financial-analyst",
  "description": "Autonomous fundamental and balance sheet valuation analyst for trading cycle.",
  "system_prompt": "You are a quantitative and fundamental financial analyst. Reason strictly using verified data. Adhere to conservative valuation baselines and cite evidence for every numerical claim.",
  "model_constraints": {
    "default_model": "qwen-coder-32b",
    "allowed_models": ["qwen-coder-32b", "deepseek-coder-v2-lite"],
    "allowed_providers": ["vllm-shim", "lmstudio"],
    "temperature_range": [0.0, 0.4]
  },
  "tool_policy": {
    "mode": "STRICT_WHITELIST",
    "whitelist": [
      "mcp__lazy-tool-service__fetch_financial_statement",
      "mcp__lazy-tool-service__get_price_history",
      "mcp__lazy-tool-service__calculate_liquidity_ratios"
    ],
    "require_signed_capability": true
  },
  "budget_limits": {
    "max_tokens": 8192,
    "max_tool_calls": 8,
    "max_retries": 2,
    "max_duration_ms": 60000,
    "max_concurrent_workers": 1
  },
  "plugins": {
    "context_contributors": ["financial-dossier-contributor"],
    "verifiers": ["arithmetic-audit-verifier", "market-cutoff-verifier"]
  },
  "retention_class": "PERMANENT_RECORD",
  "observability_policy": {
    "telemetry_level": "FULL_SPANS",
    "redact_keys": ["api_key", "secret", "private_token"],
    "sample_rate": 1.0
  }
}
```

### 3.2 HTML-Notes Research Coordinator Profile (`html-notes-researcher-v1`)

```json
{
  "profile_id": "html-notes-researcher-v1",
  "version": "1.0.0",
  "role": "canvas-research-coordinator",
  "description": "Coordinates multi-source topic research, source verification, and widget synthesis.",
  "system_prompt": "You are a research synthesis agent. Decompose complex user topics into targeted inquiries, verify source provenance, and generate structured canvas note representations.",
  "model_constraints": {
    "default_model": "llama-3-8b",
    "allowed_models": ["llama-3-8b", "qwen-coder-32b"],
    "allowed_providers": ["vllm-shim", "ollama"],
    "temperature_range": [0.1, 0.7]
  },
  "tool_policy": {
    "mode": "STRICT_WHITELIST",
    "whitelist": [
      "mcp__lazy-tool-service__news_search",
      "mcp__lazy-tool-service__web_scrape",
      "mcp__lazy-tool-service__canvas_add_widget"
    ],
    "require_signed_capability": false
  },
  "budget_limits": {
    "max_tokens": 12288,
    "max_tool_calls": 15,
    "max_retries": 3,
    "max_duration_ms": 120000,
    "max_concurrent_workers": 4
  },
  "plugins": {
    "context_contributors": ["canvas-active-widget-contributor"],
    "verifiers": ["provenance-source-verifier"],
    "worker_plugins": ["news-worker", "peer-sector-worker", "price-worker"]
  },
  "retention_class": "AUDITED_SESSION",
  "observability_policy": {
    "telemetry_level": "FULL_SPANS",
    "redact_keys": ["user_credentials", "session_token"],
    "sample_rate": 1.0
  }
}
```

---

## 4. Profile Lifecycle & Registry Resolution

1. **Bootstrapping**:
   - `lazy-agent-service` loads profile manifests from `profiles/*.json` at startup.
   - Profiles are validated against the `AgentProfileV1` schema before insertion into `ProfileRegistry`.
2. **Dynamic Overrides Rules**:
   - Callers can provide `runtime_overrides` in `CreateRunRequest`.
   - The runtime strictly bounds overrides against profile limits:
     - `requested_budget.max_tokens <= profile.budget_limits.max_tokens`
     - `requested_model in profile.model_constraints.allowed_models`
     - Overrides violating profile constraints are rejected with HTTP 400 `INVALID_RUN_REQUEST`.
