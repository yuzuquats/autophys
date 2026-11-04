"""Weighted least-squares calibration.

Objective: ``sum(((y - f(theta)) / sigma) ** 2)`` over every finite sample of
every channel of the chosen observations. Positive parameters are optimised
in log space and the rest in range-scaled linear space (see
:class:`~autophys.simulator.ParamSpec`), always within the declared bounds.
``scipy.optimize.least_squares`` (trust-region reflective) runs from the
current estimate, if any, and from Latin-hypercube starts over the bounds;
the lowest-loss converged start wins.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Iterable, Mapping, Sequence

import numpy as np
from scipy.optimize import least_squares
from scipy.stats import qmc

from .data import Observation
from .simulator import FIT_OPTIONS, SimOptions, SimulationError, Simulator

#: Residual assigned to every sample when the simulator fails at a trial point.
FAILED_RESIDUAL = 1e6


def residuals(
    sim: Simulator,
    params: Mapping[str, float],
    observations: Sequence[Observation],
    options: SimOptions = FIT_OPTIONS,
) -> np.ndarray:
    """Concatenated weighted residuals (y - f) / sigma over finite samples."""
    parts = []
    for obs in observations:
        pred = sim(params, obs.settings, options=options)
        for ch, y in obs.y.items():
            m = np.isfinite(y)
            if pred[ch].shape != y.shape:
                raise SimulationError(f"prediction for {obs.experiment}/{ch} does not match its time grid")
            parts.append((y[m] - pred[ch][m]) / obs.sigma[ch])
    return np.concatenate(parts) if parts else np.zeros(0)


def n_residuals(observations: Iterable[Observation]) -> int:
    return sum(o.n_samples for o in observations)


@dataclass
class StartResult:
    x0: list[float]
    loss: float
    nfev: int
    status: int
    success: bool


@dataclass
class FitResult:
    params: dict[str, float]
    loss: float  # sum of squared weighted residuals (robust-loss fits report the plain sum too)
    chi2_per_n: float
    n: int
    nfev: int
    status: int
    message: str
    success: bool
    loss_kind: str
    at_bounds: list[str]
    starts: list[StartResult] = field(default_factory=list)
    dataset_version: int | None = None
    source_hash: str = ""
    seed: int | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "FitResult":
        """Restore a fit, including its multistart results, from :meth:`to_dict`."""
        state = {k: v for k, v in d.items() if k != "curves"}
        state["starts"] = [StartResult(**s) for s in d.get("starts", [])]
        return cls(**state)


def _lhs_starts(sim: Simulator, n: int, seed: int) -> np.ndarray:
    lo, hi = sim.x_bounds()
    if n <= 0:
        return np.zeros((0, len(lo)))
    sample = qmc.LatinHypercube(d=len(lo), seed=seed).random(n)
    # keep starts off the hard bounds where trf behaves poorly
    return lo + (0.05 + 0.9 * sample) * (hi - lo)


def fit(
    sim: Simulator,
    observations: Sequence[Observation],
    *,
    initial: Mapping[str, float] | None = None,
    n_starts: int = 4,
    loss: str = "linear",
    f_scale: float = 1.0,
    seed: int = 0,
    max_nfev: int = 200,
    options: SimOptions = FIT_OPTIONS,
    dataset_version: int | None = None,
) -> FitResult:
    """Fit ``sim`` to ``observations``; see the module docstring for the objective."""
    if not observations:
        raise ValueError("fit needs at least one observation")
    lo, hi = sim.x_bounds()
    starts = []
    if initial is not None:
        starts.append(np.clip(sim.to_x(initial), lo, hi))
    starts.extend(_lhs_starts(sim, n_starts, seed))
    n = n_residuals(observations)

    def fun(x):
        try:
            return residuals(sim, sim.from_x(x), observations, options)
        except SimulationError:
            return np.full(n, FAILED_RESIDUAL)

    best = None
    records: list[StartResult] = []
    nfev = 0
    for x0 in starts:
        r = least_squares(
            fun,
            x0,
            bounds=(lo, hi),
            method="trf",
            loss=loss,
            f_scale=f_scale,
            x_scale="jac",
            diff_step=1e-6,
            max_nfev=max_nfev,
        )
        # least_squares counts function evaluations without the finite-difference Jacobian calls
        used = int(r.nfev + (r.njev or 0) * len(x0))
        nfev += used
        plain = float(np.sum(r.fun**2))
        records.append(StartResult([float(v) for v in x0], plain, used, int(r.status), bool(r.success)))
        if best is None or plain < best[1]:
            best = (r, plain)
    r, plain = best
    params = sim.from_x(r.x)
    span = hi - lo
    at_bounds = [k for k, x, a, b, s in zip(sim.params, r.x, lo, hi, span) if min(x - a, b - x) < 1e-6 * s]
    return FitResult(
        params=params,
        loss=plain,
        chi2_per_n=plain / max(n, 1),
        n=n,
        nfev=nfev,
        status=int(r.status),
        message=str(r.message),
        success=bool(r.success) and r.status > 0,
        loss_kind=loss,
        at_bounds=at_bounds,
        starts=records,
        dataset_version=dataset_version,
        source_hash=sim.source_hash,
        seed=seed,
    )
