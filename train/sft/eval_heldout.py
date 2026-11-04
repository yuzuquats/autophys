#!/usr/bin/env python3
"""Held-out benchmark: ``reason`` (a deployed model) vs ``scripted``, per case.

Runs the SDK's own ``autophys.bench.run_case`` (the code behind ``autophys
bench``) on the held-out seeds only; ``autophys bench --seeds N`` always runs
seeds ``0..N-1``, so it cannot select seeds 3,4 by itself.

Per run it keeps a workbook, and for ``reason`` the request/reply cassette
(``--record``), so every result can be replayed offline with ``--replay``.
It writes ``scores.json`` in the shape ``autophys export-trajectories``
joins, then reports per case: pass rate, Evaluator scores, parse failures
(steps the loop rejected), guardrail overrides, and whether the action
sequence equals the scripted policy's on the same seed.

``pass`` = run ended ``validated`` or ``inconclusive`` (not ``failed`` /
``budget_exhausted``), the identifiability diagnosis matches the case, and the
max relative error of the identifiable combinations is <= 10%.

Live calls spend money: they need ``AUTOPHYS_ALLOW_LIVE_REASON=1`` (the SDK's
own gate) plus route/model/URL/key configuration (see README).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict
from pathlib import Path

from autophys.bench import run_case
from autophys.reasoner import ModelSpec
from autophys.synthetic import CASES
from autophys.workbook import WorkbookStore


def details(workbook: Path) -> dict:
    with WorkbookStore(workbook, readonly=True) as store:
        (inv,) = store.investigations()
        steps = [r.payload for r in store.records(inv["id"], "step")]
        outcome = next(r.payload for r in store.records(inv["id"], "outcome"))
    return {"investigation": inv["id"],
            "actions": [s["decision"]["action"] for s in steps if s.get("valid")],
            "parse_failures": sum(not s.get("valid") for s in steps),
            "errors": [s.get("error") for s in steps if not s.get("valid")],
            "guardrail_overrides": outcome.get("guardrail_overrides", [])}


def passed(row) -> bool:
    return (row.status in ("validated", "inconclusive") and row.diagnosis_correct
            and math.isfinite(row.max_rel_error) and row.max_rel_error <= 0.10)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--out", type=Path, required=True, help="new directory for workbooks, cassette and report")
    p.add_argument("--seeds", type=lambda s: [int(x) for x in s.split(",")], default=[3, 4])
    p.add_argument("--case", action="append")
    p.add_argument("--policy", action="append", choices=("scripted", "reason"), help="default: scripted and reason")
    p.add_argument("--route", default="baseten", choices=("meta", "baseten", "lane"))
    p.add_argument("--model", help="the model string the endpoint expects (for a Loops checkpoint: its name)")
    p.add_argument("--replay", type=Path, help="cassette to replay instead of calling the endpoint")
    a = p.parse_args(argv)
    policies = a.policy or ["scripted", "reason"]
    if "reason" in policies and not a.model:
        p.error("reason needs --model")
    a.out.mkdir(parents=True, exist_ok=False)
    cassette = a.out / "reason.cassette.jsonl"
    rows, runs = [], []
    for case in a.case or list(CASES):
        for seed in a.seeds:
            for policy in policies:
                workbook = a.out / f"{policy}-{case}-{seed}.ap-workbook"
                options = {"workbook_path": str(workbook)}
                if policy == "reason":
                    options |= {"model_spec": ModelSpec("policy", a.route, a.model),
                                "replay": str(a.replay) if a.replay else None,
                                "record": None if a.replay else str(cassette)}
                row = run_case(case, policy, seed, **options)
                info = details(workbook)
                rows.append((row, info))
                runs.append({"workbook": workbook.name, "investigation": info["investigation"],
                             "score": {**asdict(row), "pass": passed(row), **info}})
                print(f"{case:21s} seed={seed} {policy:8s} {row.status:15s} pass={passed(row)} "
                      f"max_rel_err={row.max_rel_error:.3%} parse_failures={info['parse_failures']} "
                      f"overrides={info['guardrail_overrides']}", flush=True)
    (a.out / "scores.json").write_text(json.dumps({"runs": runs}, indent=1, default=str) + "\n")

    scripted_actions = {(r.case, r.seed): i["actions"] for r, i in rows if r.policy == "scripted"}
    report = []
    for case in a.case or list(CASES):
        for policy in policies:
            sel = [(r, i) for r, i in rows if r.case == case and r.policy == policy]
            report.append({
                "case": case, "policy": policy, "seeds": len(sel),
                "pass": f"{sum(passed(r) for r, _ in sel)}/{len(sel)}",
                "statuses": [r.status for r, _ in sel],
                "max_rel_error": [round(r.max_rel_error, 5) for r, _ in sel],
                "test_rmse": [round(r.test_rmse, 5) for r, _ in sel],
                "diagnosis_correct": f"{sum(r.diagnosis_correct for r, _ in sel)}/{len(sel)}",
                "steps": [r.steps for r, _ in sel], "experiments": [r.experiments for r, _ in sel],
                "parse_failures": sum(i["parse_failures"] for _, i in sel),
                "guardrail_overrides": sum(bool(i["guardrail_overrides"]) for _, i in sel),
                "same_actions_as_scripted": (f"{sum(i['actions'] == scripted_actions.get((r.case, r.seed)) for r, i in sel)}/{len(sel)}"
                                             if scripted_actions else None),
                "calls": sum(r.calls for r, _ in sel), "input_tokens": sum(r.input_tokens for r, _ in sel),
                "output_tokens": sum(r.output_tokens for r, _ in sel),
            })
    (a.out / "report.json").write_text(json.dumps(report, indent=1) + "\n")
    head = ["case", "policy", "seeds", "pass", "statuses", "max_rel_error", "diagnosis_correct", "parse_failures",
            "guardrail_overrides", "same_actions_as_scripted", "calls"]
    print("| " + " | ".join(head) + " |\n|" + "---|" * len(head))
    for r in report:
        print("| " + " | ".join(str(r[h]) for h in head) + " |")
    print(f"wrote {a.out}/report.json, scores.json" + ("" if a.replay or "reason" not in policies else f", {cassette.name}"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
