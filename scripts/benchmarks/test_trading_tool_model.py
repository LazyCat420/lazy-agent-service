import asyncio
import importlib.util
from pathlib import Path
import sys

import httpx
import pytest


SOURCE = Path(__file__).with_name("trading_tool_model.py")
SPEC = importlib.util.spec_from_file_location("trading_tool_model", SOURCE)
model_bench = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = model_bench
SPEC.loader.exec_module(model_bench)


def test_defaults_preserve_paired_regression_contract(monkeypatch):
    for name in ("TOOL_MODEL_ENDPOINT", "TOOL_MODEL_CANDIDATE", "TOOL_MODEL_CURRENT_ONLY",
                 "TOOL_MODEL_REPEATS", "TOOL_MODEL_SCENARIOS"):
        monkeypatch.delenv(name, raising=False)
    args = model_bench.parse_args([])
    assert args.endpoint == model_bench.ENDPOINT
    assert args.current_only is False
    assert args.repeats == 2
    assert args.scenarios == model_bench.SCENARIOS
    assert args.candidate_output == model_bench.OUT


def test_explicit_candidates_get_separate_safe_directories(tmp_path):
    glm = model_bench.parse_args(["--candidate", "glm-current", "--output", str(tmp_path)])
    nemotron = model_bench.parse_args(["--candidate", "nemotron-current", "--output", str(tmp_path)])
    assert glm.candidate_output == tmp_path / "glm-current"
    assert nemotron.candidate_output == tmp_path / "nemotron-current"
    with pytest.raises(SystemExit):
        model_bench.parse_args(["--candidate", "../escape", "--output", str(tmp_path)])


def test_current_mode_and_scenario_repeat_parameters():
    args = model_bench.parse_args([
        "--current-only", "--repeats", "3", "--scenarios", "healthy_note", "stale_handoff"
    ])
    assert args.current_only is True
    assert args.repeats == 3
    assert args.scenarios == ["healthy_note", "stale_handoff"]


def test_discovery_accepts_one_model_and_records_provenance():
    def handler(request):
        assert request.url.path == "/v1/models"
        return httpx.Response(200, json={"data": [{"id": "runtime-model", "root": "runtime-root",
                                                   "max_model_len": 32768, "owned_by": "runtime"}]})

    async def exercise():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await model_bench.discover_model(client, "http://model-box")

    selected, evidence = asyncio.run(exercise())
    assert selected == "runtime-model"
    assert evidence["selected_model"] == "runtime-model"
    assert evidence["advertised_ids"] == ["runtime-model"]
    assert evidence["selected_metadata"] == {
        "id": "runtime-model", "root": "runtime-root", "max_model_len": 32768, "owned_by": "runtime"
    }
    assert len(evidence["response_sha256"]) == 64


@pytest.mark.parametrize("data", [[], [{"id": "one"}, {"id": "two"}]])
def test_discovery_rejects_missing_or_ambiguous_models(data):
    async def exercise():
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"data": data}))
        async with httpx.AsyncClient(transport=transport) as client:
            return await model_bench.discover_model(client, "http://model-box/v1")

    with pytest.raises(RuntimeError, match="exactly one"):
        asyncio.run(exercise())


def test_incomplete_usage_is_null_instead_of_measured_zero():
    assert model_bench._usage_fields({"prompt_tokens": 8}) == (False, 8, None, None)
    assert model_bench._usage_fields(None) == (False, None, None, None)
    assert model_bench._usage_fields({"prompt_tokens": 8, "completion_tokens": 2, "total_tokens": 10}) == (
        True, 8, 2, 10
    )


def test_manifest_uses_narrow_coverage_labels_and_hashes(tmp_path):
    args = model_bench.parse_args([
        "--candidate", "glm-current", "--generation", "generation-1", "--output", str(tmp_path),
        "--current-only"
    ])
    manifest = model_bench._manifest(args, args.candidate_output)
    assert manifest["coverage"] == ["mcp", "router", "cache", "guard"]
    assert manifest["generation"] == "generation-1"
    assert set(manifest["hashes"]) == {
        "runner_sha256", "worker_sha256", "tool_schema_sha256", "prompt_tools_sha256",
        "scenario_prompt_oracle_sha256"
    }
    assert manifest["generation_parameters"]["tool_choice"] == "auto"
    assert manifest["generation_parameters"]["chat_template_kwargs"]["enable_thinking"] is False
    assert manifest["retry_policy"] == {"model_request_retries": 0}
    assert manifest["known_gaps"] == [
        "oracle_does_not_grade_retry_or_tool_call_budget_beyond_six_turn_ceiling"
    ]
    assert len(manifest["run_order"]) == 8
    assert "TradingToolProtocol" not in str(manifest)
    assert "TradingToolStream" not in str(manifest)
