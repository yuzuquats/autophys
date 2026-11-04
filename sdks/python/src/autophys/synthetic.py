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


def _osc_custom(name: str, **kw) -> dict:
    return {"name": name, "duration": 10.0, "rate": 100.0, **kw}


def oscillator_case(seed: int = 0, *, max_experiments: int = 2, bias: float = 0.0, missing: float = 0.0):
    """Free-response oscillator; the forced experiments must be requested."""
    from .models import oscillator

    ambiguous = max_experiments == 0
    combos = {"c/m": {"c": 1.0, "m": -1.0}, "k/m": {"k": 1.0, "m": -1.0}}
    if not ambiguous:
        combos = {"m": {"m": 1.0}, "c": {"c": 1.0}, "k": {"k": 1.0}}
    return _build(
        "oscillator-free-only" if ambiguous else "oscillator",
        oscillator,
        OSC_TRUTH,
        NoiseModel({"x": 0.01}, {"x": bias} if bias else {}, missing),
        seed,
        train=["free"],
        validation=[_osc_custom("free_neg", kind="free", x0=-0.08, v0=0.05)],
        test=[_osc_custom("sine_0.3Hz", kind="sine", amplitude=1.5, freq=0.3), _osc_custom("step_1N", kind="step", amplitude=1.0)],
        max_experiments=max_experiments,
        combos=combos,
        expected={"m", "c", "k"} if ambiguous else set(),
        note="A free response depends only on c/m and k/m: scaling m, c, k together is invisible.",
    )


def thermal_case(seed: int = 0, *, max_experiments: int = 2, bias: float = 0.0, missing: float = 0.0):
    """A short heating step pins down C but barely R; a longer experiment fixes R."""
    from .models import thermal_rc

    short_only = max_experiments == 0
    return _build(
        "thermal-short-only" if short_only else "thermal",
        thermal_rc,
        THERMAL_TRUTH,
        NoiseModel({"T": 0.05}, {"T": bias} if bias else {}, missing),
        seed,
        train=["step_short"],
        validation=[{"name": "step_short_5W", "kind": "step", "power": 5.0, "duration": 120.0, "rate": 1.0}],
        test=[{"name": "pulse_15W", "kind": "pulse", "power": 15.0, "on": 900.0, "duration": 4000.0, "rate": 0.1}],
        max_experiments=max_experiments,
        combos={"C": {"C": 1.0}} if short_only else {"C": {"C": 1.0}, "R": {"R": 1.0}},
        expected={"R"} if short_only else set(),
        note="Over 120 s of a 1000 s time constant the response is nearly linear in t/C; R only bends it.",
    )


BATTERY_TRUTH = {"R0": 0.025, "R1": 0.045, "C1": 1600.0}


def battery_case(seed: int = 0, *, max_experiments: int = 2, bias: float = 0.0):
    """A short pulse measures the ohmic drop and initial polarization slope.

    ``bias`` adds a constant voltage-sensor offset (V) to every measurement.
    """
    from .models.battery import battery_ecm, KNOWN

    short = max_experiments == 0
    def pulse(name, current, on=6.0):
        return {"name": name, "kind": "pulse", "current": current, "on": on,
                "duration": 25.0, "rate": 32.0, **KNOWN}
    view, ev = _build(
        "battery-short-only" if short else "battery-biased" if bias else "battery", battery_ecm, BATTERY_TRUTH,
        NoiseModel({"v": 0.002}, {"v": bias} if bias else {}), seed,
        train=[pulse("pulse_short", 2.0)],
        validation=[pulse("pulse_short_1A", 1.0, 6.0)],
        test=[{"name": "unseen_train", "kind": "pulse_train", "current": 1.5,
               "on": 40.0, "off": 60.0, "duration": 500.0, "rate": 1.0, **KNOWN}],
        max_experiments=max_experiments,
        combos={"R0": {"R0": 1.0}, "C1": {"C1": 1.0}} if short else
               {k: {k: 1.0} for k in BATTERY_TRUTH},
        expected={"R1"} if short else set(),
        note="A 6 s pulse against a 72 s RC time constant resolves the instantaneous I R0 drop and initial I/C1 slope; R1 needs a longer polarization and relaxation trace.",
    )
    view.max_test_hours = 3.0
    view.catalog = {n: {"max_runs": None, "cost_hours": 1.0 + e["duration"] / 3600.0}
                    for n, e in battery_ecm.experiments.items()}
    return view, ev


CASES = {
    "oscillator-free-only": lambda seed: oscillator_case(seed, max_experiments=0),
    "oscillator": lambda seed: oscillator_case(seed, max_experiments=2),
    "thermal-short-only": lambda seed: thermal_case(seed, max_experiments=0),
    "thermal": lambda seed: thermal_case(seed, max_experiments=2),
    "battery-short-only": lambda seed: battery_case(seed, max_experiments=0),
    "battery": lambda seed: battery_case(seed, max_experiments=2),
}

# Cases with a known strategy fix, used to check that the research loop finds it.
# They are not in CASES: the benchmark suite (and its Rust mirror) stays as is.
PLANTED_CASES = {
    # The voltage sensor reads 10 mV high. Comparing the sensor-bias variant when
    # the fit is poor validates the cell; never comparing ends inconclusive.
    "battery-biased": lambda seed: battery_case(seed, max_experiments=2, bias=0.01),
}


def case(name: str):
    """A case factory by name, from the benchmark suite or the planted checks."""
    if name in CASES:
        return CASES[name]
    if name in PLANTED_CASES:
        return PLANTED_CASES[name]
    raise KeyError(f"unknown case {name!r}")
