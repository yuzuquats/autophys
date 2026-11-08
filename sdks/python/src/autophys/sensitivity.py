"""Local sensitivity and the identifiability rule.

The Jacobian ``J[i, j] = d r_i / d x_j`` is taken by central differences of
the weighted residuals ``r = (y - f) / sigma`` in fitting coordinates ``x``:
``log(theta)`` for positive parameters, ``theta / (hi - lo)`` otherwise. For
log coordinates a unit step is a factor of e, so ``1 / s_i`` for a singular
value ``s_i`` of ``J`` is the one-sigma uncertainty of the log of the
combination ``prod(theta_j ** v_ij)`` along right singular vector ``v_i``
(Gauss-Newton / Laplace approximation, known sigma).

Identifiability rule (documented, applied in code, and enforced by the
agent guardrail):

1. **Structural**: direction ``i`` is non-identifiable when
   ``s_i < rel_tol * s_max`` (default ``rel_tol = 1e-3``); the data cannot
   distinguish movement along it at any noise level the Jacobian resolves.
2. **Practical**: direction ``i`` is non-identifiable when
   ``1 / s_i > max_log_std`` (default 0.1: worse than about ±10 % at one
   sigma).
3. Parameter ``j`` is **uniquely identified** only if every non-identifiable
   direction loads on it by at most ``loading_tol`` (``|v_ij| <= 0.2``) and its
   marginal standard deviation over the identifiable directions,
   ``sqrt(sum_i (v_ij / s_i) ** 2)``, is at most ``max_log_std``.

A non-identifiable direction is reported as the combination of parameters
that may change together without changing the prediction, with exponents
normalised so the largest is 1 (``m^1 c^1 k^1`` means scaling all three by
the same factor).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Mapping, Sequence

import numpy as np

from .data import Observation
from .fit import residuals
from .simulator import FIT_OPTIONS, SimOptions, Simulator


@dataclass(frozen=True)
class IdentifiabilityRule:
    rel_tol: float = 1e-3
    max_log_std: float = 0.1
    loading_tol: float = 0.2

    def describe(self) -> str:
        return (
            f"direction non-identifiable if s_i < {self.rel_tol:g}*s_max (structural) or 1/s_i > {self.max_log_std:g} "
            f"(practical); parameter identified iff |loading| <= {self.loading_tol:g} on every such direction and "
            f"marginal log-std <= {self.max_log_std:g}"
        )


DEFAULT_RULE = IdentifiabilityRule()


@dataclass
class Direction:
    singular_value: float
    log_std: float
    vector: dict[str, float]
    kind: str  # "identifiable" | "structural" | "practical"
    combination: str


@dataclass
class SensitivityReport:
    params: list[str]
    singular_values: list[float]
    condition_number: float
    directions: list[Direction]
    marginal_log_std: dict[str, float]
    identified: list[str]
    non_identified: list[str]
    rule: str
    at: dict[str, float] = field(default_factory=dict)

    @property
    def non_identifiable_directions(self) -> list[Direction]:
        return [d for d in self.directions if d.kind != "identifiable"]

    def to_dict(self) -> dict:
        return asdict(self)


def identification(report: SensitivityReport) -> dict:
    """The recorded summary of a report: the one shape every step that checks identifiability writes.

    ``marginal_log_std`` is each parameter's one-sigma log uncertainty, null
    (the report's ``inf``) for a parameter on a ridge, so records stay strict JSON.
    """
    return {
        "condition_number": report.condition_number,
        "identified": report.identified,
        "non_identified": report.non_identified,
        "non_identifiable": [d.combination for d in report.non_identifiable_directions],
        "marginal_log_std": {n: float(v) if np.isfinite(v) else None for n, v in report.marginal_log_std.items()},
    }


def jacobian(
    sim: Simulator,
    params: Mapping[str, float],
    observations: Sequence[Observation],
    *,
    step: float = 1e-4,
    options: SimOptions = FIT_OPTIONS,
) -> np.ndarray:
    """Central-difference Jacobian of the weighted residuals in fitting coordinates.

    Steps that would cross a bound are clipped to the bound and the difference
    is taken over the actual span.
    """
    x = sim.to_x(params)
    lo, hi = sim.x_bounds()
    cols = []
    for j in range(len(x)):
        xp, xm = x.copy(), x.copy()
        xp[j] = min(x[j] + step, hi[j])
        xm[j] = max(x[j] - step, lo[j])
        rp = residuals(sim, sim.from_x(xp), observations, options)
        rm = residuals(sim, sim.from_x(xm), observations, options)
        # r = (y - f)/sigma, so dr/dx = -df/dx/sigma; sign is irrelevant for J^T J and SVD
        cols.append((rp - rm) / (xp[j] - xm[j]))
    return np.column_stack(cols)


def combination(names: Sequence[str], v: np.ndarray, floor: float = 0.1) -> str:
    vmax = np.max(np.abs(v))
    if vmax == 0:
        return "(none)"
    w = v / v[np.argmax(np.abs(v))]
    terms = [f"{n}^{w_j:.2g}" for n, w_j in zip(names, w) if abs(w_j) >= floor]
    return " * ".join(terms)


def analyze(
    sim: Simulator,
    params: Mapping[str, float],
    observations: Sequence[Observation],
    *,
    rule: IdentifiabilityRule = DEFAULT_RULE,
    jac: np.ndarray | None = None,
) -> tuple[SensitivityReport, np.ndarray]:
    """Return the identifiability report and the Jacobian it was computed from."""
    J = jacobian(sim, params, observations) if jac is None else jac
    return report_from_jacobian(sim.param_names, J, rule, params), J


def report_from_jacobian(
    names: Sequence[str], J: np.ndarray, rule: IdentifiabilityRule = DEFAULT_RULE, at: Mapping[str, float] | None = None
) -> SensitivityReport:
    _, s, vt = np.linalg.svd(J, full_matrices=False)
    p = len(names)
    s_full = np.zeros(p)
    s_full[: len(s)] = s
    vt_full = vt if vt.shape[0] == p else np.vstack([vt, np.zeros((p - vt.shape[0], p))])
    s_max = float(s_full.max()) if p else 0.0
    directions = []
    for i in range(p):
        si = float(s_full[i])
        v = vt_full[i]
        log_std = float("inf") if si <= 0 else 1.0 / si
        if si < rule.rel_tol * s_max or s_max == 0:
            kind = "structural"
        elif log_std > rule.max_log_std:
            kind = "practical"
        else:
            kind = "identifiable"
        directions.append(
            Direction(si, log_std, {n: float(c) for n, c in zip(names, v)}, kind, combination(names, v))
        )
    marg = {}
    identified, non_identified = [], []
    for j, n in enumerate(names):
        var = sum((d.vector[n] / d.singular_value) ** 2 for d in directions if d.kind == "identifiable")
        loads = [abs(d.vector[n]) for d in directions if d.kind != "identifiable"]
        marg[n] = float(np.sqrt(var)) if not loads or max(loads) <= rule.loading_tol else float("inf")
        if marg[n] <= rule.max_log_std:
            identified.append(n)
        else:
            non_identified.append(n)
    s_min = float(s_full.min()) if p else 0.0
    return SensitivityReport(
        params=list(names),
        singular_values=[float(v) for v in s_full],
        condition_number=float("inf") if s_min == 0 else s_max / s_min,
        directions=directions,
        marginal_log_std=marg,
        identified=identified,
        non_identified=non_identified,
        rule=rule.describe(),
        at=dict(at or {}),
    )
