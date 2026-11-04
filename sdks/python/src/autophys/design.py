"""Experiment ranking by Fisher information.

At the current estimate, the information already in hand is
``F0 = J0^T J0`` (``J0`` the weighted Jacobian of the existing training data
in fitting coordinates). A candidate experiment ``e`` adds ``F_e = J_e^T J_e``,
its Jacobian simulated at the estimate with the dataset's declared channel
noise. Two criteria are reported for ``F = F0 + F_e``:

* ``min_eig`` (E-optimality, the default ranking): the smallest eigenvalue
  of ``F``, i.e. ``1 / std^2`` of the worst-determined direction after the
  experiment. Repeating an experiment that leaves a direction unresolved
  scores about zero however much data it adds.
* ``d_opt`` (D-optimality): ``log det(F + eps I) - log det(F0 + eps I)``, the
  log volume shrink of the confidence ellipsoid, with a small ridge ``eps``
  (``1e-9 * trace(F0)``) so a singular ``F0`` stays finite.
"""

from __future__ import annotations

import itertools
from dataclasses import asdict, dataclass
from typing import Mapping, Sequence

import numpy as np

from .data import Observation
from .sensitivity import jacobian
from .simulator import Simulator, time_grid


@dataclass
class Candidate:
    experiment: str
    min_eig: float
    d_opt: float
    min_eig_gain: float
    worst_direction: dict[str, float]

    def to_dict(self) -> dict:
        return asdict(self)


def _template(sim: Simulator, name: str, settings: dict, noise: Mapping[str, float], params) -> Observation:
    """A zero-valued observation on the candidate's grid; only its shape and sigma matter."""
    t = time_grid(settings)
    pred = sim(params, settings)
    chans = [k for k in pred if k != "t"]
    missing = [c for c in chans if c not in noise]
    if missing:
        raise ValueError(f"no declared sigma for channel(s) {missing}; add an observation of them first")
    return Observation(name, settings, t, {c: np.zeros_like(t) for c in chans}, {c: noise[c] for c in chans})


def fisher(J: np.ndarray) -> np.ndarray:
    return J.T @ J


def rank_experiments(
    sim: Simulator,
    params: Mapping[str, float],
    observations: Sequence[Observation],
    noise: Mapping[str, float],
    *,
    candidates: Sequence[str] | None = None,
    criterion: str = "min_eig",
    J0: np.ndarray | None = None,
) -> list[Candidate]:
    if criterion not in ("min_eig", "d_opt"):
        raise ValueError("criterion must be min_eig or d_opt")
    p = len(sim.params)
    if J0 is None:
        J0 = jacobian(sim, params, observations) if observations else np.zeros((0, p))
    F0 = fisher(J0)
    eps = 1e-9 * max(float(np.trace(F0)), 1.0)
    ridge = eps * np.eye(p)
    _, logdet0 = np.linalg.slogdet(F0 + ridge)
    lam0 = float(np.linalg.eigvalsh(F0)[0]) if p else 0.0
    out = []
    for name in candidates or list(sim.experiments):
        settings = sim.experiment(name)
        tmpl = _template(sim, name, settings, noise, params)
        Je = jacobian(sim, params, [tmpl])
        F = F0 + fisher(Je)
        w, V = np.linalg.eigh(F)
        _, logdet = np.linalg.slogdet(F + ridge)
        out.append(
            Candidate(
                experiment=name,
                min_eig=float(max(w[0], 0.0)),
                d_opt=float(logdet - logdet0),
                min_eig_gain=float(max(w[0], 0.0) - max(lam0, 0.0)),
                worst_direction={n: float(c) for n, c in zip(sim.param_names, V[:, 0])},
            )
        )
    out.sort(key=lambda c: getattr(c, criterion), reverse=True)
    return out


# --------------------------------------------------------------------------
# Outlook (E-1): the score and expected uncertainties over a settings grid,
# precomputed so a browser can re-score an edited proposal by interpolation
# without running a simulation.

OUTLOOK_POINTS = 12
OUTLOOK_MAX_AXES = 3


def settings_score(
    sim: Simulator,
    params: Mapping[str, float],
    F0: np.ndarray,
    noise: Mapping[str, float],
    settings: dict,
    *,
    criterion: str = "min_eig",
) -> tuple[float, dict[str, float]]:
    """Score one experiment's settings as :func:`rank_experiments` does, plus
    the expected one-sigma uncertainty of each parameter after it.

    The uncertainty is ``sqrt(diag(F^-1))`` in fitting coordinates: for a log
    parameter that is its relative uncertainty, for a linear one a fraction of
    its declared range. Eigenvalues below the ridge ``1e-9 * trace(F0)`` (the
    one ``d_opt`` uses) are floored at it, so an unresolved direction gives a
    large finite value instead of infinity.
    """
    if criterion not in ("min_eig", "d_opt"):
        raise ValueError("criterion must be min_eig or d_opt")
    p = len(sim.params)
    eps = 1e-9 * max(float(np.trace(F0)), 1.0)
    tmpl = _template(sim, "<outlook>", settings, noise, params)
    F = F0 + fisher(jacobian(sim, params, [tmpl]))
    w, V = np.linalg.eigh(F)
    if criterion == "min_eig":
        score = float(max(w[0], 0.0))
    else:
        ridge = eps * np.eye(p)
        _, logdet0 = np.linalg.slogdet(F0 + ridge)
        _, logdet = np.linalg.slogdet(F + ridge)
        score = float(logdet - logdet0)
    std = np.sqrt((V ** 2) @ (1.0 / np.maximum(w, eps)))
    return score, {n: float(s) for n, s in zip(sim.param_names, std)}


def _axis(name: str, lo: float, hi: float, value: float, points: int) -> list[float]:
    """``points`` evenly spaced values over ``[lo, hi]``, with the proposed
    ``value`` itself on the axis: it replaces a grid point it coincides with,
    otherwise it is inserted (the axis then has ``points + 1`` values)."""
    vals = [float(v) for v in np.linspace(lo, hi, points)]
    tol = 1e-12 * max(abs(hi - lo), 1e-300)
    for i, v in enumerate(vals):
        if abs(v - value) <= tol:
            vals[i] = value
            return vals
    vals.append(value)
    vals.sort()
    return vals


def outlook(
    sim: Simulator,
    params: Mapping[str, float],
    observations: Sequence[Observation],
    noise: Mapping[str, float],
    settings: dict,
    edit: Mapping[str, Sequence[float]],
    *,
    criterion: str = "min_eig",
    points: int = OUTLOOK_POINTS,
    J0: np.ndarray | None = None,
) -> tuple[dict, float, dict[str, float]]:
    """The outlook of one proposed experiment.

    Returns ``(outlook, score, after)``: ``outlook`` is
    ``{axes: [{name, values}], score: [...], after: {param: [...]}}`` with
    ``score`` and each ``after[param]`` row-major over ``axes`` (last axis
    fastest); ``score`` and ``after`` are the proposal's own values at
    ``settings``, computed independently of the grid. ``edit`` maps each
    editable setting to its ``[lo, hi]`` limits (at most
    :data:`OUTLOOK_MAX_AXES`); with no editable setting the grid is the single
    proposed point.
    """
    if len(edit) > OUTLOOK_MAX_AXES:
        raise ValueError(f"at most {OUTLOOK_MAX_AXES} editable settings, got {len(edit)}")
    if points < 2:
        raise ValueError("an outlook axis needs at least 2 points")
    p = len(sim.params)
    if J0 is None:
        J0 = jacobian(sim, params, observations) if observations else np.zeros((0, p))
    F0 = fisher(J0)
    score, after = settings_score(sim, params, F0, noise, settings, criterion=criterion)
    names = list(edit)
    axes = [{"name": n, "values": _axis(n, float(edit[n][0]), float(edit[n][1]), float(settings[n]), points)} for n in names]
    grid_score: list[float] = []
    grid_after: dict[str, list[float]] = {n: [] for n in sim.param_names}
    for combo in itertools.product(*(a["values"] for a in axes)):
        s = dict(settings)
        s.update(zip(names, combo))
        sc, af = settings_score(sim, params, F0, noise, s, criterion=criterion)
        grid_score.append(sc)
        for n, v in af.items():
            grid_after[n].append(v)
    return {"axes": axes, "score": grid_score, "after": grid_after}, score, after
