"""Write shared numeric goldens: PYTHONPATH=src python tests/numerics_cases.py.

Run from sdks/python with PYTHONDONTWRITEBYTECODE=1. Observations are sampled
only by build_cases; execute consumes the explicit stored arrays.
"""
import copy
import json
from dataclasses import asdict
from pathlib import Path

import numpy as np

from autophys.agent import Investigation, ScriptedPolicy
from autophys.data import Dataset, Observation
from autophys.design import outlook, rank_experiments
from autophys.fit import fit
from autophys.models.thermal import thermal_rc
from autophys.models.oscillator import oscillator
from autophys.models.battery import battery_ecm
from autophys.project import Budgets, NoiseConfig, Project, StopRules
from autophys.sensitivity import IdentifiabilityRule, analyze
from autophys.simulator import FIT_OPTIONS, TRUTH_OPTIONS, ParamSpec, SimOptions

ROOT = Path(__file__).resolve().parents[3] / "tests/conformance/numerics"
MODELS = {"thermal": thermal_rc, "oscillator": oscillator, "battery": battery_ecm}


def simulator_for(case):
    sim = copy.deepcopy(MODELS[case["model"]])
    i = case["inputs"]
    sim.params = {k: ParamSpec(k, s.get("unit", ""), s["lo"], s["hi"]) for k, s in i["params"].items()}
    fixed = {k: v for k, v in i.get("fixed", {}).items() if k in sim.params}
    if fixed:
        sim = sim.with_fixed(**fixed)
    for s in sim.experiments.values():
        s.update({k: v for k, v in i.get("fixed", {}).items() if k not in i["params"]})
    if "catalog" in i:
        sim.experiments = copy.deepcopy(i["catalog"])
    return sim


def execute(case):
    """Recompute from explicit JSON inputs without consulting expected values."""
    sim = simulator_for(case)
    i, op = case["inputs"], case["op"]
    obs = [Observation.from_dict(o) for o in i.get("observations", [])]
    theta = i.get("theta", {})
    noise = i.get("noise", Dataset(obs).noise())
    options = SimOptions(**i["options"])
    if op == "simulate":
        settings = copy.deepcopy(i.get("settings", sim.experiments.get(i.get("experiment"))))
        settings["t"] = i["t"]
        y = sim(theta, settings, options=options)
        return {"trajectory": y, "y": {k: v for k, v in y.items() if k != "t"}}
    if op == "fit":
        # Python takes one explicit initial; disable its random start sampler.
        fits = [fit(sim, obs, initial=start, n_starts=0, loss=i["loss"],
                    f_scale=i["f_scale"], options=options) for start in i["starts"]]
        return min(fits, key=lambda f: f.loss).to_dict()
    if op == "analyze":
        report, jac = analyze(sim, theta, obs, rule=IdentifiabilityRule(**i["rule"]))
        return {**report.to_dict(), "jacobian": jac}
    if op == "rank":
        ranking = rank_experiments(sim, theta, obs, noise, candidates=i["candidates"], criterion=i["criterion"])
        return {"order": [c.experiment for c in ranking]}
    if op == "outlook":
        edit = {a["name"]: [a["values"][0], a["values"][-1]] for a in i["axes"]}
        grid, _, _ = outlook(sim, theta, obs, noise, i["settings"], edit,
                             criterion=i["criterion"], points=2,
                             max_simulations=50000, at="fit", jacobian_scale=1.0)
        assert grid["axes"] == i["axes"]
        return {"grid": grid}
    if op == "run":
        ds = Dataset(Observation.from_dict(o) for o in i["dataset"])
        stop = {**i["stop"], "rule": IdentifiabilityRule(**i["stop"]["rule"])}
        project = Project("numerics", sim, initial=i["initial"], noise=NoiseConfig(bias="off"),
                          budgets=Budgets(**i["budgets"]), stop=StopRules(**stop))
        queued = iter(i["runner"].get("observations", []))

        def runner(name, settings):
            if "observations" in i["runner"]:
                return Observation.from_dict(next(queued))
            y = sim(i["runner"]["theta"], settings, options=TRUTH_OPTIONS)
            return Observation(name, settings, y.pop("t"), y, ds.noise())

        class DeterministicRunner:
            def run(self, name):
                return runner(name, sim.experiment(name))

        inv = Investigation(project, ds, DeterministicRunner(), policy=ScriptedPolicy(), seed=0)
        out = inv.run()
        decisions = [r.payload["decision"] for r in inv.records("step") if "decision" in r.payload]
        return {"status": out.status, "decisions": decisions, "actions": [d["action"] for d in decisions]}
    raise ValueError(op)


def plain(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


def field(result, path):
    for key in path.split("."):
        result = result[int(key)] if isinstance(result, list) else result[key]
    return plain(result)


def compare(actual, rule):
    """Rust rules: partial maps, ordered arrays, elementwise tolerances."""
    expected = rule["value"]
    if rule.get("set"):
        assert {json.dumps(v, sort_keys=True) for v in actual} == {json.dumps(v, sort_keys=True) for v in expected}
    elif rule.get("exact"):
        assert actual == expected
    else:
        def numeric(a, e, sign=1):
            if isinstance(e, dict):
                return isinstance(a, dict) and all(numeric(a[k], v, sign) for k, v in e.items())
            if isinstance(e, list):
                return isinstance(a, list) and len(a) == len(e) and all(numeric(x, y, sign) for x, y in zip(a, e))
            if isinstance(e, (float, int)) and not isinstance(e, bool):
                return abs(sign * a - e) <= rule.get("atol", 0) + rule.get("rtol", 0) * abs(e)
            return a == e
        assert numeric(actual, expected) or (rule.get("up_to_sign") and numeric(actual, expected, -1)), (actual, rule)


def op_cases(model, sim, base, name, settings, t, catalog, axis, values, ops, suffix):
    """One case per op from a shared base input."""
    for op in ops:
        i = copy.deepcopy(base)
        i.update(experiment=name, settings=copy.deepcopy(settings), t=t.tolist())
        if op == "fit":
            i.update(starts=[{k: v * 1.1 for k, v in base["theta"].items()}], loss="linear", f_scale=1.)
        if op == "analyze":
            i["rule"] = asdict(IdentifiabilityRule())
        if op in ("rank", "outlook"):
            i["criterion"] = "min_eig"
        if op == "rank":
            i["candidates"] = list(catalog)
        if op == "outlook":
            i["axes"] = [{"name": axis, "values": [values[0], settings[axis], values[1]]}]
        c = {"format": 1, "written_by": "autophys 0.1.0 (python)", "model": model, "op": op, "inputs": i}
        result = plain(execute(c))
        rules = {}

        def add(key, **rule):
            rules[key] = {"value": field(result, key), **rule}
        if op == "simulate":
            add("trajectory", rtol=1e-6, atol=1e-9)
        elif op == "fit":
            for key in ("params", "loss", "chi2_per_n"):
                add(key, rtol=1e-5, atol=1e-8)
            for key in ("at_bounds", "success"):
                add(key, exact=True)
        elif op == "analyze":
            for key in ("identified", "non_identified"):
                add(key, set=True)
            add("singular_values", rtol=1e-5, atol=1e-7)
            add("jacobian", rtol=1e-5, atol=1e-6)
            for j in range(len(sim.params)):
                add(f"directions.{j}.vector", up_to_sign=True, rtol=1e-5, atol=1e-7)
        elif op == "rank":
            add("order", exact=True)
        else:
            add("grid.axes", exact=True)
            add("grid.score", rtol=1e-5, atol=1e-7)
            add("grid.after", rtol=1e-5, atol=1e-7)
        c["expect"] = rules
        yield f"{model}/{op}-{suffix}.json", c


def build_cases():
    rng = np.random.default_rng(20261104)
    configs = {
        "thermal": ({"C": 500., "R": 2.}, "step_short", {"kind": "step", "power": 10., "duration": 1200., "rate": .025}, "power", [5., 15.], .05),
        "oscillator": ({"m": 2., "c": .8, "k": 15.}, "step_2N", {"kind": "step", "amplitude": 2., "duration": 6., "rate": 10.}, "amplitude", [1., 3.], .001),
        "battery": ({"R0": .04, "R1": .025, "C1": 2000.}, "discharge_1A", {"kind": "constant", "current": 1., "duration": 200., "rate": .2, "capacity_ah": 2.5, "soc0": .9}, "current", [.5, 1.5], .001),
    }
    for model, (theta, name, settings, axis, values, sigma) in configs.items():
        sim = copy.deepcopy(MODELS[model])
        catalog = {name: settings, "strong": {**settings, axis: values[-1]}}
        sim.experiments = copy.deepcopy(catalog)
        y = sim(theta, settings, options=TRUTH_OPTIONS)
        t = y.pop("t")
        measured = {ch: v + rng.normal(0., sigma, len(v)) for ch, v in y.items()}
        observation = Observation(name, settings, t, measured, {ch: sigma for ch in y}).to_dict()
        base = {"params": {k: {"unit": s.unit, "lo": s.lo, "hi": s.hi} for k, s in sim.params.items()},
                "fixed": {}, "catalog": catalog, "options": asdict(FIT_OPTIONS), "theta": theta,
                "observations": [observation], "noise": {ch: sigma for ch in y}}
        yield from op_cases(model, sim, base, name, settings, t, catalog, axis, values,
                            ("simulate", "fit", "analyze", "rank", "outlook"), "compact")
        if model in ("thermal", "oscillator"):
            i = copy.deepcopy(base)
            i.update(dataset=[observation, {**copy.deepcopy(observation), "split": "validation"}],
                     initial=theta, budgets={k: v for k, v in asdict(Budgets(max_experiments=1)).items() if k != "max_test_hours"},
                     stop={"validation_threshold": 2., "misfit_threshold": 2., "rule": asdict(IdentifiabilityRule())},
                     runner={"theta": theta})
            c = {"format": 1, "written_by": "autophys 0.1.0 (python)", "model": model, "op": "run", "inputs": i}
            result = execute(c)
            # Rust replays the Python ScriptedPolicy transcript with SequencePolicy.
            # Evidence prose embeds solver-dependent numbers, so compare semantics.
            i["script"] = result["decisions"]
            c["expect"] = {k: {"value": result[k], "exact": True} for k in ("status", "actions")}
            for j, decision in enumerate(result["decisions"]):
                for key in ("action", "arguments"):
                    c["expect"][f"decisions.{j}.{key}"] = {"value": decision[key], "exact": True}
            yield f"{model}/run-scripted.json", c
            # The same run, but the reader drives its own ScriptedPolicy
            # ("policy") instead of replaying a script; Rust phase 3.
            p = {k: copy.deepcopy(v) for k, v in c.items() if k != "inputs"}
            p["policy"] = "scripted"
            p["inputs"] = {k: copy.deepcopy(v) for k, v in i.items() if k != "script"}
            yield f"{model}/run-policy.json", p


def degenerate_cases():
    """Thermal with a 120 s step against a 1000 s time constant: R is not identified."""
    rng = np.random.default_rng(20261105)
    theta, sigma = {"C": 500., "R": 2.}, .05
    name, settings = "step_120s", {"kind": "step", "power": 10., "duration": 120., "rate": .25}
    catalog = {name: settings, "long": {**settings, "duration": 2400., "rate": .025}}
    sim = copy.deepcopy(MODELS["thermal"])
    sim.experiments = copy.deepcopy(catalog)
    y = sim(theta, settings, options=TRUTH_OPTIONS)
    t = y.pop("t")
    measured = {ch: v + rng.normal(0., sigma, len(v)) for ch, v in y.items()}
    observation = Observation(name, settings, t, measured, {ch: sigma for ch in y}).to_dict()
    base = {"params": {k: {"unit": s.unit, "lo": s.lo, "hi": s.hi} for k, s in sim.params.items()},
            "fixed": {}, "catalog": catalog, "options": asdict(FIT_OPTIONS), "theta": theta,
            "observations": [observation], "noise": {ch: sigma for ch in y}}
    for path, c in op_cases("thermal", sim, base, name, settings, t, catalog, "power", [5., 15.],
                            ("analyze", "rank"), "short"):
        if c["op"] == "analyze":
            assert c["expect"]["non_identified"]["value"], "the short step should leave a parameter undetermined"
        yield path, c


def battery_cases():
    from autophys.synthetic import battery_case, BATTERY_TRUTH
    view, _ = battery_case(0)
    sim = view.simulator
    obs = view.dataset.split("train")[0]
    base = {"params": {k: {"unit": s.unit, "lo": s.lo, "hi": s.hi} for k, s in sim.params.items()},
            "fixed": {}, "catalog": copy.deepcopy(sim.experiments), "options": asdict(FIT_OPTIONS),
            "theta": BATTERY_TRUTH, "observations": [obs.to_dict()], "noise": {"v": .002}}
    yield from op_cases("battery", sim, base, obs.experiment, obs.settings, obs.t,
                        sim.experiments, "current", [1., 3.], ("analyze", "rank"), "short")
    i = copy.deepcopy(base)
    i.update(dataset=[o.to_dict() for o in view.dataset], initial=BATTERY_TRUTH,
             budgets={k: v for k, v in asdict(Budgets(max_experiments=2)).items() if k != "max_test_hours"},
             stop={"validation_threshold": 2., "misfit_threshold": 2., "rule": asdict(IdentifiabilityRule())},
             runner={"theta": BATTERY_TRUTH})
    # Keep the shared numerics format unchanged: project catalog costs are
    # tested in test_battery, not represented by this physics transcript.
    c = {"format": 1, "written_by": "autophys 0.1.0 (python)", "model": "battery", "op": "run", "inputs": i}
    result = execute(c)
    i["script"] = result["decisions"]
    c["expect"] = {k: {"value": result[k], "exact": True} for k in ("status", "actions")}
    for j, decision in enumerate(result["decisions"]):
        for key in ("action", "arguments"):
            c["expect"][f"decisions.{j}.{key}"] = {"value": decision[key], "exact": True}
    yield "battery/run-scripted.json", c


def all_cases():
    yield from build_cases()
    yield from degenerate_cases()
    yield from battery_cases()


def write(out=ROOT):
    written = []
    for name, case in all_cases():
        path = out / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(case, indent=2, allow_nan=False) + "\n")
        written.append(path)
    return written


if __name__ == "__main__":
    for path in write():
        print(path.relative_to(ROOT), path.stat().st_size)
