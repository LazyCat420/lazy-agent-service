import importlib.util
from pathlib import Path
import sys


SOURCE = Path(__file__).with_name("analyze_trading_tool_replay.py")
SPEC = importlib.util.spec_from_file_location("analyze_trading_tool_replay", SOURCE)
analyzer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = analyzer
SPEC.loader.exec_module(analyzer)


def call(name, arguments, content, *, error=False):
    import json
    return {"name": name, "arguments": arguments, "content": json.dumps(content),
            "is_error": error, "backend_delta": 1}


def base(scenario, calls, artifact, *, strict=False, schema=True, cross=None):
    row = {"scenario": scenario, "model": "fixture-model", "repeat": 0, "arm": "after",
           "success": strict, "false_completion": not strict, "schema_valid": schema,
           "artifact": artifact, "turns": [{"tool_results": calls}]}
    if cross is not None:
        row["cross_cycle_setup"] = cross
    return row


def market():
    return call("get_market_data", {"ticker": "LULU"}, {"ticker": "LULU", "price": 100.61})


def write():
    return call("whiteboard_write", {"author": "v3_junior_analyst", "content": analyzer.NOTE,
                "section": "market_context", "ticker": "LULU"},
                {"success": True, "cycle_id": analyzer.CURRENT_CYCLE, "section": "market_context"})


def read(section="market_context", content=analyzer.NOTE):
    return call("whiteboard_read", {"ticker": "LULU", "section": section},
                {"ticker": "LULU", "cycle_id": analyzer.CURRENT_CYCLE,
                 "sections": {section: content}})


def artifact(note=analyzer.NOTE, price=100.61, completed=True):
    return {"completed": completed, "ticker": "LULU", "price": price,
            "observed_note": note, "data_gaps": []}


def test_grounded_narrative_preserves_strict_failure_without_false_claim():
    narrative = "Fetched price, wrote the exact note, and verified the current-cycle read."
    row = base("healthy_note", [market(), write(), read()], artifact(note=narrative), strict=False)
    result = analyzer.analyze_row(row)
    assert result["original_strict_success"] is False
    assert result["exact_artifact_match"] is False
    assert result["evidence_completed"] is True
    assert result["false_completion_claim"] is False


def test_healthy_requires_market_write_and_current_cycle_read():
    assert analyzer.evidence_completed(base("healthy_note", [market(), write(), read()], artifact()))
    wrong_cycle = call("whiteboard_read", {}, {"cycle_id": "prior", "sections": {"market_context": analyzer.NOTE}})
    assert not analyzer.evidence_completed(base("healthy_note", [market(), write(), wrong_cycle], artifact()))


def test_healthy_rejects_correct_calls_in_the_wrong_order():
    assert not analyzer.evidence_completed(
        base("healthy_note", [write(), market(), read()], artifact())
    )


def test_stale_handoff_requires_exact_current_risk_read():
    row = base("stale_handoff", [read("risk_flags", analyzer.RISK)],
               artifact(note=analyzer.RISK, price=None), strict=True)
    result = analyzer.analyze_row(row)
    assert result["original_strict_success"] is True
    assert result["exact_artifact_match"] is True
    assert result["evidence_completed"] is True


def test_transient_recovery_requires_failure_then_success():
    failed = call("get_market_data", {"ticker": "LULU"}, {"error": "temporary"}, error=True)
    row = base("transient_read_failure", [failed, market()], artifact(note="recovered"), strict=True)
    assert analyzer.evidence_completed(row)
    assert not analyzer.evidence_completed(base("transient_read_failure", [market()], artifact()))


def test_cross_cycle_requires_empty_current_board_before_current_evidence():
    calls = [market(), write(), read()]
    good = base("cross_cycle_note", calls, artifact(), cross={"board": {}})
    contaminated = base("cross_cycle_note", calls, artifact(), cross={"board": {"market_context": analyzer.NOTE}})
    assert analyzer.evidence_completed(good)
    assert not analyzer.evidence_completed(contaminated)


def test_completed_claim_without_backend_evidence_is_the_only_false_claim():
    claimed = analyzer.analyze_row(base("healthy_note", [], artifact(), strict=False))
    declined = analyzer.analyze_row(base("healthy_note", [], artifact(completed=False), strict=False))
    assert claimed["false_completion_claim"] is True
    assert declined["false_completion_claim"] is False


def test_matrix_keeps_strict_artifact_evidence_and_false_claim_separate():
    grounded = analyzer.analyze_row(base("healthy_note", [market(), write(), read()],
                                         artifact(note="grounded narrative"), strict=False))
    exact = analyzer.analyze_row(base("healthy_note", [market(), write(), read()], artifact(), strict=True))
    summary = analyzer.matrix([grounded, exact])[0]
    assert summary == {"model": "fixture-model", "scenario": "healthy_note", "n": 2,
                       "original_strict_success": 1, "exact_artifact_match": 1,
                       "evidence_completed": 2, "false_completion_claim": 0}


def test_report_labels_under_specified_artifact_limit(tmp_path, capsys):
    path = tmp_path / "healthy_note-0-after.json"
    import json
    path.write_text(json.dumps(base("healthy_note", [market(), write(), read()],
                                    artifact(note="grounded narrative"), strict=False)))
    assert analyzer.main([str(path)]) == 0
    report = json.loads(capsys.readouterr().out)
    assert "did not explicitly require" in report["interpretation_limits"][0]
    assert "does not establish a production winner" in report["interpretation_limits"][1]
