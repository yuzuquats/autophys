"""Presentation metadata kept outside simulator schemas and project identities."""
from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .store import canonical

VIEWS = {"edges", "envelope", "spectrum"}
DEFAULT_VIEWS = VIEWS | {"fit", "residuals", "landscape"}


@dataclass(frozen=True)
class Display:
    """Format-1 declaration. Input functions receive (experiment_settings, t).

    Attach with Simulator.with_display(), or pass display= to @simulator.
    to_dict(project) generates uncounted previews using Project.initial_value.
    """

    channels: dict = field(default_factory=dict)
    params: dict = field(default_factory=dict)
    settings: dict = field(default_factory=dict)
    experiments: dict = field(default_factory=dict)
    default_view: str | None = None
    inputs: dict[str, Callable] = field(default_factory=dict, compare=False, repr=False)

    def validate(self, sim) -> None:
        keys = {k for exp in sim.experiments.values() for k in exp}
        if set(self.settings) - keys:
            raise ValueError("display settings must exist in the experiment catalog")
        if set(self.params) - set(sim.params):
            raise ValueError("display params must exist in the simulator")
        if set(self.experiments) - set(sim.experiments):
            raise ValueError("display experiments must exist in the catalog")
        if self.default_view is not None and self.default_view not in DEFAULT_VIEWS:
            raise ValueError("invalid display default_view")
        for exp in self.experiments.values():
            if set(exp.get("views", [])) - VIEWS:
                raise ValueError("invalid display views")
        for setting in self.settings.values():
            if setting.get("role") not in {"drive", "sampling", "known", "other"}:
                raise ValueError("invalid display setting role")
        for ch, spec in self.channels.items():
            if ch == "t" or spec.get("role") not in {"input", "output"}:
                raise ValueError("invalid display channel role or name")
            if spec["role"] == "output" and ch not in sim.outputs:
                raise ValueError("display output channels must be in outputs")
            if spec["role"] == "input" and ch in sim.outputs:
                raise ValueError("display inputs must be separate from outputs")
        input_names = {ch for ch, spec in self.channels.items() if spec["role"] == "input"}
        if set(self.inputs) - input_names or any(not callable(fn) for fn in self.inputs.values()):
            raise ValueError("display input functions must provide declared input channels")
        # Probe every catalog experiment at declaration, without charging a budget.
        # Stochastic declarations use seed 0 only for validation; previews use defaults.
        if input_names:
            from .simulator import _accepts_options, SimOptions, SimulationError
            p = {k: float(np.sqrt(s.lo * s.hi)) if s.log else (s.lo + s.hi) / 2
                 for k, s in sim.params.items()}
            for exp in sim.experiments.values():
                exp = copy.deepcopy(exp)
                raw = sim.fn(p, exp, options=SimOptions(seed=0)) if _accepts_options(sim.fn) else sim.fn(p, exp)
                try:
                    sim._check_result(raw, experiment=exp, display=self)
                except SimulationError as exc:
                    raise ValueError(f"invalid display inputs: {exc}") from exc

    def to_dict(self, project) -> dict:
        sim = project.simulator
        settings = copy.deepcopy(self.settings)
        # Explicitly list all undeclared settings so consumers need no inference.
        for name in project.catalog:
            for key in sim.experiments[name]:
                settings.setdefault(key, {"label": key, "unit": "", "role": "other"})
        params = {k: project.initial_value(k) for k in sim.params}
        experiments = {}
        for name in project.catalog:
            exp = sim.experiment(name)
            result = sim(params, exp, count=False)
            t = np.linspace(0.0, float(exp.get("duration", result["t"][-1])), 64)
            # Rust contract: round each t and interpolated u value using the
            # equivalent of float(f"{x:.6g}") (six significant decimal figures).
            rounded = lambda values: [float(f"{x:.6g}") for x in values]
            preview = {"t": rounded(t), "u": {ch: rounded(np.interp(t, result["t"], u))
                                               for ch, u in result.u.items()}}
            experiments[name] = {"label": name, "description": "", "views": [],
                                 **copy.deepcopy(self.experiments.get(name, {})), "preview": preview}
        out = {"format": 1, "simulator": sim.name, "channels": copy.deepcopy(self.channels),
               "settings": settings, "experiments": experiments}
        if self.params:
            out["params"] = copy.deepcopy(self.params)
        if self.default_view is not None:
            out["default_view"] = self.default_view
        return out

    def canonical(self, project) -> bytes:
        return canonical(self.to_dict(project)).encode("utf-8")

    def digest(self, project) -> str:
        return "sha256:" + hashlib.sha256(self.canonical(project)).hexdigest()
