"""Write the golden workbooks in tests/conformance/python/.

Each case is ``<case>.ap-workbook`` plus ``<case>.json`` with what any
implementation must read back: the format pragmas, the record count by kind,
every chain head and every projection row. Ids and timestamps are random, so
regenerating changes the bytes; the JSON always describes its own workbook.

    PYTHONPATH=src python tests/conformance_cases.py ../../tests/conformance/python
"""

from __future__ import annotations

import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

import numpy as np

from autophys.agent import Investigation, ProposalRunner, ScriptedPolicy
from autophys.project import Budgets, Project
from autophys.store import config_hash
from autophys.synthetic import NoiseModel, observe, oscillator_case, thermal_case
from autophys.workbook import APPLICATION_ID, SCHEMA_VERSION, WorkbookStore, projection_rows


def _thermal_validated(store: WorkbookStore) -> None:
    """A scripted run with a direct runner: measurements, runs, steps, one outcome."""
    view, _ = thermal_case(0, max_experiments=1)
    project = Project(name="thermal-validated", simulator=view.simulator, budgets=Budgets(max_experiments=1))
    Investigation(project, view.dataset, view.runner, policy=ScriptedPolicy(), store=store).run()


def _oscillator_edited(store: WorkbookStore) -> None:
    """A proposal with an E-1 outlook, edited within its axis, data attached, run to the end."""
    view, _ = oscillator_case(0, max_experiments=1)
    catalog = {n: {"max_runs": None} for n in view.simulator.experiments}
    catalog["sine_0.44Hz"] = {"max_runs": None, "edit": {"freq": [0.1, 2.0]}}
    project = Project(name="oscillator-edited", simulator=view.simulator, catalog=catalog, budgets=Budgets(max_experiments=1))
    inv = Investigation(project, view.dataset, ProposalRunner(), policy=ScriptedPolicy(), store=store)
    pid = inv.run().proposal_id
    settings = {**view.simulator.experiments["sine_0.44Hz"], "freq": 0.5}
    inv.approve(pid, by="reviewer", settings=settings)
    obs = observe(view.simulator, {"m": 2.0, "c": 0.8, "k": 15.0}, settings, NoiseModel({"x": 0.01}), np.random.default_rng(3))
    obs.experiment = "sine_0.44Hz"
    inv.attach_data(pid, obs)
    inv.run()


def _events_and_values(store: WorkbookStore) -> None:
    """Every proposal event and the canonical-JSON edge values, written through the raw store API."""
    cfg = {"name": "events-and-values", "params": {"a": {"lo": 0.1, "hi": 1.0}}}
    pid = store.ensure_project("events-and-values")
    ver = store.put_config_version(pid, config_hash(cfg), cfg)
    inv = store.create_investigation({"project_id": pid, "config_version": ver, "overrides": {"free": ["a"]}},
                                     record_id="conformance-inv-0")
    store.append(inv, "measurement", {"version": 1, "observation": {"t": [0.0, 1.0], "y": {"x": [0.5, None]}}})
    store.append(inv, "step", {"text": "é😀\"\\\n\u0001\u007f", "floats": [1.0, 0.1, 1e-05, 1.5e-07, 1e16, -0.0, 123.456,
                                                                         5e-324, 1.7976931348623157e308],
                               "ints": [0, -3, 18446744073709551615], "nan": float("nan"), "nested": {"b": 1, "a": [True, None]}})
    outlook = {"axes": [{"name": "freq", "values": [0.1, 1.0]}, {"name": "amp", "values": [1, 2, 3]}],
               "score": [1, 2, 3, 4, 5, 6], "after": {"a": [0.6, 0.5, 0.4, 0.3, 0.2, 0.1]}}
    base = {"kind": "sine", "freq": 0.1, "amp": 1}
    for p, events in (("p-rejected", [("rejected", {"reason": "too long"})]),
                      ("p-withdrawn", [("withdrawn", {})]),
                      ("p-approved", [("approved", {"by": "r"}), ("data_attached", {"measurement_version": 1})]),
                      ("p-edited", [("edited", {"settings": {**base, "freq": 1.0, "amp": 3}})])):
        store.append(inv, "proposal", {"proposal_id": p, "event": "proposed", "experiment": "sine", "settings": base,
                                       "outlook": outlook})
        for ev, extra in events:
            store.append(inv, "proposal", {"proposal_id": p, "event": ev, **extra})
    store.append(inv, "outcome", {"status": "inconclusive", "reasons": ["conformance"]})


def _reason_replayed(store: WorkbookStore) -> None:
    """An offline reason run pins playbook bytes, model, prices and usage."""
    from autophys.bench import case_project
    from autophys.reasoner import ModelSpec, MUSE_SPARK, reasoner_for
    from autophys.agent import ReasonLanePolicy
    from autophys.synthetic import CASES as SYNTHETIC
    cassette = Path(__file__).resolve().parents[3] / "tests/conformance/reasoner/spark-oscillator.jsonl"
    spec = ModelSpec("policy", "meta", MUSE_SPARK)
    policy = ReasonLanePolicy(reasoner_for(spec, replay=cassette), model_spec=spec)
    policy.name = "reason"
    view, _ = SYNTHETIC["oscillator"](0)
    inv = Investigation(case_project(view), view.dataset, view.runner, policy=policy, store=store)
    assert inv.run().status == "validated"
    assert all(r.payload.get("replayed") for r in store.records(inv.id, "step"))
    # Image references are format-ready; actual multimodal policy calls are M-4.
    image = store.put_blob(b"synthetic image conformance bytes", "image/png")
    store.append(inv.id, "step", {"images": [{"sha256": image, "media_type": "image/png",
                                             "caption": "Synthetic format fixture"}]})



def _thermal_curves_reveal(store: WorkbookStore) -> None:
    from autophys.bench import run_case
    run_case("thermal", "scripted", 0, store=store)


CASES = {"thermal-validated": _thermal_validated, "oscillator-edited": _oscillator_edited,
         "events-and-values": _events_and_values, "reason-replayed": _reason_replayed,
         "thermal-curves-reveal": _thermal_curves_reveal}


def expected(store: WorkbookStore) -> dict:
    kinds = Counter(r[0] for r in store._q("SELECT kind FROM records"))
    return {
        "format": {"application_id": APPLICATION_ID, "user_version": SCHEMA_VERSION},
        "project": store.project_name(),
        "records": sum(kinds.values()),
        "kinds": dict(sorted(kinds.items())),
        "heads": store.heads(),
        "projections": projection_rows(store._conn),
    }



def _write_curve_expectations(store, out):
    """Plain simulate inputs/expect rules accepted by numerics_cases.execute/compare."""
    from autophys.fit import FitResult
    from autophys.models.thermal import thermal_rc
    inv = store.investigations()[0]["id"]
    record = store.records(inv, "measurement")[0]
    run = store.records(inv, "run")[0].payload
    obs = record.payload["observation"]
    result = FitResult.from_dict({k: v for k, v in run.items() if k not in ("fit_id", "model", "simulator")})
    initial = thermal_rc.from_x(np.asarray(min(result.starts, key=lambda start: start.loss).x0))
    for label, params in (("fit", result.params), ("initial", initial)):
        case = {"format": 1, "written_by": "autophys 0.1.0 (python)", "model": "thermal", "op": "simulate",
                "inputs": {"params": {k: {"unit": p.unit, "lo": p.lo, "hi": p.hi}
                                      for k, p in thermal_rc.params.items()},
                           "theta": params, "settings": obs["settings"], "t": obs["t"],
                           "options": {"rtol": 1e-11, "atol": 1e-13}},
                "expect": {"y": {"value": run["curves"][record.id][label], "rtol": 1e-5, "atol": 1e-8}}}
        (out / f"thermal-curves-{label}.json").write_text(json.dumps(case, indent=1, sort_keys=True) + "\n")


def write(out: Path, names=None) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, build in CASES.items():
        if names is not None and name not in names:
            continue
        path = out / f"{name}.ap-workbook"
        for p in (path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")):
            p.unlink(missing_ok=True)
        with WorkbookStore(path) as store:
            build(store)
            assert store.check()["ok"]
            exp = expected(store)
            if name == "thermal-curves-reveal":
                _write_curve_expectations(store, out)
        c = sqlite3.connect(path)  # a single self-contained file in the repository
        c.execute("PRAGMA journal_mode = DELETE")
        c.execute("VACUUM")
        c.close()
        path.with_suffix(".json").write_text(json.dumps(exp, indent=1, sort_keys=True) + "\n")
        written.append(path)
    return written


if __name__ == "__main__":
    for p in write(Path(sys.argv[1]), sys.argv[2:] or None):
        print(p, p.stat().st_size)
