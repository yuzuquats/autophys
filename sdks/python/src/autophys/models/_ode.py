from __future__ import annotations

import numpy as np
from scipy.integrate import solve_ivp

from ..simulator import SimOptions, SimulationError


def integrate(rhs, y0, t: np.ndarray, options: SimOptions, max_step: float = np.inf) -> np.ndarray:
    """Integrate with DOP853 and return states sampled at ``t`` (shape [n, len(t)])."""
    sol = solve_ivp(
        rhs,
        (float(t[0]), float(t[-1])),
        np.asarray(y0, dtype=float),
        method="DOP853",
        t_eval=t,
        rtol=options.rtol,
        atol=options.atol,
        max_step=max_step,
    )
    if not sol.success:
        raise SimulationError(f"ODE solver failed: {sol.message}")
    return sol.y
