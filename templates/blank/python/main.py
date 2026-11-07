"""A starting point: one model, synthetic data, a fit and an identifiability check.

    python main.py

Replace `decay` with your simulator and the synthetic observation with your
measurements. The SDK reference is sdks/python/README.md in the autophys repo.
"""
from __future__ import annotations

import numpy as np

import autophys as ap


@ap.simulator(
    params={"k": ("1/s", 1e-3, 10.0), "y0": ("V", 0.1, 10.0)},
    outputs=("y",),
    name="decay",
)
def decay(params, experiment, options=ap.FIT_OPTIONS):
    """y(t) = y0 * exp(-k t), sampled at the experiment's times."""
    t = np.asarray(experiment["t"], dtype=float)
    return {"t": t, "y": params["y0"] * np.exp(-params["k"] * t)}


def main() -> None:
    t = np.linspace(0.0, 10.0, 101)
    settings = {"kind": "measured", "t": t}
    truth = {"k": 0.4, "y0": 2.0}
    sigma = 0.01
    y = decay(truth, settings)["y"] + np.random.default_rng(0).normal(0.0, sigma, t.shape)
    obs = ap.Observation(experiment="measured", settings=settings, t=t, y={"y": y}, sigma={"y": sigma})

    fit = ap.fit(decay, [obs], n_starts=4)
    report, _ = ap.analyze(decay, fit.params, [obs])
    print(f"fit: chi2/N = {fit.chi2_per_n:.2f}")
    for name in decay.params:
        verdict = "identified" if name in report.identified else "NOT identified"
        print(f"  {name:3s} = {fit.params[name]:.5g}  (true {truth[name]:g})  {verdict}")


if __name__ == "__main__":
    main()
