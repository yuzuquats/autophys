"""Projects: one simulator plus its declared configuration.

Hierarchy: workspace (the account an API key belongs to) → project →
investigation. A :class:`Project` is declared in code and uploaded; the
server never edits it. Its configuration is:

* the simulator (schema and source hash),
* the parameter schema: unit and bounds from the simulator, plus an
  ``initial`` value and whether the parameter is ``fixed`` (held at
  ``initial``) or free,
* the experiment catalog with per-experiment limits (``max_runs``) and,
  optionally, the settings a reviewer may edit with their ``[lo, hi]``
  limits (``edit``, at most three; see :func:`autophys.design.outlook`),
* the noise model: declared ``sigma`` per channel (else the observations'
  own), whether to ``estimate`` a common noise scale from the fit, and the
  sensor-bias mode (``off``, ``fit`` always, or ``compare`` as a model variant),
* budgets and stop rules (validation threshold, misfit threshold,
  identifiability rule),
* the policy (``scripted`` or ``reason-lane`` with its effort).

Every distinct configuration is an immutable *config version* keyed by the
sha256 of its canonical JSON, which includes the simulator source hash.
Each investigation pins the config version it ran with. The only
per-investigation override is which parameters are free versus fixed; it is
recorded on the investigation.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

from .sensitivity import DEFAULT_RULE, IdentifiabilityRule
from .simulator import Simulator
from .store import config_hash

BIAS_MODES = ("off", "fit", "compare")
POLICY_KINDS = ("scripted", "reason-lane")


@dataclass(frozen=True)
class Budgets:
    max_steps: int = 24
    max_simulations: int = 20000
    max_experiments: int = 2
    max_outlook_simulations: int = 50000
    max_test_hours: float | None = None

    def __post_init__(self) -> None:
        value = self.max_test_hours
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or value < 0):
            raise ValueError("max_test_hours must be finite and non-negative")


@dataclass(frozen=True)
class NoiseConfig:
    sigma: dict[str, float] | None = None
    estimate: bool = False
    bias: str = "compare"

    def __post_init__(self) -> None:
        if self.bias not in BIAS_MODES:
            raise ValueError(f"bias must be one of {BIAS_MODES}")
        for ch, s in (self.sigma or {}).items():
            if not s > 0:
                raise ValueError(f"sigma for {ch} must be positive")


@dataclass(frozen=True)
class StopRules:
    validation_threshold: float = 2.0
    misfit_threshold: float = 2.0
    rule: IdentifiabilityRule = DEFAULT_RULE


@dataclass(frozen=True)
class PolicyConfig:
    kind: str = "scripted"
    effort: str | None = "low"
    max_tokens: int = 2400

    def __post_init__(self) -> None:
        if self.kind not in POLICY_KINDS:
            raise ValueError(f"policy kind must be one of {POLICY_KINDS}")


@dataclass
class Project:
    name: str
    simulator: Simulator
    initial: dict[str, float] = field(default_factory=dict)
    fixed: tuple[str, ...] = ()
    catalog: dict[str, dict] | None = None  # name -> {"max_runs": int | None, "edit": {setting: [lo, hi]}}
    noise: NoiseConfig = field(default_factory=NoiseConfig)
    budgets: Budgets = field(default_factory=Budgets)
    stop: StopRules = field(default_factory=StopRules)
    policy: PolicyConfig = field(default_factory=PolicyConfig)
    n_starts: int = 4

    def __post_init__(self) -> None:
        sim = self.simulator
        for k, v in self.initial.items():
            if k not in sim.params:
                raise ValueError(f"initial value for unknown parameter {k}")
            spec = sim.params[k]
            if not spec.lo <= v <= spec.hi:
                raise ValueError(f"initial {k}={v} outside [{spec.lo}, {spec.hi}]")
        self.fixed = tuple(self.fixed)
        self._check_fixed(self.fixed)
        if self.catalog is None:
            self.catalog = {n: {"max_runs": None} for n in sim.experiments}
        for n, lim in self.catalog.items():
            if n not in sim.experiments:
                raise ValueError(f"catalog entry {n!r} is not a simulator experiment")
            mr = lim.get("max_runs")
            if mr is not None and not (isinstance(mr, int) and mr >= 0):
                raise ValueError(f"{n}: max_runs must be a non-negative integer")
            cost = lim.get("cost_hours")
            if "cost_hours" in lim and (isinstance(cost, bool) or not isinstance(cost, (int, float)) or not np.isfinite(cost) or cost < 0):
                raise ValueError(f"{n}: cost_hours must be finite and non-negative")
            self._check_edit(n, lim.get("edit") or {})

    def _check_edit(self, name: str, edit: dict) -> None:
        from .design import OUTLOOK_MAX_AXES

        settings = self.simulator.experiments[name]
        if len(edit) > OUTLOOK_MAX_AXES:
            raise ValueError(f"{name}: at most {OUTLOOK_MAX_AXES} editable settings")
        for key, limits in edit.items():
            v = settings.get(key)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ValueError(f"{name}: editable setting {key!r} must be a numeric setting of the experiment")
            if not (isinstance(limits, (list, tuple)) and len(limits) == 2):
                raise ValueError(f"{name}: edit limits for {key!r} must be [lo, hi]")
            lo, hi = float(limits[0]), float(limits[1])
            if not (np.isfinite(lo) and np.isfinite(hi) and lo < hi and lo <= v <= hi):
                raise ValueError(f"{name}: edit limits for {key!r} must satisfy lo < hi and contain {v}")

    def _check_fixed(self, fixed) -> None:
        for k in fixed:
            if k not in self.simulator.params:
                raise ValueError(f"cannot fix unknown parameter {k}")
            if k not in self.initial:
                raise ValueError(f"fixed parameter {k} needs an initial value")
        if len(set(fixed)) == len(self.simulator.params):
            raise ValueError("at least one parameter must be free")

    # --- configuration ----------------------------------------------------
    def initial_value(self, k: str) -> float:
        if k in self.initial:
            return float(self.initial[k])
        s = self.simulator.params[k]
        return float(np.sqrt(s.lo * s.hi)) if s.log else 0.5 * (s.lo + s.hi)

    def config(self) -> dict:
        sim = self.simulator
        budgets = asdict(self.budgets)
        if self.budgets.max_outlook_simulations == Budgets().max_outlook_simulations:
            budgets.pop("max_outlook_simulations")
        if self.budgets.max_test_hours is None:
            budgets.pop("max_test_hours")
        return {
            "name": self.name,
            "simulator": {"name": sim.name, "source_hash": sim.source_hash, "outputs": list(sim.outputs)},
            "params": {
                k: {"unit": s.unit, "lo": s.lo, "hi": s.hi, "initial": self.initial.get(k), "fixed": k in self.fixed}
                for k, s in sim.params.items()
            },
            "catalog": {
                n: {"settings": sim.experiments[n], "max_runs": lim.get("max_runs"),
                    **({"cost_hours": float(lim["cost_hours"])} if "cost_hours" in lim else {}),
                    # only present when declared, so configs without it keep their hash
                    **({"edit": {k: [float(a), float(b)] for k, (a, b) in lim["edit"].items()}} if lim.get("edit") else {})}
                for n, lim in self.catalog.items()
            },

            "noise": asdict(self.noise),
            "budgets": budgets,
            "stop": {
                "validation_threshold": self.stop.validation_threshold,
                "misfit_threshold": self.stop.misfit_threshold,
                "rule": asdict(self.stop.rule),
            },
            "policy": asdict(self.policy),
            "n_starts": self.n_starts,
        }

    @property
    def config_version(self) -> str:
        return config_hash(self.config())

    def resolve_free(self, free: list[str] | None) -> tuple[list[str], dict[str, float]]:
        """Per-investigation override: the free parameter list. Returns (free, fixed values)."""
        names = list(self.simulator.params)
        if free is None:
            free = [k for k in names if k not in self.fixed]
        unknown = [k for k in free if k not in names]
        if unknown:
            raise ValueError(f"unknown free parameters {unknown}")
        fixed = [k for k in names if k not in free]
        self._check_fixed(fixed)
        return [k for k in names if k in free], {k: float(self.initial[k]) for k in fixed}

    def investigate(self, dataset, runner, **kw: Any):
        """Start an :class:`~autophys.agent.Investigation` pinned to this config version."""
        from .agent import Investigation

        return Investigation(self, dataset, runner, **kw)


def policy_from_config(cfg: PolicyConfig, reasoner=None):
    from .agent import ReasonLanePolicy, ScriptedPolicy

    if cfg.kind == "scripted":
        return ScriptedPolicy()
    if reasoner is None:
        raise ValueError("a reason-lane policy needs a reasoner (HttpReasoner or FakeReasoner)")
    return ReasonLanePolicy(reasoner, effort=cfg.effort, max_tokens=cfg.max_tokens)

