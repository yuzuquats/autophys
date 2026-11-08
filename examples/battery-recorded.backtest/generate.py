"""Synthesize the recorded runs of battery-recorded.backtest.

Runs the autophys battery model (1RC Thevenin cell) at a hidden cell's
parameters, adds 2 mV Gaussian voltage noise, and writes one CSV per cycler
program (time,voltage). The data is synthetic: it stands in for cycler
recordings until measured data that may be redistributed is available.

    PYTHONPATH=sdks/python/src python3 examples/battery-recorded.backtest/generate.py

prints the sha256 of each file, which example.toml and hidden/cases.toml
pin. Rerunning reproduces the same bytes.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np

from autophys.models.battery import KNOWN, battery_ecm
from autophys.synthetic import NoiseModel, observe

HERE = Path(__file__).resolve().parent
CELL = {"R0": 0.031, "R1": 0.052, "C1": 2100.0}  # the hidden cell
SIGMA = 0.002

RUNS = {
    # public: the starting data, the check, and the menu (the catalog programs)
    "pulse_short": {"kind": "pulse", "current": 2.0, "on": 6.0, "duration": 25.0, "rate": 32.0, **KNOWN},
    "check_1A": {"kind": "pulse", "current": 1.0, "on": 6.0, "duration": 25.0, "rate": 32.0, **KNOWN},
    "discharge_1A": battery_ecm.experiments["discharge_1A"],
    "pulse_2A": battery_ecm.experiments["pulse_2A"],
    "pulse_train": battery_ecm.experiments["pulse_train"],
    # hidden: held out to score prediction
    "unseen_train": {"kind": "pulse_train", "current": 1.5, "on": 40.0, "off": 60.0, "duration": 500.0,
                     "rate": 1.0, **KNOWN},
}


def main() -> None:
    out = HERE / "data"
    out.mkdir(exist_ok=True)
    for i, (name, settings) in enumerate(RUNS.items()):
        o = observe(battery_ecm, CELL, dict(settings), NoiseModel({"v": SIGMA}), np.random.default_rng([2026, i]),
                    name=name)
        text = "time,voltage\n" + "".join(f"{t!r},{v!r}\n" for t, v in zip(o.t.tolist(), o.y["v"].tolist()))
        (out / f"{name}.csv").write_text(text)
        print(f"{name}: {len(o.t)} samples sha256={hashlib.sha256(text.encode()).hexdigest()}")


if __name__ == "__main__":
    main()
