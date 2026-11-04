"""Mass-spring-damper: m x'' + c x' + k x = F(t)."""

from __future__ import annotations

import numpy as np

from ..simulator import FIT_OPTIONS, SimOptions, simulator, time_grid
from ._ode import integrate

BASE = {"duration": 10.0, "rate": 100.0}

#: Catalog. The free response starts displaced by x0 with no force; the
#: impulse is ideal (an initial velocity J/m at rest position).
CATALOG = {
    "free": {"kind": "free", "x0": 0.1, "v0": 0.0, **BASE},
    "step_2N": {"kind": "step", "amplitude": 2.0, **BASE},
    "impulse": {"kind": "impulse", "amplitude": 0.5, **BASE},
    "sine_0.1Hz": {"kind": "sine", "amplitude": 2.0, "freq": 0.1, **BASE},
    "sine_0.44Hz": {"kind": "sine", "amplitude": 2.0, "freq": 0.44, **BASE},
    "sine_2Hz": {"kind": "sine", "amplitude": 2.0, "freq": 2.0, **BASE},
}


def force(experiment: dict):
    kind = experiment["kind"]
    a = float(experiment.get("amplitude", 0.0))
    if kind == "step":
        return lambda t: a
    if kind == "sine":
        w = 2 * np.pi * float(experiment["freq"])
        return lambda t: a * np.sin(w * t)
    if kind in ("free", "impulse"):
        return lambda t: 0.0
    raise ValueError(f"oscillator: unknown experiment kind {kind!r}")


@simulator(
    params={"m": ("kg", 0.1, 20.0), "c": ("N*s/m", 0.01, 10.0), "k": ("N/m", 0.5, 100.0)},
    experiments=CATALOG,
    outputs=("x",),
    name="oscillator",
)
def oscillator(params, experiment, options: SimOptions = FIT_OPTIONS):
    """Mass-spring-damper position response x(t) in metres."""
    m, c, k = params["m"], params["c"], params["k"]
    t = time_grid(experiment)
    f = force(experiment)
    x0 = float(experiment.get("x0", 0.0))
    v0 = float(experiment.get("v0", 0.0))
    if experiment["kind"] == "impulse":
        v0 += float(experiment["amplitude"]) / m

    def rhs(tt, y):
        return (y[1], (f(tt) - c * y[1] - k * y[0]) / m)

    y = integrate(rhs, (x0, v0), t, options)
    return {"t": t, "x": y[0]}
