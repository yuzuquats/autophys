"""Generate the mass-spring-damper and thermal RC demo workbooks (decision DL-4).

    PYTHONPATH=sdks/python/src python3 ops/demo_workbooks.py --out DIR [--seed 0] [--by demo-generator]

Each workbook is one real, offline investigation of a built-in backtest's
``full`` case (``examples/oscillator.backtest``, ``examples/thermal.backtest``):
the scripted policy (the built-in Fisher-ranking strategy, no network) fits the
starting data, finds what it leaves undetermined and proposes the catalog
experiment that resolves it. The proposal is approved as ``--by``, the hidden
system runs it (synthetic data, labelled so) and the loop refits and validates.
The starting data, the hidden truth and the experiment noise are the same as
``autophys bench --example NAME#full --seeds 1`` at that seed. Each workbook
then gets its project overview, ``ops/demo-overview-*.template.md`` with the new
investigation's id, written through the SDK by ``--by`` (``ops/demo_overviews.py``).

Writes DIR/<project>.ap-workbook for each demo and refuses to overwrite one.
DIR is a staging directory: copying a workbook into a live demo collection is a
separate, reviewed step.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import autophys as ap
from autophys.agent import ProposalRunner, ScriptedPolicy
from autophys.backtest import Backtest
from autophys.synthetic import case_project

import demo_overviews

# project name -> (built-in backtest, case, title of the starting test)
DEMOS = {
    "mass_spring_damper_demo": ("oscillator", "full", "free response start (simulated)"),
    "thermal_rc_demo": ("thermal", "full", "short heating step start (simulated)"),
}
NOTE = "simulated: hidden demo system plus noise, not a measurement"


def generate(name: str, out: Path, seed: int, by: str) -> dict:
    example, case, title = DEMOS[name]
    backtest = Backtest.builtin(example)
    view, evaluator = backtest.build(backtest.case(case), seed)
    bench = case_project(view)
    project = ap.Project(name, bench.simulator, catalog=bench.catalog, budgets=bench.budgets)
    path = out / f"{name}.ap-workbook"
    if path.exists():
        sys.exit(f"{path} exists; generate into a fresh directory")
    for obs in view.dataset:
        obs.meta = {**obs.meta, "note": NOTE}
    with ap.connect(path) as client:
        wb = client.project(project)
        inv = wb.investigate(view.dataset, ProposalRunner(), policy=ScriptedPolicy(), seed=seed, title=title)
        steps = []
        outcome = inv.run()
        while inv.pending:
            pid = inv.pending
            st = inv.store.proposal_status(inv.id, pid)
            steps.append({"proposal": pid, "experiment": st["experiment"], "settings": st["settings"],
                          "non_identified_before": sorted(outcome.non_identified),
                          "tied_before": list(outcome.non_identifiable_combinations)})
            inv.approve(pid, by=by)
            obs = view.runner.run(st["experiment"])
            obs.meta = {**obs.meta, "note": NOTE}
            inv.attach_data(pid, obs)
            outcome = inv.run()
        rel = evaluator.relative_errors(outcome.estimate) if outcome.estimate else {}
        overview = demo_overviews.write(inv.store, wb.project_id, name, by, ids={"investigation_1": inv.id})
        return {
            "project": name, "workbook": str(path), "example": f"builtin:{example}#{case}", "seed": seed,
            "investigation": inv.id, "status": outcome.status, "proposals": steps,
            "identified": sorted(outcome.identified), "estimate": outcome.estimate,
            # Printed for the operator only; the truth is never recorded in the workbook.
            "relative_error_vs_hidden_truth": rel,
            "overview": overview,
        }


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True, type=Path, help="staging directory for the workbooks")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--by", default="demo-generator", help="approver recorded on each proposal")
    p.add_argument("--only", choices=sorted(DEMOS), action="append", help="generate only this project (repeatable)")
    args = p.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    results = [generate(name, args.out, args.seed, args.by) for name in (args.only or DEMOS)]
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
