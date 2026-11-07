"""A two-parameter lab simulator for the worker tests: y = A exp(-k t).

It prints on import and on every call: the worker must keep user output off
its protocol stream.
"""
import numpy as np

import autophys as ap
from autophys.simulator import time_grid

print("decaylab imported")


@ap.simulator(
    params={"A": ("V", 0.1, 10.0), "k": ("1/s", 0.01, 10.0)},
    experiments={
        "short": {"kind": "decay", "duration": 2.0, "rate": 20.0},
        "long": {"kind": "decay", "duration": 10.0, "rate": 5.0},
    },
    outputs=("y",),
)
def decay(params, experiment):
    print("simulating", params["A"], params["k"])
    t = time_grid(experiment)
    return {"t": t, "y": params["A"] * np.exp(-params["k"] * t)}


project = ap.Project("decay_lab", decay, initial={"A": 1.0, "k": 0.5}, noise=ap.NoiseConfig(bias="off"))


@ap.simulator(params={"a": ("1", 0.1, 1.0)}, experiments={"e": {"kind": "x", "duration": 1.0, "rate": 2.0}}, outputs=("y",))
def crashes(params, experiment):
    import os

    print("about to fall over")
    os._exit(7)
