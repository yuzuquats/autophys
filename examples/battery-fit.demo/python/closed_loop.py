"""The closed loop: fit a starting test, propose the next cycler test, approve it, attach its data, refit.

    python closed_loop.py tests                   # the cycler tests the agent may propose
    python closed_loop.py start --simulate        # demo: a virtual cycler with a hidden cell
    python closed_loop.py start --data CELL.csv --test quick_pulse --sigma 0.002
    python closed_loop.py continue --simulate     # or --data NEXT.csv; add --wait to wait for approval

A person approves each proposal, in the browser or with the autophys CLI
(`autophys approve INVESTIGATION PROPOSAL`); `autophys investigations` shows
where it stands. Records go to AUTOPHYS_SERVER if it is set (connect this
device first with `autophys connect URL`), otherwise to a local workbook in
~/autophys. Settings are read from .env in this folder, if present. The policy that decides each step
is `scripted` (the built-in Fisher-ranking strategy, no network) or `model`
(a language model configured by AUTOPHYS_REASON_* in .env, reading the
autophys playbook). The fit, identifiability check and ranking always run here.

--simulate stands in for a cycler: it generates the requested test's voltage
from a hidden demo cell plus noise. Its data is synthetic and is labelled so.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path

import numpy as np

import autophys as ap
from autophys.models.battery import OCV_SOC, OCV_V
from autophys.simulator import time_grid
from autophys.synthetic import NoiseModel, observe

HERE = Path(__file__).resolve().parent
STATE = HERE / ".agent-state.json"


def load_env(path: Path = HERE / ".env") -> None:
    """KEY=VALUE lines from .env; variables already set in the environment win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        value = value.split(" #", 1)[0].strip().strip("\"'")
        if value:
            os.environ.setdefault(key.strip(), value)


load_env()
HIDDEN_CELL = {"R0": 0.025, "R1": 0.045, "C1": 1600.0}  # used only by --simulate
SIGMA = 0.002
CELL = {"capacity_ah": 2.5, "soc0": 0.9, "rate": 2.0}


def program(*steps: tuple[float, float]) -> dict:
    """A cycler program: (current A, positive = discharge; seconds) steps, sampled at 2 Hz."""
    return {"kind": "steps", "steps": [list(s) for s in steps], "duration": float(sum(s[1] for s in steps)), **CELL}


TESTS = {
    "quick_pulse": program((0, 10), (2.0, 30), (0, 4)),
    "pulse_rest": program((0, 10), (2.0, 30), (0, 600)),
    "pulse_ladder": program((0, 10), (1.0, 30), (0, 300), (2.0, 30), (0, 300), (-1.5, 30), (0, 300)),
    "cc_discharge": program((0, 10), (1.0, 900)),
}
# Held out: never fitted, only predicted. It is not in the catalog, so the agent cannot request it.
CHECK = program((0, 10), (1.5, 60), (0, 120), (-1.0, 60), (0, 120))


def programmed_current(settings: dict, t: np.ndarray) -> np.ndarray:
    """Current at each sample time; a step that ends at time T no longer applies at T."""
    edges = np.cumsum([0.0] + [s[1] for s in settings["steps"]])
    levels = np.array([s[0] for s in settings["steps"]] + [0.0])
    return levels[np.clip(np.searchsorted(edges, t, side="right") - 1, 0, len(levels) - 1)]


@ap.simulator(
    params={"R0": ("ohm", 1e-3, 0.5), "R1": ("ohm", 1e-3, 0.5), "C1": ("F", 10.0, 1e5)},
    experiments=TESTS,
    outputs=("v",),
    name="battery_1rc_cycler",
)
def cell(params, experiment, options=ap.FIT_OPTIONS):
    """1RC cell under a programmed current: V = OCV(SOC) - V1 - I*R0, exact update per sample."""
    t = time_grid(experiment)
    i = programmed_current(experiment, t)
    r0, r1, c1 = params["R0"], params["R1"], params["C1"]
    dt = np.diff(t, prepend=t[0])
    soc = experiment["soc0"] - np.cumsum(np.r_[0.0, i[:-1] * dt[1:]]) / (3600.0 * experiment["capacity_ah"])
    decay = np.exp(-dt / (r1 * c1))
    v1 = np.zeros_like(t)
    for k in range(1, len(t)):
        v1[k] = v1[k - 1] * decay[k] + r1 * (1.0 - decay[k]) * i[k - 1]
    return {"t": t, "v": np.interp(soc, OCV_SOC, OCV_V) - v1 - i * r0}


def project_name(folder: Path = HERE) -> str:
    """The name `autophys new` wrote into pyproject.toml; run from the repo, the demo keeps its own."""
    try:
        text = (folder / "pyproject.toml").read_text()
    except OSError:
        return "battery_cycler_demo"
    found = re.search(r'^name\s*=\s*"([^"]+)"', text.split("[project]", 1)[-1], re.M)
    return found.group(1) if found else "battery_cycler_demo"


project = ap.Project(
    project_name(), cell,
    noise=ap.NoiseConfig(bias="off"),
    initial={"R0": 0.03, "R1": 0.04, "C1": 1500.0},
    budgets=ap.Budgets(max_experiments=2),
)


# --- plumbing ---------------------------------------------------------------
def target() -> str | None:
    return os.environ.get("AUTOPHYS_SERVER") or None


def workbook():
    return ap.connect(target()).project(project)


def make_policy(kind: str):
    if kind == "scripted":
        return ap.ScriptedPolicy()
    from autophys.reasoner import reasoner_from_env
    return ap.ReasonLanePolicy(reasoner_from_env())


def load_state() -> dict:
    if not STATE.exists():
        sys.exit("no investigation yet: run `python closed_loop.py start --simulate` first")
    return json.loads(STATE.read_text())


def save_state(**kw) -> None:
    STATE.write_text(json.dumps(kw, indent=2) + "\n")


def resume(state: dict):
    return workbook().investigation(state["investigation"], policy=make_policy(state["policy"]))


def simulated(name: str, settings: dict, seed: int) -> ap.Observation:
    obs = observe(cell, HIDDEN_CELL, settings, NoiseModel({"v": SIGMA}), np.random.default_rng(seed), name=name)
    obs.source = "synthetic"
    obs.meta = {**obs.meta, "note": "virtual cycler: hidden demo cell plus noise, not a measurement"}
    return obs


def measured(path: str, name: str, settings: dict, sigma: float, columns: str, split: str = "train") -> ap.Observation:
    """Read time,current,voltage; resample voltage onto the program's grid and check the current matches it."""
    tc, ic, vc = columns.split(",")
    try:
        with open(path, newline="") as f:
            rows = list(csv.DictReader(f))
    except OSError as e:
        sys.exit(f"{path}: cannot read: {e.strerror or e}")
    if not rows or any(c not in rows[0] for c in (tc, ic, vc)):
        sys.exit(f"{path}: need columns {tc},{ic},{vc}")
    t, i, v = (np.array([float(r[c]) for r in rows]) for c in (tc, ic, vc))
    if np.any(np.diff(t) <= 0):
        sys.exit(f"{path}: time must strictly increase")
    grid = time_grid(settings)
    if t[0] > grid[0] + 0.5 or t[-1] < grid[-1] - 0.5:
        sys.exit(f"{path}: covers {t[0]:.1f}..{t[-1]:.1f} s; the {name} program runs 0..{grid[-1]:.0f} s")
    i_prog = programmed_current(settings, t)
    tol = 0.02 * np.max(np.abs(i_prog)) + 0.01
    off = np.abs(i - i_prog) > tol
    if off.mean() > 0.02:
        sys.exit(f"{path}: the current differs from the {name} program at {off.mean():.0%} of samples; "
                 "run the program as listed by `python closed_loop.py tests`")
    return ap.Observation(experiment=name, settings=settings, t=grid, y={"v": np.interp(grid, t, v)},
                          sigma={"v": sigma}, split=split, meta={"file": Path(path).name})


def hours(seconds: float) -> str:
    return f"{seconds / 60:.0f} min" if seconds < 3600 else f"{seconds / 3600:.1f} h"


def describe(settings: dict) -> str:
    return ", ".join(("rest" if a == 0 else f"{a:+g} A") + f" {s:g} s" for a, s in settings["steps"])


def approve_command(inv) -> str:
    server = target()
    return f"autophys approve {inv.id} {inv.pending}" + (f" --target {server}" if server else "")


def where() -> str:
    server = target()
    home = os.environ.get("AUTOPHYS_HOME", "~/autophys")
    return f"{server.rstrip('/')}/app" if server else f"the local workbook in {home} (view it with `autophys serve`)"


def print_outcome(inv, out) -> None:
    print(f"\nstatus: {out.status}" + (f" ({'; '.join(out.reasons)})" if out.reasons else ""))
    for name in cell.params:
        if name in out.estimate:
            verdict = "identified" if name in out.identified else "NOT identified"
            print(f"  {name:3s} = {out.estimate[name]:.5g} {out.units.get(name, ''):4s} {verdict}")
    for combo in out.non_identifiable_combinations:
        print(f"  tied: {combo}")
    for override in out.guardrail_overrides:
        print(f"  guardrail: {override}")
    test_s = sum(float(o.settings["duration"]) for o in inv.dataset)
    names = ", ".join(o.experiment + (" [held out]" if o.split == "validation" else "") for o in inv.dataset)
    print(f"  tests run: {len(inv.dataset)} ({names}), {hours(test_s)} of cycler time")
    if out.validation and out.validation.get("available", True) and "chi2_per_n" in out.validation:
        v = out.validation
        print(f"  held-out check: chi2/N {v['chi2_per_n']:.2f} ({'passed' if v['passed'] else 'FAILED'}, threshold {v['threshold']:g})")
    if inv.pending:
        st = inv.store.proposal_status(inv.id, inv.pending)
        rec = next(r.payload for r in reversed(inv.records("proposal"))
                   if r.payload.get("proposal_id") == inv.pending and r.payload.get("event") == "proposed")
        print(f"\nproposed next test: {st['experiment']} ({hours(st['settings']['duration'])}): {describe(st['settings'])}")
        if rec.get("rationale"):
            print(f"  why: {rec['rationale']}")
        print(f"  proposal {inv.pending} in investigation {inv.id}")
        print(f"  approve it in {where()}, or with `{approve_command(inv)}`")
        print("  then: python closed_loop.py continue --simulate   (or --data NEXT.csv after running the test)")


def plot(inv, params: dict, path: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    obs = list(inv.dataset)
    fig, axes = plt.subplots(len(obs), 1, figsize=(9, 2.6 * len(obs)), squeeze=False)
    for ax, o in zip(axes[:, 0], obs):
        ax.plot(o.t, o.y["v"], ".", ms=2, color="0.6", label=f"{o.experiment} ({o.source}{', held out: not fitted' if o.split == 'validation' else ''})")
        ax.plot(o.t, cell(params, o.settings)["v"], "-", color="C0", lw=1.5, label="fitted model")
        ax.set_ylabel("voltage (V)")
        ax.legend(fontsize=8)
    axes[-1, 0].set_xlabel("time (s)")
    fig.tight_layout()
    fig.savefig(path, dpi=130)
    print(f"\nplot: {path}")


def finish(inv, out, args) -> None:
    print_outcome(inv, out)
    if not inv.pending and out.estimate:
        plot(inv, {**project.initial, **out.estimate}, Path(args.out))


# --- commands ---------------------------------------------------------------
def cmd_tests(args) -> None:
    for name, s in TESTS.items():
        print(f"{name:13s} {hours(s['duration']):>7s}  {describe(s)}")
    print(f"{'check':13s} {hours(CHECK['duration']):>7s}  {describe(CHECK)}  [held out: never fitted, only predicted]")
    print(f"\nsampled at {CELL['rate']:g} Hz; capacity {CELL['capacity_ah']} Ah, starting SOC {CELL['soc0']}")


def cmd_start(args) -> None:
    if args.test not in TESTS:
        sys.exit(f"unknown test {args.test}; see `python closed_loop.py tests`")
    settings = cell.experiment(args.test)
    if args.simulate:
        obs = [simulated(args.test, settings, seed=0), simulated("check", CHECK, seed=100)]
        obs[1].split = "validation"
    else:
        obs = [measured(args.data, args.test, settings, args.sigma, args.columns)]
        if args.validation:
            obs.append(measured(args.validation, "check", CHECK, args.sigma, args.columns, split="validation"))
        else:
            print("no --validation CSV: the fit cannot be checked on held-out data, so the result stays inconclusive")
    inv = workbook().investigate(ap.Dataset(obs), ap.ProposalRunner(), policy=make_policy(args.policy),
                                 title=f"{args.test} start ({'simulated' if args.simulate else Path(args.data).name})")
    save_state(investigation=inv.id, policy=args.policy, server=target())
    print(f"investigation {inv.id} ({args.policy} policy) -> {where()}")
    finish(inv, inv.run(), args)


def cmd_continue(args) -> None:
    state = load_state()
    inv = resume(state)
    if inv.pending:
        st = inv.store.proposal_status(inv.id, inv.pending)
        if st["status"] == "proposed":
            if not args.wait:
                sys.exit(f"proposal {inv.pending} ({st['experiment']}) awaits approval in {where()}; "
                         "approve it, or rerun with --wait")
            print(f"waiting for approval of {inv.pending} ({st['experiment']}) in {where()} ...", flush=True)
            inv.wait_for_approval(timeout=args.timeout)
        if inv.pending:
            st = inv.store.proposal_status(inv.id, inv.pending)
            if st["status"] in ("approved", "edited"):
                name, settings = st["experiment"], st["settings"]
                obs = (simulated(name, settings, seed=len(inv.dataset)) if args.simulate
                       else measured(args.data, name, settings, args.sigma, args.columns))
                inv.attach_data(inv.pending, obs)
                print(f"attached {name} ({obs.source}, {obs.n_samples} samples)")
            else:
                print(f"proposal is {st['status']}; asking the policy again")
    finish(inv, inv.run(), args)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("tests", help="list the cycler tests the agent may propose")

    def data_args(q, start: bool):
        src = q.add_mutually_exclusive_group(required=True)
        src.add_argument("--simulate", action="store_true", help="virtual cycler (hidden demo cell, synthetic data)")
        src.add_argument("--data", help="time,current,voltage CSV of the test, as run on the cycler")
        q.add_argument("--sigma", type=float, default=SIGMA, help="voltage noise standard deviation, V (default 0.002)")
        q.add_argument("--columns", default="time,current,voltage", help="CSV column names for t, I, V")
        q.add_argument("--out", default="loop.png", help="plot written when the loop finishes (default loop.png)")
        if start:
            q.add_argument("--test", default="quick_pulse", help="which test the data comes from (default quick_pulse)")
            q.add_argument("--validation", help="CSV of the held-out `check` program (see `tests`), used only to check predictions")
            q.add_argument("--policy", choices=("scripted", "model"), default="scripted",
                           help="who decides each step: built-in strategy, or the model set in .env")

    data_args(sub.add_parser("start", help="start an investigation from a first test"), True)
    pc = sub.add_parser("continue", help="attach the approved test's data and refit")
    data_args(pc, False)
    pc.add_argument("--wait", action="store_true", help="wait for the approval instead of exiting")
    pc.add_argument("--timeout", type=float, default=3600)
    args = p.parse_args(argv)
    {"tests": cmd_tests, "start": cmd_start, "continue": cmd_continue}[args.cmd](args)


if __name__ == "__main__":
    main()
