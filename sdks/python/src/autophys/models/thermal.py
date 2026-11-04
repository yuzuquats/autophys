"""Lumped thermal RC: C dT/dt = P(t) - (T - Ta)/R."""

from __future__ import annotations

import numpy as np

from ..simulator import FIT_OPTIONS, SimOptions, simulator, time_grid
from ._ode import integrate

AMBIENT = 20.0

#: Power profiles in watts. A step holds power from t=0; a pulse holds it
#: for ``on`` seconds; a sine is offset so power stays non-negative.
CATALOG = {
    "step_short": {"kind": "step", "power": 10.0, "duration": 120.0, "rate": 1.0},
    "step_long": {"kind": "step", "power": 10.0, "duration": 3000.0, "rate": 0.2},
    "pulse": {"kind": "pulse", "power": 20.0, "on": 600.0, "duration": 3000.0, "rate": 0.2},
    "sine_slow": {"kind": "sine", "power": 10.0, "period": 2000.0, "duration": 3000.0, "rate": 0.2},
    "sine_fast": {"kind": "sine", "power": 10.0, "period": 100.0, "duration": 600.0, "rate": 1.0},
}


def power(experiment: dict):
    kind = experiment["kind"]
    p = float(experiment["power"])
    if kind == "step":
        return lambda t: p
    if kind == "pulse":
        on = float(experiment["on"])
        return lambda t: p if t < on else 0.0
    if kind == "sine":
        w = 2 * np.pi / float(experiment["period"])
        return lambda t: 0.5 * p * (1.0 - np.cos(w * t))
    raise ValueError(f"thermal_rc: unknown experiment kind {kind!r}")


@simulator(
    params={"C": ("J/K", 10.0, 1e5), "R": ("K/W", 0.01, 100.0)},
    experiments=CATALOG,
    outputs=("T",),
    name="thermal_rc",
)
def thermal_rc(params, experiment, options: SimOptions = FIT_OPTIONS):
    """Block temperature T(t) in degrees C, starting at ambient."""
    C, R = params["C"], params["R"]
    ta = float(experiment.get("ambient", AMBIENT))
    t = time_grid(experiment)
    p = power(experiment)
    max_step = float(experiment["on"]) / 4 if experiment["kind"] == "pulse" else np.inf

    def rhs(tt, y):
        return ((p(tt) - (y[0] - ta) / R) / C,)

    y = integrate(rhs, (float(experiment.get("T0", ta)),), t, options, max_step=max_step)
    return {"t": t, "T": y[0]}
