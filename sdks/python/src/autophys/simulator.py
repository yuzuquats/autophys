"""The simulator contract.

A simulator is a plain function ``simulate(params, experiment) -> dict`` wrapped
with :func:`simulator`, which attaches a parameter schema (unit and bounds per
parameter), an experiment catalog, and a source hash that identifies the code
in every recorded run.

The returned dict holds a time vector ``"t"`` and one array per output
channel, all the same length. A function may accept a keyword ``options``
(:class:`SimOptions`) to receive solver tolerances and, when stochastic, a
seed. A stochastic simulator must be called with a seed; the seed is part of
the run record.
"""

from __future__ import annotations

import copy
import hashlib
import inspect
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

import numpy as np

from .data import check_settings


class SimulationResult(dict):
    """The historical t/output dict, with input channels kept separately.

    A plain dict subclass keeps mapping equality and pickle behaviour unchanged.
    """

    def __init__(self, *args, u=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.u = {} if u is None else u


class SimulationError(RuntimeError):
    """The simulator failed or returned an unusable result."""


class GridMismatchError(SimulationError):
    """A prediction is not on an observation's own samples: the settings it
    was simulated from describe a different grid than the observation's ``t``.
    The SDK cannot tell which setting is the grid, so it never re-predicts."""


def describe_observation(obs, index: int, count: int) -> str:
    """``validation observation 2 of 3 (experiment 'treated')``; ``index`` is 0-based."""
    return f"{obs.split} observation {index + 1} of {count} (experiment {obs.experiment!r})"


def aligned_prediction(pred: Mapping[str, Any], obs, channel: str, where: str) -> np.ndarray:
    """``pred[channel]``, checked to have one value per sample of ``obs`` before
    any sample mask is applied; ``where`` names the observation."""
    p = np.asarray(pred[channel])
    if p.shape != obs.y[channel].shape:
        raise GridMismatchError(
            f"{where}: the prediction for {channel!r} has {p.size} samples but the observation has "
            f"{obs.y[channel].size}; give this observation settings whose grid matches its own "
            f"samples (e.g. its own 't')")
    return p


class BoundsError(ValueError):
    """A parameter is missing, unknown, or outside its declared bounds."""


class SimulationBudgetExceeded(RuntimeError):
    """The investigation's simulation budget is spent. Not a SimulationError:
    fits must not swallow it as a failed trial point."""


class CallBudget:
    """A simulation counter shared by every model variant of an investigation."""

    def __init__(self, limit: int | None) -> None:
        self.limit = limit
        self.used = 0

    def charge(self) -> None:
        if self.limit is not None and self.used >= self.limit:
            raise SimulationBudgetExceeded(f"simulation budget of {self.limit} calls is spent")
        self.used += 1


@dataclass(frozen=True)
class ParamSpec:
    name: str
    unit: str
    lo: float
    hi: float

    def __post_init__(self) -> None:
        if not (np.isfinite(self.lo) and np.isfinite(self.hi)) or not self.lo < self.hi:
            raise ValueError(f"parameter {self.name}: need finite lo < hi, got {self.lo}, {self.hi}")

    @property
    def log(self) -> bool:
        """Strictly positive parameters are fitted and analysed in log space."""
        return self.lo > 0

    def to_x(self, value: float) -> float:
        return float(np.log(value)) if self.log else float(value) / self.scale

    def from_x(self, x: float) -> float:
        return float(np.exp(x)) if self.log else float(x) * self.scale

    @property
    def scale(self) -> float:
        """Linear parameters are scaled by their range so x is O(1)."""
        return 1.0 if self.log else (self.hi - self.lo)

    def x_bounds(self) -> tuple[float, float]:
        return self.to_x(self.lo), self.to_x(self.hi)

    def as_dict(self) -> dict:
        return {"name": self.name, "unit": self.unit, "lo": self.lo, "hi": self.hi}


@dataclass(frozen=True)
class SimOptions:
    rtol: float = 1e-8
    atol: float = 1e-10
    seed: int | None = None


#: Solver tolerances used to generate synthetic data: much finer than fitting.
TRUTH_OPTIONS = SimOptions(rtol=1e-11, atol=1e-13)
#: Default tolerances used by fits, sensitivities and rankings.
FIT_OPTIONS = SimOptions(rtol=1e-8, atol=1e-10)


def _validate_experiment(name: str, settings: Mapping[str, Any]) -> dict:
    if not isinstance(settings, Mapping):
        raise ValueError(f"experiment {name}: settings must be a mapping")
    s = dict(settings)
    if "kind" not in s:
        raise ValueError(f"experiment {name}: missing 'kind'")
    check_settings(name, s)
    for key in ("duration", "rate"):
        if key in s and not (isinstance(s[key], (int, float)) and s[key] > 0):
            raise ValueError(f"experiment {name}: {key} must be positive")
    return s


def time_grid(experiment: Mapping[str, Any]) -> np.ndarray:
    """Sample times for an experiment with ``duration`` (s) and ``rate`` (Hz)."""
    if "t" in experiment:
        return np.asarray(experiment["t"], dtype=float)
    duration = float(experiment["duration"])
    rate = float(experiment["rate"])
    n = int(round(duration * rate)) + 1
    return np.linspace(0.0, duration, n)


@dataclass
class Simulator:
    """A wrapped simulator. Call it as ``sim(params, experiment)``."""

    fn: Callable[..., dict]
    params: dict[str, ParamSpec]
    experiments: dict[str, dict]
    name: str
    outputs: tuple[str, ...] = ()
    stochastic: bool = False
    description: str = ""
    calls: int = field(default=0, compare=False)
    budget: CallBudget | None = field(default=None, compare=False, repr=False)
    _hash: str = field(default="", compare=False, repr=False)

    display: Any = field(default=None, compare=False, repr=False)

    def __post_init__(self) -> None:
        # G7-VAL: a catalog entry is recorded and hashed as JSON, so a value
        # JSON cannot hold fails here, naming it, not at the first record.
        for n, settings in self.experiments.items():
            check_settings(n, settings)

    def with_display(self, display) -> "Simulator":
        """Attach presentation only; schema, hashes and equality are unchanged."""
        display = copy.deepcopy(display)
        display.validate(self)
        self.display = display
        return self

    # --- schema -----------------------------------------------------------
    @property
    def param_names(self) -> list[str]:
        return list(self.params)

    def schema(self) -> dict:
        return {
            "name": self.name,
            "params": [p.as_dict() for p in self.params.values()],
            "experiments": self.experiments,
            "outputs": list(self.outputs),
            "stochastic": self.stochastic,
        }

    @property
    def source_hash(self) -> str:
        """sha256 over the function source and the schema."""
        if not self._hash:
            try:
                src = inspect.getsource(self.fn)
            except (OSError, TypeError):
                src = f"{getattr(self.fn, '__module__', '?')}.{getattr(self.fn, '__qualname__', '?')}"
            blob = src + json.dumps(self.schema(), sort_keys=True, default=str)
            self._hash = "sha256:" + hashlib.sha256(blob.encode()).hexdigest()
        return self._hash

    def validate_params(self, params: Mapping[str, float]) -> dict[str, float]:
        missing = [k for k in self.params if k not in params]
        unknown = [k for k in params if k not in self.params]
        if missing or unknown:
            raise BoundsError(f"{self.name}: missing {missing} unknown {unknown}")
        out = {}
        for k, spec in self.params.items():
            v = float(params[k])
            if not np.isfinite(v) or v < spec.lo or v > spec.hi:
                raise BoundsError(f"{self.name}: {k}={v} outside [{spec.lo}, {spec.hi}] {spec.unit}")
            out[k] = v
        return out

    def experiment(self, ref: str | Mapping[str, Any]) -> dict:
        """Resolve a catalog name or validate an explicit settings dict."""
        if isinstance(ref, str):
            if ref not in self.experiments:
                raise KeyError(f"{self.name}: unknown experiment {ref!r}")
            return copy.deepcopy(self.experiments[ref])
        return _validate_experiment("<custom>", ref)

    # --- vectors ----------------------------------------------------------
    def to_x(self, params: Mapping[str, float]) -> np.ndarray:
        return np.array([self.params[k].to_x(params[k]) for k in self.params])

    def from_x(self, x: np.ndarray) -> dict[str, float]:
        out = {}
        for (k, spec), xi in zip(self.params.items(), x):
            lo, hi = spec.lo, spec.hi
            out[k] = float(min(max(spec.from_x(xi), lo), hi))
        return out

    def x_bounds(self) -> tuple[np.ndarray, np.ndarray]:
        b = [s.x_bounds() for s in self.params.values()]
        return np.array([lo for lo, _ in b]), np.array([hi for _, hi in b])

    # --- call -------------------------------------------------------------
    def __call__(
        self,
        params: Mapping[str, float],
        experiment: str | Mapping[str, Any],
        *,
        options: SimOptions | None = None,
        seed: int | None = None,
        count: bool = True,
    ) -> dict[str, np.ndarray]:
        p = self.validate_params(params)
        exp = self.experiment(experiment)
        opts = options or FIT_OPTIONS
        if seed is not None:
            opts = SimOptions(opts.rtol, opts.atol, seed)
        if self.stochastic and opts.seed is None:
            raise SimulationError(f"{self.name} is stochastic: pass seed= so the run is reproducible")
        if count:
            if self.budget is not None:
                self.budget.charge()
            self.calls += 1
        try:
            if _accepts_options(self.fn):
                result = self.fn(p, exp, options=opts)
            else:
                result = self.fn(p, exp)
        except SimulationError:
            raise
        except Exception as exc:  # noqa: BLE001 - user code
            raise SimulationError(f"{self.name} raised {type(exc).__name__}: {exc}") from exc
        return self._check_result(result, experiment=exp)

    def _check_result(self, result: Any, *, experiment=None, display=None) -> dict[str, np.ndarray]:
        if not isinstance(result, Mapping) or "t" not in result:
            raise SimulationError(f"{self.name}: simulate must return a dict with 't'")
        t = np.asarray(result["t"], dtype=float)
        out = SimulationResult({"t": t})
        display = display if display is not None else self.display
        inputs = {ch for ch, spec in display.channels.items() if spec["role"] == "input"} if display else set()
        channels = self.outputs or tuple(k for k in result if k != "t" and k not in inputs)
        for ch in channels:
            if ch not in result:
                raise SimulationError(f"{self.name}: missing output channel {ch!r}")
            y = np.asarray(result[ch], dtype=float)
            if y.shape != t.shape:
                raise SimulationError(f"{self.name}: channel {ch!r} shape {y.shape} != t {t.shape}")
            if not np.all(np.isfinite(y)):
                raise SimulationError(f"{self.name}: channel {ch!r} has non-finite values")
            out[ch] = y
        for ch in sorted(inputs):
            if ch in result:
                values = result[ch]
            elif ch in display.inputs and experiment is not None:
                values = display.inputs[ch](experiment, t)
            else:
                raise SimulationError(f"{self.name}: missing input channel {ch!r}")
            u = np.asarray(values, dtype=float)
            if u.shape != t.shape or not np.all(np.isfinite(u)):
                raise SimulationError(f"{self.name}: invalid input channel {ch!r}")
            out.u[ch] = u
        return out

    def check_determinism(self, params: Mapping[str, float], experiment: str | Mapping, seed: int | None = None) -> bool:
        """Two calls with the same inputs (and seed) must return identical arrays."""
        a = self(params, experiment, seed=seed)
        b = self(params, experiment, seed=seed)
        return all(np.array_equal(a[k], b[k]) for k in a)

    def with_bias(self, channel: str, lo: float, hi: float) -> "Simulator":
        """A variant with a constant sensor offset ``bias_<channel>`` added to one output."""
        if not lo < 0 < hi:
            raise ValueError("bias bounds must straddle zero")
        base = self
        pname = f"bias_{channel}"

        def fn(params, experiment, options=None):
            inner = {k: v for k, v in params.items() if k != pname}
            out = dict(base.fn(inner, experiment, options=options) if _accepts_options(base.fn) else base.fn(inner, experiment))
            out[channel] = np.asarray(out[channel], dtype=float) + params[pname]
            return out

        return Simulator(
            fn=fn,
            params={**self.params, pname: ParamSpec(pname, "output units of " + channel, float(lo), float(hi))},
            experiments=self.experiments,
            name=f"{self.name}+bias_{channel}",
            outputs=self.outputs,
            stochastic=self.stochastic,
            _hash="sha256:" + hashlib.sha256((self.source_hash + "+bias:" + channel).encode()).hexdigest(),
        )

    def with_fixed(self, **fixed: float) -> "Simulator":
        """A simulator over the remaining parameters, with ``fixed`` held constant."""
        for k, v in fixed.items():
            if k not in self.params:
                raise BoundsError(f"{self.name}: cannot fix unknown parameter {k}")
        base = self

        def fn(params, experiment, options=None):
            full = {**fixed, **params}
            return base.fn(full, experiment, options=options) if _accepts_options(base.fn) else base.fn(full, experiment)

        return Simulator(
            fn=fn,
            params={k: v for k, v in self.params.items() if k not in fixed},
            experiments=self.experiments,
            name=f"{self.name}[fixed {','.join(sorted(fixed))}]",
            outputs=self.outputs,
            stochastic=self.stochastic,
            _hash="sha256:" + hashlib.sha256((self.source_hash + json.dumps(fixed, sort_keys=True)).encode()).hexdigest(),
        )


def _accepts_options(fn: Callable) -> bool:
    try:
        return "options" in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def simulator(
    params: Mapping[str, tuple[str, float, float]],
    experiments: Mapping[str, Mapping[str, Any]] | None = None,
    *,
    outputs: tuple[str, ...] | list[str] = (),
    stochastic: bool = False,
    name: str | None = None,
    display=None,
) -> Callable[[Callable[..., dict]], Simulator]:
    """Decorator: ``@simulator(params={"k": ("N/m", 0.5, 100)}, experiments={...})``."""
    specs = {}
    for k, v in params.items():
        if not (isinstance(v, (tuple, list)) and len(v) == 3):
            raise ValueError(f"parameter {k}: expected (unit, lo, hi)")
        unit, lo, hi = v
        specs[k] = ParamSpec(k, str(unit), float(lo), float(hi))
    catalog = {n: _validate_experiment(n, s) for n, s in (experiments or {}).items()}

    def wrap(fn: Callable[..., dict]) -> Simulator:
        sim = Simulator(
            fn=fn,
            params=specs,
            experiments=catalog,
            name=name or fn.__name__,
            outputs=tuple(outputs),
            stochastic=stochastic,
            description=(inspect.getdoc(fn) or "").split("\n")[0],
        )
        return sim.with_display(display) if display is not None else sim

    return wrap
