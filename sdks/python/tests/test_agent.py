import json
import re

import numpy as np
import pytest

import autophys as ml
from autophys.agent import DECISION_SCHEMA, Decision, DecisionError, Investigation, ProposalRunner, ReasonLanePolicy, ScriptedPolicy
from autophys.bench import heuristic_responder, overclaiming_responder
from autophys.project import Budgets, NoiseConfig, Project
from autophys.reasoner import FakeReasoner
from autophys.store import MemoryStore
from autophys.synthetic import NoiseModel, observe, oscillator_case, thermal_case


def project_for(view, **kw):
    kw.setdefault("budgets", Budgets(max_experiments=view.max_experiments))
    return Project(name=view.name, simulator=view.simulator, **kw)


def actions(store, inv):
    return [r.payload.get("decision", {}).get("action") for r in store.records(inv, "step")]


def test_scripted_free_only_is_inconclusive_with_named_combination():
    view, ev = oscillator_case(0, max_experiments=0)
    store = MemoryStore()
    out = Investigation(project_for(view), view.dataset, view.runner, policy=ScriptedPolicy(), store=store).run()
    assert out.status == "inconclusive"
    assert out.identified == [] and set(out.non_identified) == {"m", "c", "k"}
    assert out.non_identifiable_combinations == ["m^1 * c^1 * k^1"]
    assert any("not identified" in r for r in out.reasons)
    assert actions(store, out.investigation) == ["optimize_parameters", "analyze_sensitivity", "validate_predictions", "stop"]
    rel = ev.relative_errors(out.estimate)
    assert rel["c/m"] < 0.02 and rel["k/m"] < 0.02


def test_scripted_requests_resonance_and_validates():
    view, ev = oscillator_case(0, max_experiments=2)
    store = MemoryStore()
    out = Investigation(project_for(view), view.dataset, view.runner, policy=ScriptedPolicy(), store=store).run()
    assert out.status == "validated" and out.identified == ["m", "c", "k"] and out.experiments == 1
    assert actions(store, out.investigation) == [
        "optimize_parameters", "analyze_sensitivity", "rank_experiments", "request_experiment",
        "optimize_parameters", "analyze_sensitivity", "validate_predictions", "stop"]
    req = [r for r in store.records(out.investigation, "step") if r.payload["decision"]["action"] == "request_experiment"][0]
    assert req.payload["decision"]["arguments"] == {"experiment": "sine_0.44Hz"}
    assert max(ev.relative_errors(out.estimate).values()) < 0.01
    assert ev.test_rmse(view.simulator, out.estimate) < 0.012


def test_guardrail_overrides_overclaiming_reasoner():
    view, _ = oscillator_case(0, max_experiments=0)
    policy = ReasonLanePolicy(FakeReasoner(overclaiming_responder))
    out = Investigation(project_for(view), view.dataset, view.runner, policy=policy).run()
    assert out.status == "inconclusive"  # claimed validated, downgraded
    assert out.identified == [] and sorted(out.guardrail_overrides) == ["c", "k", "m"]
    assert any(r.startswith("guardrail") for r in out.reasons)


def test_fake_reasoner_policy_matches_scripted_and_sends_text_only():
    view, _ = thermal_case(0)
    fake = FakeReasoner(heuristic_responder)
    store = MemoryStore()
    out = Investigation(project_for(view), view.dataset, view.runner, policy=ReasonLanePolicy(fake), store=store).run()
    assert out.status == "validated" and out.identified == ["C", "R"]
    for call in fake.calls:
        assert call["response_schema"] == DECISION_SCHEMA
        assert call["max_tokens"] >= 1800
        assert [m["role"] for m in call["messages"]] == ["developer", "user"]
        text = call["messages"][1]["content"]
        # compact summaries, never raw arrays (each observation has 121+ samples)
        assert len(text) < 4000 and len(re.findall(r"-?\d+\.\d+", text)) < 80
    step = store.records(out.investigation, "step")[0].payload
    assert step["evidence_text"].startswith("MODEL:") and json.loads(step["raw_output"])["action"] == "optimize_parameters"


def test_invalid_decisions_fail_after_three():
    view, _ = thermal_case(0)
    bad = FakeReasoner(lambda m: '{"action": "launch_rockets"}')
    out = Investigation(project_for(view), view.dataset, view.runner, policy=ReasonLanePolicy(bad)).run()
    assert out.status == "failed" and out.steps == 3


def test_decision_validation():
    kw = {"param_names": ["a"], "catalog": ["e1"]}
    base = {"hypothesis": "h", "evidence": ["x"], "expected_information": "i"}
    assert Decision.parse({**base, "action": "request_experiment", "arguments": {"experiment": "e1"}}, **kw).action == "request_experiment"
    for args in ({"experiment": "nope"}, {"experiment": "e1", "extra": 1}):
        with pytest.raises(DecisionError):
            Decision.parse({**base, "action": "request_experiment", "arguments": args}, **kw)
    with pytest.raises(DecisionError):
        Decision.parse({**base, "action": "stop", "arguments": {"status": "validated", "identified": ["zz"]}}, **kw)
    with pytest.raises(DecisionError):
        Decision.parse({"action": "stop", "arguments": {}}, **kw)


def test_step_and_simulation_budgets():
    view, _ = thermal_case(0)
    out = Investigation(project_for(view, budgets=Budgets(max_steps=2)), view.dataset, view.runner, policy=ScriptedPolicy()).run()
    assert out.status == "budget_exhausted" and out.steps == 2
    view, _ = thermal_case(0)
    out = Investigation(project_for(view, budgets=Budgets(max_simulations=40)), view.dataset, view.runner, policy=ScriptedPolicy()).run()
    assert out.status == "budget_exhausted" and out.simulations <= 40


def test_proposal_flow_awaits_and_resumes():
    view, _ = oscillator_case(0, max_experiments=2)
    store = MemoryStore()
    inv = Investigation(project_for(view), view.dataset, ProposalRunner(), policy=ScriptedPolicy(), store=store)
    out = inv.run()
    assert out.status == "awaiting_data" and out.proposal_id
    pid = out.proposal_id
    st = store.proposal_status(inv.id, pid)
    assert st["status"] == "proposed" and st["experiment"] == "sine_0.44Hz"
    with pytest.raises(ml.agent.ToolError):
        inv.run()
    obs = observe(view.simulator, {"m": 2.0, "c": 0.8, "k": 15.0}, "sine_0.44Hz", NoiseModel({"x": 0.01}), np.random.default_rng(9))
    with pytest.raises(ml.agent.ToolError, match="approve"):
        inv.attach_data(pid, obs)
    inv.approve(pid, by="eng")
    inv.attach_data(pid, obs)
    assert [r.payload["event"] for r in store.records(inv.id, "proposal")] == ["proposed", "approved", "data_attached"]
    out2 = inv.run()
    assert out2.status == "validated" and out2.experiments == 1
    assert store.verify(inv.id)


def test_edited_proposal_is_recorded():
    view, _ = oscillator_case(0, max_experiments=1)
    store = MemoryStore()
    inv = Investigation(project_for(view), view.dataset, ProposalRunner(), policy=ScriptedPolicy(), store=store)
    pid = inv.run().proposal_id
    edited = {"kind": "sine", "amplitude": 1.0, "freq": 0.44, "duration": 10.0, "rate": 100.0}
    inv.approve(pid, settings=edited)
    st = store.proposal_status(inv.id, pid)
    assert st["status"] == "edited" and st["settings"]["amplitude"] == 1.0


def test_compare_models_adopts_sensor_bias():
    view, _ = thermal_case(0, bias=0.5)
    out = Investigation(project_for(view), view.dataset, view.runner, policy=ScriptedPolicy()).run()
    assert out.model == "sensor_bias_T"
    assert abs(out.estimate["bias_T"] - 0.5) < 0.05
    assert out.fit["chi2_per_n"] < 1.5


def test_bias_off_keeps_single_model():
    view, _ = thermal_case(0, bias=0.5)
    inv = Investigation(project_for(view, noise=NoiseConfig(bias="off")), view.dataset, view.runner, policy=ScriptedPolicy())
    assert list(inv.variants) == ["base"]


def test_free_fixed_override_recorded_and_resolves_ambiguity():
    view, ev = oscillator_case(0, max_experiments=0)
    store = MemoryStore()
    project = project_for(view, initial={"m": 2.0})
    out = Investigation(project, view.dataset, view.runner, policy=ScriptedPolicy(), store=store, free=["c", "k"]).run()
    assert out.fixed == ["m"] and out.identified == ["c", "k"] and out.estimate["m"] == 2.0
    first = store.records(out.investigation)[0]
    assert first.kind == "investigation" and first.payload["overrides"] == {"free": ["c", "k"], "fixed": {"m": 2.0}}
    assert first.payload["config_version"] == project.config_version


def test_catalog_limits():
    view, _ = oscillator_case(0, max_experiments=2)
    catalog = {n: {"max_runs": 0} for n in view.simulator.experiments}
    catalog["step_2N"] = {"max_runs": 1}
    store = MemoryStore()
    out = Investigation(project_for(view, catalog=catalog), view.dataset, view.runner, policy=ScriptedPolicy(), store=store).run()
    req = [r.payload["decision"]["arguments"] for r in store.records(out.investigation, "step")
           if r.payload["decision"]["action"] == "request_experiment"]
    assert req == [{"experiment": "step_2N"}]


def test_project_config_versions_are_content_addressed():
    view, _ = thermal_case(0)
    a = project_for(view)
    b = project_for(view)
    c = project_for(view, budgets=Budgets(max_experiments=5))
    assert a.config_version == b.config_version != c.config_version
    store = MemoryStore()
    for p in (a, b, c):
        Investigation(p, view.dataset, view.runner, policy=ScriptedPolicy(), store=store)
    [proj] = store.projects()
    assert len(store.config_versions(proj["id"])) == 2
    with pytest.raises(ValueError, match="initial"):
        project_for(view, fixed=("R",))


def test_noise_scale_estimation():
    view, _ = thermal_case(0)
    # declared sigma 4x too large: estimating the scale restores the identifiability verdict
    for o in view.dataset:
        o.sigma = {"T": 0.2}
    stds = {}
    for estimate in (False, True):
        inv = Investigation(project_for(view, noise=NoiseConfig(estimate=estimate)), view.dataset, view.runner, policy=ScriptedPolicy())
        inv.tool_optimize_parameters()
        inv.tool_analyze_sensitivity()
        stds[estimate] = inv.sens.marginal_log_std["C"]
        if estimate:
            assert 0.2 < inv.noise_scale() < 0.3
    assert stds[True] == pytest.approx(stds[False] * inv.noise_scale(), rel=1e-6)


def test_proposal_outlook_grid_value_at_proposed_settings_is_its_score():
    """E-1: a proposal carries an outlook grid the browser interpolates; at the
    proposed settings the grid holds exactly the proposal's own score."""
    view, _ = oscillator_case(0, max_experiments=1)
    catalog = {n: {"max_runs": None} for n in view.simulator.experiments}
    # freq 0.44 is off the 12-point grid (inserted); amplitude 2.0 is on it (step 0.5)
    catalog["sine_0.44Hz"] = {"max_runs": None, "edit": {"freq": [0.1, 2.0], "amplitude": [0.5, 6.0]}}
    store = MemoryStore()
    project = project_for(view, catalog=catalog)
    inv = Investigation(project, view.dataset, ProposalRunner(), policy=ScriptedPolicy(), store=store)
    out = inv.run()
    assert out.status == "awaiting_data"
    p = store.records(inv.id, "proposal")[0].payload
    assert p["experiment"] == "sine_0.44Hz" and p["criterion"] == "min_eig"
    o = p["outlook"]
    assert [a["name"] for a in o["axes"]] == ["freq", "amplitude"]
    freq, amp = (a["values"] for a in o["axes"])
    assert len(freq) == 13 and len(amp) == 12
    assert freq == sorted(freq) and freq[0] == 0.1 and freq[-1] == 2.0
    assert set(o["after"]) == {"m", "c", "k"}
    n = len(freq) * len(amp)
    assert len(o["score"]) == n and all(len(v) == n for v in o["after"].values())
    flat = freq.index(0.44) * len(amp) + amp.index(2.0)  # row-major, last axis fastest
    assert o["score"][flat] == p["score"]
    ranked = next(c for c in inv.ranking if c.experiment == "sine_0.44Hz")
    assert p["score"] == pytest.approx(ranked.min_eig, rel=1e-9)
    # the proposal resolves every parameter to better than 10 % (it later validates)
    assert all(o["after"][k][flat] < 0.1 for k in ("m", "c", "k"))
    # the grid's simulations inform the reviewer and are not charged to the budget
    step = [r.payload for r in store.records(inv.id, "step")][-1]
    assert step["result"]["outlook_simulations"] > n
    plain = Investigation(project_for(view), view.dataset, ProposalRunner(), policy=ScriptedPolicy()).run()
    assert out.simulations == plain.simulations  # same budget use as a one-point outlook




def test_proposal_outlook_without_editable_settings_is_one_point():
    view, _ = oscillator_case(0, max_experiments=1)
    store = MemoryStore()
    inv = Investigation(project_for(view), view.dataset, ProposalRunner(), policy=ScriptedPolicy(), store=store)
    inv.run()
    p = store.records(inv.id, "proposal")[0].payload
    assert p["outlook"]["axes"] == [] and p["outlook"]["score"] == [p["score"]]
    assert all(len(v) == 1 for v in p["outlook"]["after"].values())


def test_catalog_edit_limits_are_validated_and_hash_neutral():
    view, _ = oscillator_case(0)
    plain = project_for(view)
    same = project_for(view, catalog={n: {"max_runs": None} for n in view.simulator.experiments})
    assert plain.config_version == same.config_version
    edited = project_for(view, catalog={"sine_0.44Hz": {"max_runs": None, "edit": {"freq": [0.1, 2.0]}}})
    assert edited.config()["catalog"]["sine_0.44Hz"]["edit"] == {"freq": [0.1, 2.0]}
    with pytest.raises(ValueError, match="contain"):
        project_for(view, catalog={"sine_0.44Hz": {"edit": {"freq": [1.0, 2.0]}}})
    with pytest.raises(ValueError, match="numeric"):
        project_for(view, catalog={"sine_0.44Hz": {"edit": {"kind": [0, 1]}}})
    with pytest.raises(ValueError, match="at most 3"):
        project_for(view, catalog={"sine_0.44Hz": {"edit": {"freq": [0.1, 2], "amplitude": [1, 3], "duration": [5, 20], "rate": [50, 200]}}})
