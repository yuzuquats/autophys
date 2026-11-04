"""FC-1 / GT-1 contract and noninterference tests."""
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest

from autophys.agent import Investigation, ScriptedPolicy, render_facts
from autophys.bench import case_project, run_case
from autophys.curves import RUN_BYTES, run_payload
from autophys.data import Observation
from autophys.fit import FitResult, StartResult
from autophys.http import HttpError, HttpStore
from autophys.simulator import CallBudget, simulator, TRUTH_OPTIONS
from autophys.store import MemoryStore, JsonlStore, StoreError, canonical, config_hash
from autophys.synthetic import thermal_case
from autophys.workbook import WorkbookError, WorkbookStore, payload_shape
from fake_server import FakeAutophys


def make_inv():
    view, ev = thermal_case(0, max_experiments=0)
    inv = Investigation(case_project(view), view.dataset, view.runner, policy=ScriptedPolicy(), seed=0)
    return inv, ev


def reveal_payload():
    return {"source": "synthetic", "tolerance": 0.1, "truth": {"a": 2.0}, "estimate": {"a": 2.1},
            "quantities": [{"name": "a", "truth": 2.0, "estimate": 2.1, "ratio": 1.05,
                            "sigma_ratio": None, "within": True, "identifiable": True}], "fit_id": 1}


def test_run_curves_keys_initial_budget_facts_resume(monkeypatch):
    import autophys.curves
    inv, _ = make_inv()
    used = inv.simulations
    inv.tool_optimize_parameters()
    curves = inv.records("run")[-1].payload["curves"]
    assert set(curves) == {r.id for r in inv.records("measurement")}
    assert inv.simulations == used  # direct tools have no investigation budget attached
    for record in inv.records("measurement"):
        curve = curves[record.id]
        obs = record.payload["observation"]
        assert "t" not in curve
        assert set(curve["fit"]) == set(obs["y"])
        assert len(curve["fit"]["T"]) == len(obs["t"])
        assert curve["fit"] != curve["initial"]
    restored = Investigation.resume(inv.project, inv.store, inv.id, inv.runner, policy=ScriptedPolicy())
    assert restored.fit.to_dict() == inv.fit.to_dict()
    assert restored.facts() == inv.facts()
    facts = render_facts(inv.facts())
    calls = inv.simulations
    monkeypatch.setattr(autophys.curves, "run_payload", lambda sim, result, measurements, payload: payload)
    other, _ = make_inv()
    other.tool_optimize_parameters()
    assert other.simulations == calls
    assert render_facts(other.facts()) == facts
    monkeypatch.undo()
    a, b = inv.run(), restored.run()
    assert {k: v for k, v in a.to_dict().items() if k != "wall_s"} == {
        k: v for k, v in b.to_dict().items() if k != "wall_s"}


def test_downsampling_own_grid_rounding_output_only_and_size():
    options_seen = []
    @simulator(params={"a": ("", 0.1, 10)}, outputs=["y"])
    def model(params, experiment, options=None):
        options_seen.append(options)
        t = np.asarray(experiment["t"])
        return {"t": t, "y": params["a"] * t, "input": t}
    model.budget = CallBudget(0)
    t = np.linspace(0, 3, 2101)
    obs = Observation("e", {"kind": "e", "duration": 999}, t, {"y": t}, {"y": 1})
    record = SimpleNamespace(id="measurement-id", payload={"observation": obs.to_dict()})
    result = SimpleNamespace(params={"a": 2}, starts=[StartResult([np.log(1.23456789)], 0, 1, 1, True)], seed=0)
    out = run_payload(model, result, [record], {})
    entry = out["curves"][record.id]
    idx = np.rint(np.linspace(0, 2100, 2000)).astype(int)
    assert entry["t"] == t[idx].tolist()
    assert entry["fit"]["y"] == [float(format(2*x, ".6g")) for x in t[idx]]
    assert set(entry["fit"]) == {"y"}
    assert entry["initial"]["y"][-1] == float(format(1.23456789*3, ".6g"))
    assert model.calls == model.budget.used == 0
    assert all(o == TRUTH_OPTIONS for o in options_seen)
    records = [SimpleNamespace(id=f"m{i}", payload=record.payload) for i in range(12)]
    out = run_payload(model, result, records, {"metadata": "x"*1000})
    assert len(canonical(out).encode()) <= RUN_BYTES
    assert len(out["curves"]["m0"]["t"]) < 2000
    assert len({len(c["t"]) for c in out["curves"].values()}) == 1


@pytest.mark.parametrize("which", ["memory", "jsonl", "workbook"])
def test_reveal_order_and_idempotency(which, tmp_path):
    store = {"memory": lambda: MemoryStore(), "jsonl": lambda: JsonlStore(tmp_path / "json"),
             "workbook": lambda: WorkbookStore(tmp_path / "test.ap-workbook")}[which]()
    pid = store.ensure_project("test")
    cfg = {"name": "test"}
    version = store.put_config_version(pid, config_hash(cfg), cfg)
    inv = store.create_investigation({"project_id": pid, "config_version": version})
    with pytest.raises(WorkbookError, match="requires an outcome"):
        store.append(inv, "reveal", reveal_payload())
    store.append(inv, "outcome", {"status": "inconclusive"})
    first = store.append(inv, "reveal", reveal_payload(), record_id="truth")
    assert store.append(inv, "reveal", reveal_payload(), record_id="truth") == first
    with pytest.raises(WorkbookError, match="already has a reveal"):
        store.append(inv, "reveal", reveal_payload())
    if hasattr(store, "close"):
        store.close()


def test_reveal_content_uncertainty_and_refusal():
    inv, ev = make_inv()
    inv.run()
    facts = deepcopy(inv.facts())
    record = ev.reveal(inv)
    payload = record.payload
    assert payload["truth"] == ev.truth and payload["estimate"] == inv.outcome.estimate
    assert payload["fit_id"] == inv.fit_id
    q = payload["quantities"][0]
    assert q["ratio"] == q["estimate"] / q["truth"]
    assert q["within"] == (abs(q["ratio"] - 1) <= 0.1)
    assert q["identifiable"]
    report = inv.sens
    variance = sum((d.vector["C"] / d.singular_value)**2 for d in report.directions)
    assert q["sigma_ratio"] == pytest.approx(abs(q["ratio"]) * np.sqrt(variance))
    assert inv.records()[-2].kind == "outcome"
    assert inv.facts() == facts
    for call in [inv.run, lambda: inv.approve("p"), lambda: inv.attach_data("p", next(iter(inv.dataset))),
                 lambda: Investigation.resume(inv.project, inv.store, inv.id)]:
        with pytest.raises(StoreError, match="reveal"):
            call()


def test_reveal_missing_analysis_and_bench():
    inv, ev = make_inv()
    inv.run()
    inv.sens_fit = -1
    assert all(q["sigma_ratio"] is None for q in ev.reveal(inv).payload["quantities"])
    store = MemoryStore()
    row = run_case("thermal-short-only", "scripted", 0, store=store)
    assert row.simulations == 151  # seed 0; five-seed aggregate is 133
    assert len([r for i in store.investigations() for r in store.records(i["id"], "reveal")]) == 1


def test_http_reveal_and_old_daemon(monkeypatch):
    with FakeAutophys() as fake:
        store = HttpStore(fake.url, fake.issue_key())
        pid = store.ensure_project("test")
        cfg = {"name": "test"}
        version = store.put_config_version(pid, config_hash(cfg), cfg)
        inv = store.create_investigation({"project_id": pid, "config_version": version})
        with pytest.raises(HttpError) as e:
            store.append(inv, "reveal", reveal_payload())
        assert e.value.status == 409
        store.append(inv, "outcome", {"status": "inconclusive"})
        record = store.append(inv, "reveal", reveal_payload(), record_id="reveal-http")
        assert store.append(inv, "reveal", reveal_payload(), record_id="reveal-http") == record
        with pytest.raises(HttpError) as e:
            store.append(inv, "reveal", reveal_payload())
        assert e.value.status == 409
    for status in (404, 405):
        old = HttpStore("http://unused", "fake")
        def missing(*args, **kwargs):
            raise HttpError(status, "unsupported")
        monkeypatch.setattr(old, "_req", missing)
        with pytest.warns(RuntimeWarning, match="does not support reveal") as warnings:
            assert old.append("inv", "reveal", reveal_payload()) is None
            assert old.append("inv", "reveal", reveal_payload()) is None
        assert len(warnings) == 1
    def denied(*args, **kwargs):
        raise HttpError(403, "denied")
    monkeypatch.setattr(old, "_req", denied)
    with pytest.raises(HttpError):
        old.append("inv", "reveal", reveal_payload())


@pytest.mark.parametrize("curves", [
    [], {"m": []}, {"m": {"fit": [], "initial": {}}},
    {"m": {"fit": {}, "initial": []}},
    {"m": {"fit": {"y": "bad"}, "initial": {}}},
    {"m": {"fit": {"y": [True]}, "initial": {}}},
    {"m": {"fit": {"y": [float("inf")]}, "initial": {}}},
    {"m": {"fit": {"y": [1]}, "initial": {"y": [1, 2]}}},
    {"m": {"fit": {"y": [1]}, "initial": {"y": [2]}, "t": [0, 1]}},
    {"m": {"fit": {}, "initial": {}, "t": [None]}},
])
def test_invalid_curves(curves):
    with pytest.raises(WorkbookError):
        payload_shape("run", {"curves": curves})


@pytest.mark.parametrize("path,value", [
    (("source",), 3), (("tolerance",), True), (("tolerance",), float("inf")),
    (("truth",), []), (("estimate",), []), (("truth", "a"), None),
    (("estimate", "a"), float("nan")), (("quantities",), {}),
    (("fit_id",), True), (("fit_id",), 1.5), (("quantities", 0), []),
    (("quantities", 0, "name"), 1), (("quantities", 0, "truth"), None),
    (("quantities", 0, "estimate"), True), (("quantities", 0, "ratio"), float("inf")),
    (("quantities", 0, "sigma_ratio"), False), (("quantities", 0, "within"), 1),
    (("quantities", 0, "identifiable"), "yes"),
])
def test_invalid_reveal(path, value):
    payload = reveal_payload()
    obj = payload
    for key in path[:-1]:
        obj = obj[key]
    obj[path[-1]] = value
    with pytest.raises(WorkbookError):
        payload_shape("reveal", payload)


def test_reveal_exact_fields_and_optional_run():
    payload_shape("run", {})
    payload_shape("run", {"curves": {}})
    payload = reveal_payload()
    payload_shape("reveal", payload)
    payload["extra"] = 1
    with pytest.raises(WorkbookError):
        payload_shape("reveal", payload)
    del payload["extra"], payload["fit_id"]
    with pytest.raises(WorkbookError):
        payload_shape("reveal", payload)


@pytest.mark.parametrize("label", ["fit", "initial"])
def test_curve_numerics_expectations(label):
    import json
    from pathlib import Path
    from numerics_cases import execute, compare, plain
    case = json.loads((Path(__file__).resolve().parents[3] /
                       f"tests/conformance/python/thermal-curves-{label}.json").read_text())
    compare(plain(execute(case)["y"]), case["expect"]["y"])


@pytest.mark.parametrize("which", ["memory", "jsonl", "workbook"])
def test_reveal_batch_order_and_rollback(which, tmp_path):
    store = {"memory": lambda: MemoryStore(), "jsonl": lambda: JsonlStore(tmp_path / "json"),
             "workbook": lambda: WorkbookStore(tmp_path / "batch.ap-workbook")}[which]()
    pid = store.ensure_project("test")
    cfg = {"name": "test"}
    version = store.put_config_version(pid, config_hash(cfg), cfg)
    inv = store.create_investigation({"project_id": pid, "config_version": version})
    with pytest.raises(WorkbookError):
        store.append_batch(inv, [("reveal", reveal_payload()), ("outcome", {"status": "done"})])
    assert len(store.records(inv)) == 1
    records = store.append_batch(inv, [("outcome", {"status": "done"}), ("reveal", reveal_payload())])
    assert [r.kind for r in records] == ["outcome", "reveal"]
    if hasattr(store, "close"):
        store.close()


def test_combination_sigma_ratio_and_structural_null():
    from autophys.synthetic import Evaluator
    inv, _ = make_inv()
    inv.run()
    ev = Evaluator("combos", {"C": 500.0, "R": 2.0}, [],
                   {"C/R": {"C": 1, "R": -1}, "C": {"C": 1}}, {"C/R"})
    ev.truth["C"] = 250.0  # deliberately outside tolerance
    inv.variants = deepcopy(inv.variants)
    from autophys.simulator import ParamSpec
    inv.sim.params["bias_T"] = ParamSpec("bias_T", "", -1, 1)
    inv.outcome.estimate["bias_T"] = 0.0
    report = inv.sens
    report.params.append("bias_T")
    # Isolate an exactly cancelled structural direction for the ratio.
    from autophys.sensitivity import Direction
    report.directions = [Direction(0, float("inf"), {"C": 1, "R": 1, "bias_T": 0}, "structural", "C R"),
                         Direction(10, 0.1, {"C": 1, "R": -1, "bias_T": 0}, "identifiable", "C/R")]
    quantities = ev.reveal(inv).payload["quantities"]
    ratio, marginal = quantities
    assert ratio["sigma_ratio"] == pytest.approx(abs(ratio["ratio"]) * 0.2)
    assert not ratio["identifiable"]
    assert not ratio["within"]
    assert marginal["sigma_ratio"] is None
