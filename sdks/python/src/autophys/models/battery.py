"""First-order Thevenin equivalent circuit of a battery cell.

    dSOC/dt = -I / (3600 Q)
    dV1/dt  = -V1 / (R1 C1) + I / C1
    V       = OCV(SOC) - V1 - I R0

I > 0 discharges. Capacity Q (Ah), initial SOC and the OCV curve are known
and come from the experiment (defaults below); R0, R1, C1 are fitted.
"""

from __future__ import annotations

import numpy as np

from ..display import Display
from ..simulator import FIT_OPTIONS, SimOptions, simulator, time_grid
from ._ode import integrate

#: A smooth NMC-like open-circuit voltage table (SOC, volts).
OCV_SOC = np.array([0.0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0])
OCV_V = np.array([3.00, 3.30, 3.45, 3.56, 3.62, 3.67, 3.72, 3.79, 3.88, 3.97, 4.06, 4.12, 4.20])

KNOWN = {"capacity_ah": 2.5, "soc0": 0.9}

CATALOG = {
    "discharge_1A": {"kind": "constant", "current": 1.0, "duration": 600.0, "rate": 1.0, **KNOWN},
    "pulse_2A": {"kind": "pulse", "current": 2.0, "on": 30.0, "duration": 300.0, "rate": 2.0, **KNOWN},
    "pulse_train": {"kind": "pulse_train", "current": 2.0, "on": 10.0, "off": 20.0, "duration": 300.0, "rate": 2.0, **KNOWN},
}


def ocv(soc):
    return np.interp(soc, OCV_SOC, OCV_V)


def current(experiment: dict):
    kind = experiment["kind"]
    i = float(experiment["current"])
    if kind == "constant":
        return lambda t: i
    if kind == "pulse":
        on = float(experiment["on"])
        return lambda t: i if t < on else 0.0
    if kind == "pulse_train":
        on, off = float(experiment["on"]), float(experiment["off"])
        return lambda t: i if (t % (on + off)) < on else 0.0
    raise ValueError(f"battery_ecm: unknown experiment kind {kind!r}")


@simulator(
    params={"R0": ("ohm", 1e-3, 0.5), "R1": ("ohm", 1e-3, 0.5), "C1": ("F", 10.0, 1e5)},
    experiments=CATALOG,
    outputs=("v",),
    name="battery_ecm",
)
def battery_ecm(params, experiment, options: SimOptions = FIT_OPTIONS):
    """Terminal voltage v(t) of a first-order Thevenin cell model."""
    r0, r1, c1 = params["R0"], params["R1"], params["C1"]
    q = float(experiment.get("capacity_ah", KNOWN["capacity_ah"]))
    t = time_grid(experiment)
    cur = current(experiment)
    on = float(experiment.get("on", experiment["duration"]))
    max_step = on / 4

    def rhs(tt, y):
        i = cur(tt)
        return (-i / (3600.0 * q), -y[1] / (r1 * c1) + i / c1)

    y = integrate(rhs, (float(experiment.get("soc0", KNOWN["soc0"])), 0.0), t, options, max_step=max_step)
    i_t = np.array([cur(tt) for tt in t])
    return {"t": t, "v": ocv(y[0]) - y[1] - i_t * r0}


# Attach below the decorated function: presentation never changes its source hash.

def _display_input(experiment, t):
    drive = current(experiment)
    return np.array([drive(tt) for tt in t])


battery_ecm.with_display(Display(
    channels={'v': {'label': 'Terminal voltage', 'unit': 'V', 'role': 'output'},
     'i': {'label': 'Current', 'unit': 'A', 'role': 'input'}},
    settings={'current': {'label': 'Current', 'unit': 'A', 'role': 'drive'},
     'on': {'label': 'On', 'unit': 's', 'role': 'drive'},
     'off': {'label': 'Off', 'unit': 's', 'role': 'drive'},
     'duration': {'label': 'Duration', 'unit': 's', 'role': 'sampling'},
     'rate': {'label': 'Rate', 'unit': 'Hz', 'role': 'sampling'},
     'capacity_ah': {'label': 'Capacity', 'unit': 'Ah', 'role': 'known'},
     'soc0': {'label': 'SOC₀', 'unit': '', 'role': 'known'}},
    experiments={'discharge_1A': {'label': 'Discharge at 1 A', 'description': '', 'views': []},
     'pulse_2A': {'label': 'Pulse at 2 A', 'description': '', 'views': ['edges']},
     'pulse_train': {'label': 'Pulse train', 'description': '', 'views': ['edges']}},
    default_view='fit',
    inputs={'i': _display_input},
))
