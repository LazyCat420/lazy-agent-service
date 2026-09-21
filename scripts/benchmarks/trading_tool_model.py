#!/usr/bin/env python3
"""Stateful trading-tool model replay with an offline tool backend.

Defaults preserve the paired before/after regression: four scenarios and two
repeats. Use ``--current-only`` and an explicit ``--candidate`` for comparable
current-tree candidate runs. Only discovery/inference contacts the configured
model endpoint; tool calls execute through the revision's MCP handler against
the local fixture worker.

Evidence covers MCP dispatch, router execution, cache behavior, and guard
behavior. It does not claim broad protocol or streaming-stack coverage.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[2]
SUN = ROOT.parent
sys.path.insert(0, str(SUN / "trading-service/scripts/benchmarks"))
from memory_stream import complete_stream

ENDPOINT = "http://10.0.0.16:5591/vllm-shim/gold-spark"
OUT = Path(os.environ.get("TOOL_MODEL_OUTPUT", "/tmp/trading-tool-model"))
SCENARIOS = ["healthy_note", "stale_handoff", "cross_cycle_note", "transient_read_failure"]
BEFORE_ROOT = Path("/tmp/lazy-tool-benchmark-before-c35fbd7")
SCHEMA_PATH = ROOT / "tool_schemas.json"
WORKER_PATH = ROOT / "scripts/benchmarks/trading-tool-worker.mts"
SCHEMA = json.loads(SCHEMA_PATH.read_text())
TOOLS = [
    {"type": "function", "function": {key: tool[key] for key in ("name", "description", "parameters")}}
    for tool in SCHEMA if tool["name"] in ["get_market_data", "whiteboard_read", "whiteboard_write"]
]
NOTE = "LULU price 100.61; evidence verified"
RISK = "Debt ratio verified at 0.37; observation RISK-20260903-17"
SYSTEM = (
    "Complete the specified trading workflow step using the provided tools. This is an offline historical replay, "
    "with no trade execution. Treat tool results as evidence. Keep the final answer to one JSON object with keys "
    "completed (boolean), ticker (string), price (number or null), observed_note (string or null), data_gaps "
    "(array of strings). Set completed=true only when all required steps succeed; otherwise preserve the actual "
    "data gap. Do not add prose."
)
GENERATION_PARAMETERS = {
    "temperature": 0,
    "min_p": 0,
    "max_tokens": 1024,
    "tool_choice": "auto",
    "stream": True,
    "chat_template_kwargs": {"enable_thinking": False, "thinking": False},
}


def prompt(scenario: str) -> str:
    if scenario == "stale_handoff":
        return (
            "You are the Board completing a research handoff step. The Fundamental Analyst has now posted "
            "risk_flags on the current LULU whiteboard. Read that section and return its exact content as "
            "observed_note. Do not write to the board. An earlier read before the author finished may have been "
            "empty. Do not invent missing content."
        )
    if scenario == "transient_read_failure":
        return (
            "You are the Junior Analyst completing a market-data verification step for LULU. Fetch "
            "get_market_data. If a temporary provider error occurs, retry once. Report the supplied price, or an "
            "explicit data gap if both reads fail. No whiteboard write is needed."
        )
    return (
        f"You are the Junior Analyst completing the LULU cycle's required note handoff. Fetch get_market_data and "
        f"verify its price is 100.61. Then write whiteboard section market_context, author v3_junior_analyst, with "
        f"the exact content string '{NOTE}'. Finally read market_context to verify that this current cycle actually "
        "contains your note. A write acknowledgment alone is not verification. Do not mark completed unless the "
        "current board read matches. Report an explicit data gap if verification fails."
    )


def _api_url(endpoint: str, route: str) -> str:
    base = endpoint.rstrip("/")
    return base + route if base.endswith("/v1") else base + "/v1" + route


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _revision(root: Path) -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True, timeout=5
        ).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _candidate_directory(base: Path, candidate: str | None) -> Path:
    if candidate is None:
        return base
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", candidate):
        raise ValueError("candidate must contain only letters, digits, dot, underscore, or hyphen")
    return base / candidate


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def _manifest(args: argparse.Namespace, output: Path) -> dict[str, Any]:
    scenario_hashes = {}
    for scenario in args.scenarios:
        contract = {
            "scenario": scenario,
            "prompt": prompt(scenario),
            "oracle": {"ticker": "LULU", "price": 100.61, "note": NOTE, "risk": RISK},
        }
        scenario_hashes[scenario] = hashlib.sha256(json.dumps(contract, sort_keys=True).encode()).hexdigest()
    return {
        "schema_version": 2,
        "status": "starting",
        "generation": args.generation or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
        "candidate": args.candidate or "default-regression",
        "endpoint": args.endpoint.rstrip("/"),
        "current_revision_only": args.current_only,
        "repeats": args.repeats,
        "scenarios": args.scenarios,
        "output_directory": str(output),
        "coverage": ["mcp", "router", "cache", "guard"],
        "generation_parameters": GENERATION_PARAMETERS,
        "retry_policy": {"model_request_retries": 0},
        "known_gaps": ["oracle_does_not_grade_retry_or_tool_call_budget_beyond_six_turn_ceiling"],
        "run_order": _run_order(args.scenarios, args.repeats, args.current_only),
        "source_revision": _revision(ROOT),
        "hashes": {
            "runner_sha256": _sha256(Path(__file__)),
            "worker_sha256": _sha256(WORKER_PATH),
            "tool_schema_sha256": _sha256(SCHEMA_PATH),
            "prompt_tools_sha256": hashlib.sha256(
                json.dumps({"system": SYSTEM, "tools": TOOLS}, sort_keys=True).encode()
            ).hexdigest(),
            "scenario_prompt_oracle_sha256": scenario_hashes,
        },
        "model_discovery": None,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }


async def discover_model(client: httpx.AsyncClient, endpoint: str) -> tuple[str, dict[str, Any]]:
    started = time.monotonic()
    response = await client.get(_api_url(endpoint, "/models"))
    elapsed = time.monotonic() - started
    response.raise_for_status()
    payload = response.json()
    entries = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        raise RuntimeError("model discovery response has no data array")
    ids = [item.get("id") for item in entries if isinstance(item, dict) and isinstance(item.get("id"), str)]
    unique_ids = list(dict.fromkeys(model_id for model_id in ids if model_id))
    discovery = {
        "url": _api_url(endpoint, "/models"),
        "elapsed_s": elapsed,
        "advertised_ids": unique_ids,
        "response_sha256": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(),
    }
    if len(unique_ids) != 1:
        raise RuntimeError(f"model discovery must advertise exactly one unique id; received {len(unique_ids)}")
    discovery["selected_model"] = unique_ids[0]
    selected = next(item for item in entries if isinstance(item, dict) and item.get("id") == unique_ids[0])
    discovery["selected_metadata"] = {
        key: selected[key] for key in ("id", "root", "max_model_len", "owned_by") if key in selected
    }
    return unique_ids[0], discovery


def _run_order(scenarios: list[str], repeats: int, current_only: bool) -> list[dict[str, Any]]:
    order = []
    for repeat in range(repeats):
        for index, scenario in enumerate(scenarios):
            if current_only:
                arms = ["after"]
            else:
                arms = ["before", "after"] if (repeat + index) % 2 == 0 else ["after", "before"]
            order.extend({"repeat": repeat, "scenario": scenario, "arm": arm} for arm in arms)
    return order


def _usage_fields(usage: Any) -> tuple[bool, int | None, int | None, int | None]:
    if not isinstance(usage, dict):
        return False, None, None, None
    prompt_tokens = usage.get("prompt_tokens")
    completion_tokens = usage.get("completion_tokens")
    total_tokens = usage.get("total_tokens")
    complete = all(isinstance(value, int) for value in (prompt_tokens, completion_tokens, total_tokens))
    return complete, prompt_tokens if isinstance(prompt_tokens, int) else None, (
        completion_tokens if isinstance(completion_tokens, int) else None
    ), total_tokens if isinstance(total_tokens, int) else None


async def run(client: httpx.AsyncClient, model: str, scenario: str, arm: str, repeat: int, *,
              endpoint: str = ENDPOINT, output: Path = OUT, node: str | None = None,
              request_timeout: float = 300) -> dict[str, Any]:
    bench_node = node or os.environ["BENCH_NODE"]
    arm_root = ROOT if arm == "after" else BEFORE_ROOT
    env = dict(os.environ, TOOL_BENCH_ARM=arm, TOOL_BENCH_ROOT=str(arm_root))
    proc = await asyncio.create_subprocess_exec(
        bench_node, "--import", "tsx", "scripts/benchmarks/trading-tool-worker.mts",
        cwd=ROOT, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    async def _rpc(**kwargs: Any) -> dict[str, Any]:
        proc.stdin.write((json.dumps(kwargs) + "\n").encode())
        await proc.stdin.drain()
        while True:
            line = await proc.stdout.readline()
            if not line:
                raise RuntimeError("Fixture worker exited")
            if line.startswith(b"BENCH_RPC "):
                result = json.loads(line[10:])
                if "error" in result:
                    raise RuntimeError(result["error"])
                return result

    async def rpc(**kwargs: Any) -> dict[str, Any]:
        return await asyncio.wait_for(_rpc(**kwargs), timeout=15)

    row: dict[str, Any] = {
        "arm": arm, "scenario": scenario, "repeat": repeat, "model": model,
        "endpoint": endpoint.rstrip("/"), "source_revision": _revision(arm_root),
        "started_at": datetime.now(timezone.utc).isoformat(), "turns": [],
        "usage_complete": True, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
        "tool_calls": 0, "success": False, "false_completion": False, "stop": "unknown",
        "coverage": ["mcp", "router", "cache", "guard"],
    }
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt(scenario)}]
    row["input_hash"] = hashlib.sha256(json.dumps([messages, TOOLS], sort_keys=True).encode()).hexdigest()
    started = time.monotonic()
    seeded = False
    current = "cycle-v3-bench-current"
    try:
        if scenario == "stale_handoff":
            await rpc(op="call", name="whiteboard_read", args={"ticker": "LULU", "section": "risk_flags"})
            await rpc(op="state", section="risk_flags", content=RISK)
        if scenario == "transient_read_failure":
            await rpc(op="state", failNext=True)
        row["setup_state"] = await rpc(op="state")
        for turn in range(6):
            payload = {"model": model, "messages": messages, "tools": TOOLS, **GENERATION_PARAMETERS}

            def first_output(first: float, _headers: Any) -> None:
                print(json.dumps({"event": "first_delta", "arm": arm, "scenario": scenario,
                                  "repeat": repeat, "turn": turn + 1, "first_delta_s": first}), flush=True)

            turn_started = time.monotonic()
            remaining = max(1, request_timeout - (time.monotonic() - started))
            result = await asyncio.wait_for(
                complete_stream(client, _api_url(endpoint, "/chat/completions"), payload, first_output),
                timeout=remaining,
            )
            message = result["message"]
            usage = result.get("usage")
            complete, prompt_tokens, completion_tokens, total_tokens = _usage_fields(usage)
            event = {
                "turn": turn + 1, "message": message,
                "native_tool_calls": message.get("tool_calls") or [],
                "usage": usage if isinstance(usage, dict) else None,
                "elapsed_s": time.monotonic() - turn_started,
                "first_delta_s": result.get("first_delta_s"),
                "finish_reason": result.get("finish_reason"), "tool_results": [],
            }
            row["turns"].append(event)
            if not complete:
                row["usage_complete"] = False
            else:
                row["prompt_tokens"] += prompt_tokens
                row["completion_tokens"] += completion_tokens
                row["total_tokens"] += total_tokens
            messages.append(message)
            calls = event["native_tool_calls"]
            print(json.dumps({"event": "turn", "arm": arm, "scenario": scenario, "repeat": repeat,
                              "turn": turn + 1, "elapsed_s": event["elapsed_s"], "usage": event["usage"],
                              "tools": [call["function"]["name"] for call in calls]}), flush=True)
            if not calls:
                row["final_text"] = message.get("content") or ""
                row["stop"] = result.get("finish_reason")
                break
            for call in calls:
                row["tool_calls"] += 1
                name = call["function"]["name"]
                arguments = json.loads(call["function"]["arguments"])
                if scenario == "cross_cycle_note" and name == "whiteboard_write" and not seeded:
                    seeded = True
                    await rpc(op="call", name=name, args=arguments, cycle=current + "-prior")
                    row["cross_cycle_setup"] = await rpc(op="state", cycle=current)
                tool_started = time.monotonic()
                actual = await rpc(op="call", name=name, args=arguments, cycle=current)
                envelope = actual["result"]
                text = "\n".join(item.get("text", "") for item in envelope["content"])
                content = json.dumps({"error": text}) if envelope.get("isError") else text
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": content})
                event["tool_results"].append({
                    "id": call.get("id"), "name": name, "arguments": arguments, "content": content,
                    "is_error": bool(envelope.get("isError")), "backend_delta": actual["backend_delta"],
                    "elapsed_s": time.monotonic() - tool_started,
                })
            if turn == 5:
                row["stop"] = "max_turns"

        state = await rpc(op="state", cycle=current)
        row["final_state"] = state
        try:
            artifact = json.loads(row.get("final_text", ""))
        except Exception:
            artifact = None
        row["artifact"] = artifact
        fields = ["completed", "ticker", "price", "observed_note", "data_gaps"]
        row["schema_valid"] = (
            isinstance(artifact, dict) and all(key in artifact for key in fields)
            and isinstance(artifact["completed"], bool) and isinstance(artifact["ticker"], str)
            and (artifact["price"] is None or type(artifact["price"]) in (int, float))
            and (artifact["observed_note"] is None or isinstance(artifact["observed_note"], str))
            and isinstance(artifact["data_gaps"], list)
            and all(isinstance(gap, str) for gap in artifact["data_gaps"])
        )
        if row["schema_valid"]:
            actual_calls = [item for turn_row in row["turns"] for item in turn_row["tool_results"]]
            observed = []
            for call in actual_calls:
                try:
                    value = json.loads(call["content"])
                except Exception:
                    continue
                if isinstance(value, dict) and not call["is_error"]:
                    observed.append((call["name"], value))
            price_seen = any(
                name == "get_market_data" and value.get("price") == 100.61 and value.get("ticker") == "LULU"
                for name, value in observed
            )

            def note_seen(section: str, content: str) -> bool:
                return any(
                    name == "whiteboard_read" and value.get("cycle_id") == current
                    and value.get("sections", {}).get(section) == content for name, value in observed
                )

            if scenario == "stale_handoff":
                work = note_seen("risk_flags", RISK) and artifact["observed_note"] == RISK
            elif scenario == "transient_read_failure":
                work = price_seen and artifact["price"] == 100.61
            else:
                work = (
                    state["board"].get("market_context") == NOTE
                    and any(call["name"] == "whiteboard_write" for call in actual_calls)
                    and note_seen("market_context", NOTE) and price_seen and artifact["price"] == 100.61
                    and artifact["observed_note"] == NOTE
                )
            row["required_work_pass"] = work
            row["success"] = work and artifact["completed"] is True and artifact["ticker"] == "LULU"
        row["false_completion"] = bool(
            isinstance(artifact, dict) and artifact.get("completed") is True
            and not row["success"]
        )
    except Exception as exc:
        row.update(error=f"{type(exc).__name__}: {exc}", usage_complete=False, stop="error")
    finally:
        if not row["usage_complete"]:
            row["prompt_tokens"] = row["completion_tokens"] = row["total_tokens"] = None
        row["elapsed_s"] = time.monotonic() - started
        row["completed_at"] = datetime.now(timezone.utc).isoformat()
        if proc.stdin:
            proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        _write_json(output / f"{scenario}-{repeat}-{arm}.json", row)
        print(json.dumps({key: value for key, value in row.items() if key not in [
            "turns", "final_text", "artifact", "setup_state", "final_state", "cross_cycle_setup"
        ]}), flush=True)
    return row


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", default=os.environ.get("TOOL_MODEL_ENDPOINT", ENDPOINT))
    parser.add_argument("--candidate", default=os.environ.get("TOOL_MODEL_CANDIDATE"))
    parser.add_argument("--generation", default=os.environ.get("TOOL_MODEL_GENERATION"))
    parser.add_argument("--output", type=Path, default=OUT)
    parser.add_argument("--current-only", action="store_true", default=os.environ.get("TOOL_MODEL_CURRENT_ONLY") == "1")
    parser.add_argument("--repeats", type=int, default=int(os.environ.get("TOOL_MODEL_REPEATS", "2")))
    parser.add_argument("--scenarios", nargs="+", choices=SCENARIOS, default=None)
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("TOOL_MODEL_TIMEOUT", "300")))
    parser.add_argument("--node", default=os.environ.get("BENCH_NODE"))
    args = parser.parse_args(argv)
    if args.scenarios is None:
        configured = os.environ.get("TOOL_MODEL_SCENARIOS")
        args.scenarios = configured.split(",") if configured else list(SCENARIOS)
    unknown = sorted(set(args.scenarios) - set(SCENARIOS))
    if unknown:
        parser.error("unknown scenarios: " + ", ".join(unknown))
    if args.repeats < 1:
        parser.error("--repeats must be positive")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if not args.endpoint:
        parser.error("--endpoint must not be empty")
    try:
        args.candidate_output = _candidate_directory(args.output, args.candidate)
    except ValueError as exc:
        parser.error(str(exc))
    return args


async def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    output: Path = args.candidate_output
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "manifest.json"
    manifest = _manifest(args, output)
    _write_json(manifest_path, manifest)
    try:
        async with httpx.AsyncClient(timeout=args.timeout) as client:
            model, discovery = await discover_model(client, args.endpoint)
            manifest["model_discovery"] = discovery
            manifest["status"] = "running"
            _write_json(manifest_path, manifest)
            if os.environ.get("TOOL_MODEL_PREFLIGHT"):
                rows = [await run(client, model, "healthy_note", "after", -1, endpoint=args.endpoint,
                                  output=output, node=args.node, request_timeout=args.timeout)]
            else:
                rows = []
                for item in manifest["run_order"]:
                    rows.append(await run(client, model, item["scenario"], item["arm"], item["repeat"],
                                          endpoint=args.endpoint, output=output, node=args.node,
                                          request_timeout=args.timeout))
        manifest["status"] = "complete"
        manifest["completed_at"] = datetime.now(timezone.utc).isoformat()
        manifest["results"] = {
            "scheduled": len(rows), "successful": sum(bool(row["success"]) for row in rows),
            "usage_complete": sum(bool(row["usage_complete"]) for row in rows),
        }
        _write_json(manifest_path, manifest)
        return 0
    except Exception as exc:
        manifest["status"] = "setup_error"
        manifest["error"] = f"{type(exc).__name__}: {exc}"
        manifest["completed_at"] = datetime.now(timezone.utc).isoformat()
        _write_json(manifest_path, manifest)
        print(json.dumps({"event": "setup_error", "error": manifest["error"]}), file=sys.stderr, flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
