"""MQ-5 battery diagnosis and physical test-hour budgets (entirely offline)."""
from dataclasses import replace
import math

import pytest

from autophys.agent import Investigation, ProposalRunner, ToolError, render_facts
from autophys.bench import case_project, run_case, rows_json, summarize, format_table
from autophys.models import oscillator
from autophys.project import Budgets, Project
from autophys.store import config_hash
from autophys.synthetic import battery_case


@pytest.mark.parametrize("seed", range(5))
@pytest.mark.parametrize("policy", ["scripted", "fake-reasoner"])
@pytest.mark.parametrize("case", ["battery-short-only", "battery"])
def test_battery_diagnosis(case, policy, seed):
    row = run_case(case, policy, seed)
    assert row.diagnosis_correct
    assert row.status == ("inconclusive" if case.endswith("only") else "validated")
    assert row.non_identified == (["R1"] if case.endswith("only") else [])
    assert row.test_hours <= 3.0
    assert math.isfinite(row.test_rmse)
    assert row.test_hours > 0 if case == "battery" else row.test_hours == 0


def investigation(limit=3.0, runner=None):
    view, ev = battery_case()
    project = case_project(view)
    project.budgets = replace(project.budgets, max_test_hours=limit)
    return Investigation(project, view.dataset, runner or view.runner), view, ev


def test_costs_refusal_ranking_and_resume():
    inv, view, _ = investigation(1.1)
    inv.tool_optimize_parameters()
    ranking = inv.tool_rank_experiments()["ranking"]
    assert {c["experiment"] for c in ranking} == {"pulse_2A", "pulse_train"}
    assert all(c["cost_hours"] == pytest.approx(1 + 300 / 3600) for c in ranking)
    with pytest.raises(ToolError, match="test-hour budget"):
        inv.tool_request_experiment("discharge_1A")
    assert inv.test_hours_used == 0
    inv.tool_request_experiment("pulse_2A")
    assert inv.test_hours_used == pytest.approx(1 + 300 / 3600)
    assert inv.available_experiments() == []
    with pytest.raises(ToolError, match="test-hour budget"):
        inv.tool_request_experiment("pulse_train")
    restored = Investigation.resume(inv.project, inv.store, inv.id, runner=view.runner)
    assert restored.test_hours_used == inv.test_hours_used
    assert restored.facts()["budget"]["test_hours_left"] == pytest.approx(1.1 - inv.test_hours_used)


def test_two_tests_and_initial_observation_costs():
    inv, _, _ = investigation()
    inv.tool_request_experiment("pulse_2A")
    inv.tool_request_experiment("discharge_1A")
    assert inv.test_hours_used == pytest.approx(2 + 900 / 3600)
    assert Investigation.resume(inv.project, inv.store, inv.id).test_hours_used == inv.test_hours_used
    view, _ = battery_case()
    view.dataset.add(view.runner.run("pulse_train"))
    other = Investigation(case_project(view), view.dataset, view.runner)
    assert other.test_hours_used == pytest.approx(1 + 300 / 3600)


def test_attached_lab_name_cost_recomputed_from_proposal():
    inv, view, _ = investigation(runner=ProposalRunner())
    pid = inv.tool_request_experiment("pulse_2A")["proposal_id"]
    assert inv.test_hours_used == 0
    inv.approve(pid)
    obs = view.runner.run("pulse_2A")
    obs.experiment = "lab-trace-17"
    inv.attach_data(pid, obs)
    assert inv.test_hours_used == pytest.approx(1 + 300 / 3600)
    resumed = Investigation.resume(inv.project, inv.store, inv.id)
    assert resumed.test_hours_used == inv.test_hours_used


def test_optional_config_and_uncosted_facts_compatibility():
    project = Project("legacy", oscillator)
    config = project.config()
    assert "max_test_hours" not in config["budgets"]
    legacy = {**config, "budgets": {"max_steps": 24, "max_simulations": 20000, "max_experiments": 2}}
    assert project.config_version == config_hash(legacy)
    explicit = replace(project, budgets=Budgets(max_test_hours=0))
    assert explicit.config()["budgets"]["max_test_hours"] == 0
    assert explicit.config_version != project.config_version
    from autophys.synthetic import oscillator_case
    view, _ = oscillator_case()
    inv = Investigation(project, view.dataset, view.runner)
    assert "test_hours_used" not in inv.facts()["budget"]
    assert "test_hours" not in render_facts(inv.facts())
    costed, _, _ = investigation()
    assert "test_hours_used=0" in render_facts(costed.facts())


@pytest.mark.parametrize("cost", [-1, float("inf"), float("nan"), True, "1", None])
def test_invalid_catalog_cost(cost):
    view, _ = battery_case()
    project = case_project(view)
    project.catalog["pulse_2A"]["cost_hours"] = cost
    with pytest.raises(ValueError, match="cost_hours"):
        project.__post_init__()


@pytest.mark.parametrize("limit", [-1, float("inf"), float("nan"), True, "1"])
def test_invalid_test_hour_budget(limit):
    with pytest.raises(ValueError, match="max_test_hours"):
        Budgets(max_test_hours=limit)


def test_bench_hours_are_exported():
    row = run_case("battery", "scripted", 0)
    assert '"test_hours"' in rows_json([row])
    summary = summarize([row])
    assert summary[0]["test_hours"] == row.test_hours
    assert "test_hours" in format_table(summary)


def test_rust_attached_hash_version_costs_after_python_resume():
    """Rust records data_attached.measurement_version as the measurement record's hash."""
    inv, view, _ = investigation(runner=ProposalRunner())
    pid = inv.tool_request_experiment("pulse_2A")["proposal_id"]
    inv.approve(pid)
    obs = view.runner.run("pulse_2A")
    obs.experiment = "lab-trace-rust"
    m = inv.store.append(inv.id, "measurement", {"observation": obs.to_dict()})
    inv.store.append(inv.id, "proposal", {"proposal_id": pid, "event": "data_attached", "measurement_version": m.hash})
    resumed = Investigation.resume(inv.project, inv.store, inv.id)
    assert resumed.test_hours_used == pytest.approx(1 + 300 / 3600)
