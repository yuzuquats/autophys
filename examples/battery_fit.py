"""Fit a first-order battery model to your own pulse data and plot the curve.

    python examples/battery_fit.py --demo                 # synthetic cell, known answer
    python examples/battery_fit.py my_cell.csv --sigma 0.002

The CSV needs time (s), current (A, positive = discharging) and voltage (V)
columns. Any current trace works: pulses, rests, drive cycles. The model is

    V = OCV(SOC) - V1 - I*R0,   dV1/dt = -V1/(R1*C1) + I/C1,   dSOC/dt = -I/(3600*Q)

with Q, the starting SOC and the OCV curve known, and R0, R1, C1 fitted.
autophys then says which of the three your data actually pins down (better
than ±10%), and which are traded off against each other.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

import numpy as np

import autophys as ap
from autophys.models.battery import OCV_SOC, OCV_V

TRUTH = {"R0": 0.025, "R1": 0.045, "C1": 1600.0}  # used only by --demo


def load_ocv(path: str | None) -> tuple[np.ndarray, np.ndarray]:
    """A soc,voltage CSV for your cell; default: a generic NMC-like table."""
    if path is None:
        return OCV_SOC, OCV_V
    rows = np.loadtxt(path, delimiter=",", skiprows=1)
    order = np.argsort(rows[:, 0])
    return rows[order, 0], rows[order, 1]


def make_model(ocv_soc: np.ndarray, ocv_v: np.ndarray) -> ap.Simulator:
    @ap.simulator(
        params={"R0": ("ohm", 1e-3, 0.5), "R1": ("ohm", 1e-3, 0.5), "C1": ("F", 10.0, 1e5)},
        outputs=("v",),
        name="battery_1rc_measured_current",
    )
    def cell(params, experiment, options=ap.FIT_OPTIONS):
        """1RC cell driven by a measured current trace (zero-order hold, exact update)."""
        t = np.asarray(experiment["t"], dtype=float)
        i = np.asarray(experiment["i"], dtype=float)
        r0, r1, c1 = params["R0"], params["R1"], params["C1"]
        dt = np.diff(t, prepend=t[0])
        soc = experiment["soc0"] - np.cumsum(np.r_[0.0, i[:-1] * dt[1:]]) / (3600.0 * experiment["capacity_ah"])
        decay = np.exp(-dt / (r1 * c1))
        v1 = np.zeros_like(t)
        for k in range(1, len(t)):
            v1[k] = v1[k - 1] * decay[k] + r1 * (1.0 - decay[k]) * i[k - 1]
        return {"t": t, "v": np.interp(soc, ocv_soc, ocv_v) - v1 - i * r0}

    return cell


def read_csv(path: str, columns: tuple[str, str, str]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    with open(path, newline="") as f:
        rows = list(csv.DictReader(f))
    missing = [c for c in columns if rows and c not in rows[0]]
    if not rows or missing:
        sys.exit(f"{path}: need columns {columns}; missing {missing or 'all rows'}")
    t, i, v = (np.array([float(r[c]) for r in rows]) for c in columns)
    if np.any(np.diff(t) <= 0):
        sys.exit(f"{path}: time must strictly increase")
    return t, i, v


def write_demo(path: Path, model: ap.Simulator, sigma: float, capacity: float, soc0: float) -> None:
    """A made-up test: two discharge pulses, a charge pulse and rests, with sensor noise."""
    t = np.arange(0.0, 900.0, 0.5)
    i = np.select([(t >= 30) & (t < 60), (t >= 300) & (t < 420), (t >= 600) & (t < 630)], [2.0, 1.0, -1.5], 0.0)
    v = model(TRUTH, {"kind": "measured", "t": t, "i": i, "capacity_ah": capacity, "soc0": soc0})["v"]
    v = v + np.random.default_rng(0).normal(0.0, sigma, v.shape)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(("time", "current", "voltage"))
        w.writerows(zip(t, i, np.round(v, 5)))
    print(f"wrote {path}: {len(t)} samples, true R0={TRUTH['R0']} R1={TRUTH['R1']} C1={TRUTH['C1']}")


def plot(path: str, t, i, v, v_fit, title: str) -> None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        sys.exit("plotting needs matplotlib: pip install matplotlib")
    fig, (ax_v, ax_r, ax_i) = plt.subplots(3, 1, sharex=True, figsize=(9, 7), height_ratios=[3, 1, 1])
    ax_v.plot(t, v, ".", ms=2, color="0.6", label="measured")
    ax_v.plot(t, v_fit, "-", lw=1.5, color="C0", label="fitted model")
    ax_v.set_ylabel("voltage (V)")
    ax_v.set_title(title, fontsize=10)
    ax_v.legend()
    ax_r.plot(t, (v - v_fit) * 1e3, ".", ms=2, color="C3")
    ax_r.axhline(0, color="0.3", lw=0.8)
    ax_r.set_ylabel("residual (mV)")
    ax_i.step(t, i, where="post", color="0.2", lw=1)
    ax_i.set_ylabel("current (A)")
    ax_i.set_xlabel("time (s)")
    fig.tight_layout()
    fig.savefig(path, dpi=150)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv", nargs="?", help="time,current,voltage CSV (omit with --demo)")
    p.add_argument("--demo", action="store_true", help="write demo.csv from a known cell, then fit it")
    p.add_argument("--sigma", type=float, default=0.002, help="voltage noise standard deviation, V (default 0.002)")
    p.add_argument("--capacity-ah", type=float, default=2.5, help="cell capacity, Ah (default 2.5)")
    p.add_argument("--soc0", type=float, default=0.9, help="state of charge at t=0, 0..1 (default 0.9)")
    p.add_argument("--ocv", help="soc,voltage CSV of your cell's open-circuit voltage (default: generic NMC)")
    p.add_argument("--columns", default="time,current,voltage", help="CSV column names for t, I, V")
    p.add_argument("--out", default="fit.png", help="plot file (default fit.png)")
    a = p.parse_args()

    model = make_model(*load_ocv(a.ocv))
    path = a.csv
    if a.demo:
        path = path or "demo.csv"
        write_demo(Path(path), model, a.sigma, a.capacity_ah, a.soc0)
    if not path:
        p.error("give a CSV path, or --demo")

    t, i, v = read_csv(path, tuple(a.columns.split(",")))
    settings = {"kind": "measured", "t": t, "i": i, "capacity_ah": a.capacity_ah, "soc0": a.soc0}
    obs = ap.Observation(experiment="measured", settings=settings, t=t, y={"v": v}, sigma={"v": a.sigma})

    fit = ap.fit(model, [obs], n_starts=8)
    report, _ = ap.analyze(model, fit.params, [obs])
    v_fit = model(fit.params, settings)["v"]

    print(f"\nfit: chi2/N = {fit.chi2_per_n:.2f} ({'converged' if fit.success else 'NOT converged'}; ~1 means the residuals match sigma)")
    for name, spec in model.params.items():
        log_std = report.marginal_log_std[name]
        spread = f"±{100 * np.expm1(log_std):.1f}%" if log_std < np.log(10) else "unbounded"
        verdict = "identified" if name in report.identified else "NOT identified"
        print(f"  {name:3s} = {fit.params[name]:.5g} {spec.unit:4s}  {spread:>9s}  {verdict}")
    for d in report.non_identifiable_directions:
        print(f"  tied: {d.combination} ({d.kind})")
    if fit.at_bounds:
        print(f"  at bounds: {', '.join(fit.at_bounds)}: widen the range or check units")
    plot(a.out, t, i, v, v_fit, f"{Path(path).name}: chi2/N {fit.chi2_per_n:.2f}, identified {', '.join(report.identified) or 'none'}")
    print(f"\nplot: {a.out}")


if __name__ == "__main__":
    main()
