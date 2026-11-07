"""Synthetic cases: hidden parameters, noisy observations, and an evaluator.

The split of knowledge is the point of this module:

* :class:`CaseView` is everything the agent may see: the simulator, the
  initial dataset (train and validation splits), the experiment budget and a
  :class:`SyntheticRunner` that returns new noisy observations on request.
* :class:`Evaluator` holds the true parameters and the held-out test
  experiments. It is returned separately and never passed to an agent, a
  policy or a tool. The runner captures the truth in a closure and exposes
  only ``run``; this is a structural boundary inside one process, not a
  security boundary.

Observations are generated with :data:`TRUTH_OPTIONS`, a much finer solver
tolerance than fitting uses, so a fit never reproduces the generator's own
discretisation error (the "inverse crime").
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

import numpy as np

from .data import Dataset, Observation
from .simulator import TRUTH_OPTIONS, Simulator


@dataclass(frozen=True)
class NoiseModel:
    sigma: dict[str, float]
    bias: dict[str, float] = field(default_factory=dict)
    missing_fraction: float = 0.0


def observe(
    sim: Simulator,
    truth: Mapping[str, float],
    experiment: str | Mapping[str, Any],
    noise: NoiseModel,
    rng: np.random.Generator,
    *,
    split: str = "train",
    name: str | None = None,
) -> Observation:
    settings = sim.experiment(experiment)
    out = sim(truth, settings, options=TRUTH_OPTIONS, count=False)  # data generation is not a fit call
    y = {}
    for ch in [k for k in out if k != "t"]:
        v = out[ch] + rng.normal(0.0, noise.sigma[ch], size=out[ch].shape) + noise.bias.get(ch, 0.0)
        if noise.missing_fraction > 0:
            drop = rng.random(v.shape) < noise.missing_fraction
            drop[0] = False
            v = np.where(drop, np.nan, v)
        y[ch] = v
    return Observation(
        experiment=name or (experiment if isinstance(experiment, str) else settings["kind"]),
        settings=settings,
        t=out["t"],
        y=y,
        sigma=dict(noise.sigma),
        split=split,
        source="synthetic",
    )


class SyntheticRunner:
    """Runs catalog experiments on the hidden system. Exposes only ``run``."""

    def __init__(self, sim: Simulator, truth: Mapping[str, float], noise: NoiseModel, seed: int) -> None:
        rng = np.random.default_rng(seed)
        hidden = dict(truth)

        def _run(experiment: str | Mapping[str, Any]) -> Observation:
            return observe(sim, hidden, experiment, noise, rng)

        self._run: Callable[[Any], Observation] = _run
        self.kind = "synthetic"

    def run(self, experiment: str | Mapping[str, Any]) -> Observation:
        return self._run(experiment)


@dataclass
class CaseView:
    """What an agent may see."""

    name: str
    simulator: Simulator
    dataset: Dataset
    runner: SyntheticRunner
    max_experiments: int
    candidates: list[str] | None = None
    max_test_hours: float | None = None
    catalog: dict | None = None


@dataclass
class Evaluator:
    """Ground truth and held-out test data. Never handed to an agent."""

    case: str
    truth: dict[str, float]
    test: list[Observation]
    combos: dict[str, dict[str, float]]
    expected_non_identified: set[str]
    note: str = ""

    def combo_value(self, params: Mapping[str, float], combo: str) -> float:
        return float(np.prod([params[p] ** e for p, e in self.combos[combo].items()]))

    def relative_errors(self, estimate: Mapping[str, float]) -> dict[str, float]:
        """Relative error of each identifiable combination."""
        return {
            c: abs(self.combo_value(estimate, c) / self.combo_value(self.truth, c) - 1.0) for c in self.combos
        }

    def test_rmse(self, sim: Simulator, estimate: Mapping[str, float]) -> float:
        """RMSE against the noisy held-out test observations (≈ sigma for a perfect model)."""
        sq, n = 0.0, 0
        for obs in self.test:
            pred = sim({k: estimate[k] for k in sim.params}, obs.settings, count=False)
            for ch, y in obs.y.items():
                m = np.isfinite(y)
                sq += float(np.sum((y[m] - pred[ch][m]) ** 2))
                n += int(m.sum())
        return float(np.sqrt(sq / max(n, 1)))

    def diagnosis_correct(self, non_identified: set[str]) -> bool:
        return set(non_identified) == set(self.expected_non_identified)

    def reveal(self, investigation):
        """Harness-only publication, after outcome; never called by the agent.

        Delta method: g_j = exponent_j for log parameters, otherwise
        exponent_j * parameter_scale_j / estimate_j. With final sensitivity
        J=U diag(s) V^T, sigma_ratio=abs(estimate/truth)*sqrt(sum((V_i.g/s_i)^2)).
        A structural direction with |V_i.g| > 1e-8, missing/stale analysis,
        missing fit or nonfinite uncertainty yields null. Known measurement
        sigma (including the analysis noise scale), no residual rescaling.
        """
        out = investigation.outcome
        if out is None:
            raise ValueError("reveal requires an outcome")
        estimate = dict(out.estimate)
        quantities = []
        report = investigation.sens if investigation.sens_fit == investigation.fit_id else None
        for name, powers in self.combos.items():
            if not all(p in estimate for p in powers):
                continue
            truth = self.combo_value(self.truth, name)
            value = self.combo_value(estimate, name)
            ratio = value / truth
            sigma = None
            if report is not None and investigation.fit is not None:
                gradient = {}
                for p in report.params:
                    spec = investigation.sim.params[p]
                    exponent = powers.get(p, 0.0)
                    gradient[p] = (0.0 if exponent == 0 else exponent if spec.log else
                                   exponent * spec.scale / estimate[p] if estimate[p] else float("nan"))
                variance = 0.0
                for direction in report.directions:
                    projection = sum(gradient[p] * direction.vector[p] for p in report.params)
                    if (direction.kind == "structural" and abs(projection) > 1e-8
                            or direction.singular_value <= 0 and abs(projection) > 1e-8):
                        variance = float("nan")
                        break
                    if direction.singular_value > 0:
                        variance += (projection / direction.singular_value) ** 2
                candidate = abs(ratio) * float(np.sqrt(variance))
                if np.isfinite(candidate):
                    sigma = candidate
            quantities.append({"name": name, "truth": truth, "estimate": value,
                               "ratio": ratio, "sigma_ratio": sigma,
                               "within": abs(ratio - 1.0) <= 0.10,
                               "identifiable": name not in self.expected_non_identified})
        return investigation.store.append(investigation.id, "reveal", {
            "source": "synthetic", "tolerance": 0.10, "truth": dict(self.truth),
            "estimate": estimate, "quantities": quantities,
            "fit_id": investigation.fit_id if investigation.fit is not None else None})

    def save(self, path: str | Path) -> None:
        Path(path).write_text(
            json.dumps(
                {
                    "case": self.case,
                    "truth": self.truth,
                    "combos": self.combos,
                    "expected_non_identified": sorted(self.expected_non_identified),
                    "test": [o.to_dict() for o in self.test],
                    "note": self.note,
                }
            )
        )

    @classmethod
    def load(cls, path: str | Path) -> "Evaluator":
        d = json.loads(Path(path).read_text())
        return cls(
            case=d["case"],
            truth=d["truth"],
            test=[Observation.from_dict(o) for o in d["test"]],
            combos=d["combos"],
            expected_non_identified=set(d["expected_non_identified"]),
            note=d.get("note", ""),
        )


# --------------------------------------------------------------------------
# Case catalogue


OSC_TRUTH = {"m": 2.0, "c": 0.8, "k": 15.0}
THERMAL_TRUTH = {"C": 500.0, "R": 2.0}


def _build(
    name: str,
    sim: Simulator,
    truth: dict,
    noise: NoiseModel,
    seed: int,
    train: list,
    validation: list,
    test: list,
    max_experiments: int,
    combos: dict,
    expected: set,
    note: str,
) -> tuple[CaseView, Evaluator]:
    rng = np.random.default_rng([seed, 1])
    ds = Dataset()
    for e in train:
        ds.add(observe(sim, truth, e, noise, rng, split="train", name=e if isinstance(e, str) else None))
    for e in validation:
        ds.add(observe(sim, truth, e, noise, rng, split="validation", name=e if isinstance(e, str) else e["name"]))
    test_rng = np.random.default_rng([seed, 2])
    test_obs = [observe(sim, truth, e, NoiseModel(noise.sigma), test_rng, split="test", name=e["name"]) for e in test]
    runner = SyntheticRunner(sim, truth, noise, seed=seed * 7919 + 3)
    view = CaseView(name, sim, ds, runner, max_experiments)
    ev = Evaluator(name, dict(truth), test_obs, combos, expected, note)
    return view, ev


def _declared(example: str, case: str, seed: int, **overrides):
    """A declared built-in case (``examples/<example>.backtest``) with the helpers' changes."""
    from .backtest import Backtest

    b = Backtest.builtin(example)
    return b.build(b.case(case), seed, **overrides)


def oscillator_case(seed: int = 0, *, max_experiments: int = 2, bias: float = 0.0, missing: float = 0.0):
    """Free-response oscillator; the forced experiments must be requested.

    ``examples/oscillator.backtest``: ``free-only`` when ``max_experiments`` is 0, else ``full``.
    """
    return _declared("oscillator", "free-only" if max_experiments == 0 else "full", seed,
                     max_experiments=max_experiments, bias={"x": bias} if bias else None, missing=missing)


def thermal_case(seed: int = 0, *, max_experiments: int = 2, bias: float = 0.0, missing: float = 0.0):
    """A short heating step pins down C but barely R; a longer experiment fixes R.

    ``examples/thermal.backtest``: ``short-only`` when ``max_experiments`` is 0, else ``full``.
    """
    return _declared("thermal", "short-only" if max_experiments == 0 else "full", seed,
                     max_experiments=max_experiments, bias={"T": bias} if bias else None, missing=missing)


BATTERY_TRUTH = {"R0": 0.025, "R1": 0.045, "C1": 1600.0}


def battery_case(seed: int = 0, *, max_experiments: int = 2, bias: float = 0.0):
    """A short pulse measures the ohmic drop and initial polarization slope.

    ``bias`` adds a constant voltage-sensor offset (V) to every measurement.
    ``examples/battery.backtest``: ``short-only`` when ``max_experiments`` is 0,
    else ``biased`` with a bias, else ``full``.
    """
    case = "short-only" if max_experiments == 0 else "biased" if bias else "full"
    return _declared("battery", case, seed, max_experiments=max_experiments, bias={"v": bias} if bias else None)


def _factory(case_id: str):
    def make(seed: int):
        from .backtest import resolve_case

        b, name = resolve_case(case_id)
        return b.build(b.case(name), seed)
    return make


def _catalogue():
    from .backtest import planted, suite

    return {c: _factory(c) for c in suite()}, {c: _factory(c) for c in planted()}


# The benchmark suite (``examples/*.backtest`` cases in the default suite), and
# the planted cases with a known strategy fix, used to check that the research
# loop finds it (``battery-biased``: the voltage sensor reads 10 mV high).
CASES, PLANTED_CASES = _catalogue()


def case(name: str):
    """A case factory by stable id (``battery``) or reference (``battery#full``, ``./x.backtest#c``)."""
    if name in CASES:
        return CASES[name]
    if name in PLANTED_CASES:
        return PLANTED_CASES[name]
    from .backtest import resolve_case

    try:
        resolve_case(name)
    except (KeyError, ValueError, OSError) as e:
        raise KeyError(f"unknown case {name!r}: {e}") from None
    return _factory(name)


_case_factory = case  # run_case's argument is named ``case``


# --------------------------------------------------------------------------
# Running a case (formerly autophys.bench; the CLI's `autophys bench` is Rust)

DEFAULT_POLICIES = ("scripted", "fake-reasoner")


def reason_policy(*, model_spec=None, playbook=None, replay=None, record=None):
    import os
    from .agent import ReasonLanePolicy
    from .reasoner import ReasonerError, reasoner_for
    if not (replay or os.environ.get("AUTOPHYS_REASON_REPLAY")) and os.environ.get("AUTOPHYS_ALLOW_LIVE_REASON") != "1":
        raise ReasonerError("reason benchmark requires --replay for offline use; live calls spend money and require AUTOPHYS_ALLOW_LIVE_REASON=1")
    if model_spec is None:
        raise ReasonerError("reason benchmark requires --model")
    policy = ReasonLanePolicy(reasoner_for(model_spec, replay=replay, record=record),
                              model_spec=model_spec, playbook=playbook)
    policy.name = "reason"
    return policy


def _scripted():
    from .agent import ScriptedPolicy
    return ScriptedPolicy()


def _fake_reasoner():
    from .agent import ReasonLanePolicy
    from .heuristic import heuristic_responder
    from .reasoner import FakeReasoner
    return ReasonLanePolicy(FakeReasoner(heuristic_responder))


POLICIES: dict[str, Callable[..., object]] = {
    "reason": reason_policy,
    "scripted": _scripted,
    "fake-reasoner": _fake_reasoner,
}


def case_project(view):
    """The project a benchmark investigation of ``view`` runs under."""
    from .project import Budgets, Project
    return Project(name=view.name, simulator=view.simulator, catalog=view.catalog,
                   budgets=Budgets(max_experiments=view.max_experiments, max_test_hours=view.max_test_hours))


@dataclass
class BenchRow:
    case: str
    policy: str
    seed: int
    status: str
    max_rel_error: float
    rel_errors: dict
    test_rmse: float
    simulations: int
    wall_s: float
    experiments: int
    steps: int
    non_identified: list
    diagnosis_correct: bool
    requested: list
    test_hours: float = 0.0
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None


def run_case(case: str, policy: str, seed: int, store=None, **reason_options) -> BenchRow:
    """One benchmark run: ``policy`` on synthetic ``case`` with ``seed``, scored by its evaluator.

    The ``autophys bench`` command runs the same investigation in Rust; ``autophys
    train eval`` (``train/sft/eval_heldout.py``) calls this function.
    """
    import time
    from .agent import Investigation, ReasonLanePolicy
    from .heuristic import heuristic_responder
    from .reasoner import FakeReasoner
    from .store import MemoryStore
    from .usage import usage_total
    workbook_path = reason_options.pop("workbook_path", None)
    if workbook_path:
        from .workbook import WorkbookStore
        with WorkbookStore(workbook_path) as workbook:
            return run_case(case, policy, seed, store=workbook, **reason_options)
    render_images = reason_options.pop("render_images", False)
    view, evaluator = _case_factory(case)(seed)
    project = case_project(view)
    if policy == "reason":
        selected_policy = POLICIES[policy](**reason_options)
    elif policy == "fake-reasoner" and reason_options.get("playbook"):
        selected_policy = ReasonLanePolicy(FakeReasoner(heuristic_responder), playbook=reason_options["playbook"])
    else:
        selected_policy = POLICIES[policy]()
    selected_policy.render_images = render_images
    inv = Investigation(project, view.dataset, view.runner, policy=selected_policy, store=store or MemoryStore(), seed=seed,
                        title=f"bench {case} seed {seed}")
    t0 = time.perf_counter()
    out = inv.run()
    wall = time.perf_counter() - t0
    evaluator.reveal(inv)
    est = out.estimate
    rel = evaluator.relative_errors(est) if est else {}
    physical = set(view.simulator.param_names)
    non_ids = sorted(set(out.non_identified) & physical)
    requested = [o.experiment for o in view.dataset if o.source == "synthetic" and o.split == "train"][1:]
    usage = usage_total(r.payload for r in inv.store.records(inv.id, "step"))
    return BenchRow(
        case=case, policy=policy, seed=seed, status=out.status, test_hours=inv.test_hours_used,
        max_rel_error=max(rel.values()) if rel else float("nan"), rel_errors=rel,
        test_rmse=evaluator.test_rmse(view.simulator, est) if est else float("nan"),
        simulations=out.simulations, wall_s=wall, experiments=out.experiments, steps=out.steps,
        non_identified=non_ids, diagnosis_correct=evaluator.diagnosis_correct(set(non_ids)), requested=requested,
        **{**usage, "cost_usd": usage["cost_usd"] if usage["calls"] else None},
    )
