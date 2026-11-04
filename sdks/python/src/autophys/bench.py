"""Benchmark runner: policies x synthetic cases x seeds.

For each run it reports the evaluator's view, which the policy never saw:
relative error of each identifiable combination (the case declares them; for
the free-response oscillator they are c/m and k/m), RMSE on the held-out
test experiments, simulator calls, wall-clock, experiments used, and whether
the final identifiability diagnosis (the set of non-identified physical
parameters) matches the case's expectation.
"""

from __future__ import annotations

import json
import warnings
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, wait, FIRST_COMPLETED
import os
import re
import statistics
import threading
import time
from dataclasses import asdict, dataclass
from typing import Callable

from .agent import Investigation, ReasonLanePolicy, ScriptedPolicy
from .project import Budgets, Project
from .reasoner import FakeReasoner, ModelSpec, ReasonerError, reasoner_for
from .usage import usage_total
from .store import MemoryStore, Store
from .synthetic import CASES


def heuristic_responder(messages: list[dict]) -> str:
    """A FakeReasoner brain that reads only the rendered diagnostics text.

    It mirrors the scripted baseline, so a benchmark with it checks that the
    text diagnostics carry everything a decision needs.
    """
    text = messages[-1]["content"]

    def line(tag: str) -> str:
        m = re.search(rf"^{tag}: (.*)$", text, re.M)
        return m.group(1) if m else ""

    def out(action, args, hyp):
        return json.dumps({"hypothesis": hyp, "evidence": [line("FIT")[:80]], "action": action, "arguments": args,
                           "expected_information": "see tool result"})

    fit, sens, rank, val, bud = line("FIT"), line("SENSITIVITY"), line("RANKING"), line("VALIDATION"), line("BUDGET")
    b = dict(kv.split("=") for kv in bud.split())
    if not fit.startswith("current"):
        return out("optimize_parameters", {}, "calibrate to the current measurements")
    chi = float(re.search(r"chi2/N=(\S+)", fit).group(1))
    if chi > 2 and line("COMPARED") == "no" and "," in line("MODEL").split("variants=")[-1]:
        return out("compare_models", {"adopt": True}, "misfit suggests a sensor offset")
    if not sens.startswith("current"):
        return out("analyze_sensitivity", {}, "check what the data determines")
    non = re.search(r"non_identified=(\S+)", sens).group(1)
    ident = re.search(r" identified=(\S+)", sens).group(1)
    catalog = line("CATALOG")
    need = non != "none" or b["experiments_requested"] == "0"
    if need and int(b["experiments_left"]) > 0 and not catalog.startswith("none"):
        if not rank.startswith("current"):
            return out("rank_experiments", {"criterion": "min_eig"}, "find the most informative experiment")
        best = re.search(r"top=(\S+)", rank).group(1)
        return out("request_experiment", {"experiment": best}, f"{best} resolves the weakest direction")
    if not val.startswith("current"):
        return out("validate_predictions", {}, "check predictions on the validation split")
    passed = "passed=yes" in val
    ids = [] if ident == "none" else ident.split(",")
    return out("stop", {"status": "validated" if passed and non == "none" else "inconclusive", "identified": ids,
                        "summary": "heuristic fake reasoner"}, "done")


def overclaiming_responder(messages: list[dict]) -> str:
    """A fake that follows the heuristic but claims every parameter identified at stop."""
    d = json.loads(heuristic_responder(messages))
    if d["action"] == "stop":
        params = re.search(r"^PARAMS: (.*)$", messages[-1]["content"], re.M).group(1)
        d["arguments"]["identified"] = [p.split(" ")[0] for p in params.split("; ")]
        d["arguments"]["status"] = "validated"
    return json.dumps(d)


DEFAULT_POLICIES = ("scripted", "fake-reasoner")


def reason_policy(*, model_spec=None, playbook=None, replay=None, record=None):
    if not (replay or os.environ.get("AUTOPHYS_REASON_REPLAY")) and os.environ.get("AUTOPHYS_ALLOW_LIVE_REASON") != "1":
        raise ReasonerError("reason benchmark requires --replay for offline use; live calls spend money and require AUTOPHYS_ALLOW_LIVE_REASON=1")
    if model_spec is None:
        raise ReasonerError("reason benchmark requires --model")
    policy = ReasonLanePolicy(reasoner_for(model_spec, replay=replay, record=record),
                              model_spec=model_spec, playbook=playbook)
    policy.name = "reason"
    return policy


POLICIES: dict[str, Callable[[], object]] = {
    "reason": reason_policy,
    "scripted": ScriptedPolicy,
    "fake-reasoner": lambda: ReasonLanePolicy(FakeReasoner(heuristic_responder)),
}


def case_project(view) -> Project:
    return Project(name=view.name, simulator=view.simulator, catalog=view.catalog,
                   budgets=Budgets(max_experiments=view.max_experiments, max_test_hours=view.max_test_hours))


@dataclass
class BenchRow:
    case: str
    policy: str
    seed: int
    status: str
    max_rel_error: float
    rel_errors: dict
    test_rmse: float
    simulations: int
    wall_s: float
    experiments: int
    steps: int
    non_identified: list
    diagnosis_correct: bool
    requested: list
    test_hours: float = 0.0
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None


def run_case(case: str, policy: str, seed: int, store: Store | None = None, **reason_options) -> BenchRow:
    workbook_path = reason_options.pop("workbook_path", None)
    if workbook_path:
        from .workbook import WorkbookStore
        with WorkbookStore(workbook_path) as workbook:
            return run_case(case, policy, seed, store=workbook, **reason_options)
    render_images = reason_options.pop("render_images", False)
    view, evaluator = CASES[case](seed)
    project = case_project(view)
    if policy == "reason":
        selected_policy = POLICIES[policy](**reason_options)
    elif policy == "fake-reasoner" and reason_options.get("playbook"):
        selected_policy = ReasonLanePolicy(FakeReasoner(heuristic_responder), playbook=reason_options["playbook"])
    else:
        selected_policy = POLICIES[policy]()
    selected_policy.render_images = render_images
    inv = Investigation(project, view.dataset, view.runner, policy=selected_policy, store=store or MemoryStore(), seed=seed,
                        title=f"bench {case} seed {seed}")
    t0 = time.perf_counter()
    out = inv.run()
    wall = time.perf_counter() - t0
    evaluator.reveal(inv)
    est = out.estimate
    rel = evaluator.relative_errors(est) if est else {}
    physical = set(view.simulator.param_names)
    non_ids = sorted(set(out.non_identified) & physical)
    requested = [o.experiment for o in view.dataset if o.source == "synthetic" and o.split == "train"][1:]
    usage = usage_total(r.payload for r in inv.store.records(inv.id, "step"))
    return BenchRow(
        case=case, policy=policy, seed=seed, status=out.status, test_hours=inv.test_hours_used,
        max_rel_error=max(rel.values()) if rel else float("nan"), rel_errors=rel,
        test_rmse=evaluator.test_rmse(view.simulator, est) if est else float("nan"),
        simulations=out.simulations, wall_s=wall, experiments=out.experiments, steps=out.steps,
        non_identified=non_ids, diagnosis_correct=evaluator.diagnosis_correct(set(non_ids)), requested=requested,
        **{**usage, "cost_usd": usage["cost_usd"] if usage["calls"] else None},
    )


def _run_unit(unit):
    case, policy, seed, options = unit
    return run_case(case, policy, seed, **options)


def run_units(units, jobs=1):
    """Ordered bounded execution; never share mutable stores between workers."""
    if isinstance(jobs, bool) or jobs < 1:
        raise ValueError("jobs must be a positive integer")
    if jobs > 1 and any(u[3].get("record") or os.environ.get("AUTOPHYS_REASON_RECORD") for u in units):
        warnings.warn("recording requires jobs=1; running serially", stacklevel=2)
        jobs = 1
    if jobs == 1:
        return [_run_unit(u) for u in units]
    # Separate CPU-bound and model-bound batches keep the total bound at jobs.
    results = [None] * len(units)
    for model_bound, executor in ((False, ProcessPoolExecutor), (True, ThreadPoolExecutor)):
        selected = [(i, u) for i, u in enumerate(units) if (u[1] == "reason") == model_bound]
        if selected:
            pool = executor(max_workers=jobs)
            pending = {}
            remaining = iter(selected)
            stopped = threading.Event()
            def guarded_unit(unit):
                if stopped.is_set():
                    return None
                try:
                    return _run_unit(unit)
                except BaseException:
                    stopped.set()
                    raise
            def submit_next():
                if stopped.is_set():
                    return
                item = next(remaining, None)
                if item is not None:
                    index, unit = item
                    pending[pool.submit(guarded_unit if model_bound else _run_unit, unit)] = index
            try:
                for _ in range(jobs):
                    submit_next()
                while pending:
                    done, _ = wait(pending, return_when=FIRST_COMPLETED)
                    # Observe all failures before scheduling any more work.
                    rows = [(future, future.result()) for future in done]
                    for future, row in rows:
                        results[pending.pop(future)] = row
                    for _ in rows:
                        submit_next()
            except BaseException:
                for future in pending:
                    future.cancel()
                raise
            finally:
                pool.shutdown(wait=True, cancel_futures=True)
    return results


def run_benchmark(cases=None, policies=None, seeds=3, jobs=1, **reason_options) -> list[BenchRow]:
    return run_units([(case, pol, seed, reason_options)
                      for case in cases or list(CASES)
                      for pol in policies or DEFAULT_POLICIES
                      for seed in range(seeds)], jobs)


def summarize(rows: list[BenchRow]) -> list[dict]:
    groups: dict[tuple, list[BenchRow]] = {}
    for r in rows:
        groups.setdefault((r.case, r.policy), []).append(r)
    out = []
    for (case, pol), rs in groups.items():
        statuses = sorted({r.status for r in rs})
        out.append({
            "case": case, "policy": pol, "seeds": len(rs),
            "status": "/".join(f"{s}x{sum(r.status == s for r in rs)}" for s in statuses),
            "median_max_rel_error": statistics.median(r.max_rel_error for r in rs),
            "median_test_rmse": statistics.median(r.test_rmse for r in rs),
            "median_simulations": statistics.median(r.simulations for r in rs),
            "median_wall_s": statistics.median(r.wall_s for r in rs),
            "experiments": statistics.median(r.experiments for r in rs),
            "test_hours": statistics.median(r.test_hours for r in rs),
            "diagnosis_correct": f"{sum(r.diagnosis_correct for r in rs)}/{len(rs)}",
            "calls": sum(r.calls for r in rs),
            "input_tokens": sum(r.input_tokens for r in rs),
            "output_tokens": sum(r.output_tokens for r in rs),
            "cost_usd": None if any(r.cost_usd is None for r in rs) else sum(r.cost_usd for r in rs),
            "requested": sorted({",".join(r.requested) or "-" for r in rs}),
        })
    return out


def format_table(summary: list[dict]) -> str:
    head = ["case", "policy", "seeds", "status", "max rel err", "test RMSE", "sims", "wall s", "exps", "diagnosis", "requested", "calls", "input_tokens", "output_tokens", "cost_usd", "test_hours"]
    rows = [[s["case"], s["policy"], str(s["seeds"]), s["status"], f"{s['median_max_rel_error']:.2%}",
             f"{s['median_test_rmse']:.4g}", f"{s['median_simulations']:.0f}", f"{s['median_wall_s']:.2f}",
             f"{s['experiments']:.0f}", s["diagnosis_correct"], " | ".join(s["requested"]), str(s["calls"]), str(s["input_tokens"]), str(s["output_tokens"]),
             "null" if s["cost_usd"] is None else f'{s["cost_usd"]:.6f}', f'{s["test_hours"]:.6g}'] for s in summary]
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(head)]
    fmt = lambda r: "| " + " | ".join(c.ljust(w) for c, w in zip(r, widths)) + " |"  # noqa: E731
    return "\n".join([fmt(head), "|" + "|".join("-" * (w + 2) for w in widths) + "|", *map(fmt, rows)])


def rows_json(rows: list[BenchRow]) -> str:
    return json.dumps([asdict(r) for r in rows], indent=1, default=str)
