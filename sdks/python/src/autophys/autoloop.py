"""The autoloop: research that runs until a stop condition, with a journal and resume.

Each iteration asks a researcher for one playbook edit, scores it on the training
seeds, and keeps it only if it beats the incumbent (``research.improves``). Every
iteration is journalled with its hypothesis, diff, scores and decision, and the
journal is shown to the next proposal so rejected edits are not proposed again.
Held-out seeds are scored once, at the end, and never shown to the researcher.

A run directory holds all state, so ``resume=True`` continues an interrupted run::

    state.json          incumbent playbook, its training score, counters, spend
    journal.jsonl       one line per iteration
    playbooks/NNN.md    every proposal (000 is the starting playbook)
    train/NNN/          the training evaluation of each scored playbook
    heldout/            initial and final held-out evaluations
    summary.json        written when the loop stops
    STOP                create this file to stop after the current iteration

Researchers implement ``propose(playbook_text, report, history=None)`` and return
the complete SKILL.md, a dict ``{"skill", "hypothesis", "prediction"}``, or None
when they have nothing further to propose.
"""
from __future__ import annotations

import difflib
import hashlib
import inspect
import json
import time
from pathlib import Path

from .bench import STRATEGY_SETTINGS, strategy_settings
from .reasoner import BudgetError
from .research import _InvalidEdit, _write_json, evaluate, improves, require_replay, validate_edit
from .synthetic import CASES, PLANTED_CASES

HISTORY_LIMIT = 20


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _diff(old: str, new: str) -> str:
    return "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), "incumbent", "proposal", n=1))


def _usage_cost(usage) -> float:
    cost = (usage or {}).get("cost_usd") if isinstance(usage, dict) else None
    return float(cost) if isinstance(cost, (int, float)) else 0.0


def _history(journal: list[dict]) -> list[dict]:
    """What the researcher may see: its own past proposals and their training scores."""
    keep = ("iteration", "hypothesis", "prediction", "diff", "accepted", "reason", "score", "incumbent_score")
    return [{k: e.get(k) for k in keep} for e in journal[-HISTORY_LIMIT:]]


class _Run:
    def __init__(self, root: Path):
        self.root = root
        self.state_path = root / "state.json"
        self.journal_path = root / "journal.jsonl"

    def save_state(self, state: dict) -> None:
        tmp = self.state_path.with_suffix(".json.tmp")
        _write_json(tmp, state)
        tmp.replace(self.state_path)

    def load_state(self) -> dict:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def journal(self) -> list[dict]:
        if not self.journal_path.exists():
            return []
        return [json.loads(line) for line in self.journal_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def append(self, entry: dict) -> None:
        with self.journal_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, sort_keys=True) + "\n")

    def playbook(self, index: int, text: str) -> Path:
        path = self.root / "playbooks" / f"{index:03d}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path


def autoloop(*, researcher, output_dir, playbook="default", cases=None, train_seeds=(0, 1, 2), heldout_seeds=(3, 4),
             policy="reason", jobs=1, max_iterations=10, patience=3, max_usd=None, max_wall_s=None, resume=False,
             evaluate_fn=evaluate, **options) -> dict:
    """Run the autoloop in ``output_dir`` until a stop condition; return the summary."""
    from .playbook import load_playbook

    root = Path(output_dir)
    run = _Run(root)
    if resume:
        if not run.state_path.exists():
            raise ValueError(f"nothing to resume in {root}")
        state = run.load_state()
        config = state["config"]
        cases, train_seeds, heldout_seeds = config["cases"], tuple(config["train_seeds"]), tuple(config["heldout_seeds"])
        policy = config["policy"]
    else:
        cases = list(cases or CASES)
        train_seeds, heldout_seeds = tuple(train_seeds), tuple(heldout_seeds)
        if set(train_seeds) & set(heldout_seeds) or not train_seeds or not heldout_seeds:
            raise ValueError("train and held-out seeds must be non-empty and disjoint")
        if any(c not in CASES and c not in PLANTED_CASES for c in cases):
            raise ValueError("unknown case")
        if jobs < 1 or max_iterations < 0 or patience < 1:
            raise ValueError("invalid jobs, max_iterations or patience")
        root.mkdir(parents=True, exist_ok=False)
        config = {"cases": cases, "train_seeds": list(train_seeds), "heldout_seeds": list(heldout_seeds),
                  "policy": policy, "playbook": str(playbook)}
        state = {"config": config, "started_at": _now(), "iteration": 0, "rejected_in_a_row": 0, "spent_usd": 0.0,
                 "wall_s": 0.0}
    if policy == "reason":
        require_replay(options.get("replay"))
    takes_history = "history" in inspect.signature(researcher.propose).parameters

    t0 = time.monotonic()
    wall_before = float(state.get("wall_s", 0.0))
    if not resume:
        text = load_playbook(playbook).data.decode("utf-8")
        path = run.playbook(0, text)
        report = evaluate_fn(path, cases, train_seeds, policy, root / "train" / "000", jobs=jobs, **options)
        state.update(incumbent=path.name, incumbent_sha256=_sha(text), incumbent_score=report["score"],
                     initial=path.name, spent_usd=state["spent_usd"] + (report["score"].get("cost_usd") or 0.0))
        (root / "train" / "000").mkdir(parents=True, exist_ok=True)
        _write_json(root / "train" / "000" / "report.json", report)
        run.save_state(state)
    else:
        path = root / "playbooks" / state["incumbent"]
        text = path.read_text(encoding="utf-8")
        report = json.loads((root / "train" / path.stem / "report.json").read_text(encoding="utf-8"))

    stop = None
    while stop is None:
        wall = wall_before + time.monotonic() - t0
        if (root / "STOP").exists():
            stop = "stop file"
        elif state["iteration"] >= max_iterations:
            stop = "max iterations"
        elif state["rejected_in_a_row"] >= patience:
            stop = f"{patience} rejections in a row"
        elif max_usd is not None and state["spent_usd"] >= max_usd:
            stop = "budget"
        elif max_wall_s is not None and wall >= max_wall_s:
            stop = "wall time"
        if stop:
            break
        index = state["iteration"] + 1
        entry = {"iteration": index, "at": _now(), "incumbent": state["incumbent"],
                 "incumbent_score": state["incumbent_score"], "hypothesis": None, "prediction": None}
        call = {"history": _history(run.journal())} if takes_history else {}
        try:
            proposal = researcher.propose(text, report, **call)
        except BudgetError:
            stop = "researcher budget error"
            break
        usage = getattr(researcher, "last_usage", None)
        state["spent_usd"] += _usage_cost(usage)
        entry["researcher_usage"] = usage
        if proposal is None:
            stop = "researcher has no further proposal"
            break
        if isinstance(proposal, dict):
            entry["hypothesis"], entry["prediction"] = proposal.get("hypothesis"), proposal.get("prediction")
            proposal = proposal.get("skill")
        try:
            if not isinstance(proposal, str):
                raise _InvalidEdit("researcher returned no SKILL.md text")
            proposed = validate_edit(text, proposal)
        except _InvalidEdit as error:
            entry.update(accepted=False, reason=f"invalid edit: {error}", score=None, playbook=None, diff=None)
        else:
            candidate = run.playbook(index, proposed)
            trial = evaluate_fn(candidate, cases, train_seeds, policy, root / "train" / f"{index:03d}", jobs=jobs, **options)
            (root / "train" / f"{index:03d}").mkdir(parents=True, exist_ok=True)
            _write_json(root / "train" / f"{index:03d}" / "report.json", trial)
            state["spent_usd"] += trial["score"].get("cost_usd") or 0.0
            accepted = improves(trial["score"], state["incumbent_score"])
            entry.update(accepted=accepted, score=trial["score"], playbook=candidate.name, sha256=_sha(proposed),
                         diff=_diff(text, proposed), reason="improves on the incumbent" if accepted else
                         "does not improve on the incumbent")
            if accepted:
                text, report = proposed, trial
                state.update(incumbent=candidate.name, incumbent_sha256=_sha(proposed), incumbent_score=trial["score"])
        state["iteration"] = index
        state["rejected_in_a_row"] = 0 if entry["accepted"] else state["rejected_in_a_row"] + 1
        state["wall_s"] = wall_before + time.monotonic() - t0
        run.append(entry)
        run.save_state(state)

    initial = root / "playbooks" / state["initial"]
    final = root / "playbooks" / state["incumbent"]
    stamp = time.strftime("%Y%m%dT%H%M%S", time.gmtime())
    held_initial = evaluate_fn(initial, cases, heldout_seeds, policy, root / "heldout" / f"initial-{stamp}", jobs=jobs, **options)
    held_final = held_initial if final == initial else evaluate_fn(
        final, cases, heldout_seeds, policy, root / "heldout" / f"final-{stamp}", jobs=jobs, **options)
    state["wall_s"] = wall_before + time.monotonic() - t0
    state["stopped"] = {"at": _now(), "reason": stop}
    run.save_state(state)
    journal = run.journal()
    summary = {"stop_reason": stop, "iterations": state["iteration"], "accepted": sum(1 for e in journal if e["accepted"]),
               "initial_playbook": state["initial"], "final_playbook": state["incumbent"],
               "train_initial": json.loads((root / "train" / "000" / "report.json").read_text())["score"],
               "train_final": state["incumbent_score"], "heldout_initial": held_initial["score"],
               "heldout_final": held_final["score"], "spent_usd": state["spent_usd"], "wall_s": state["wall_s"],
               "cases": cases, "train_seeds": list(train_seeds), "heldout_seeds": list(heldout_seeds)}
    _write_json(root / "summary.json", summary)
    return summary


def set_setting(text: str, key: str, value: str) -> str:
    """``text`` with the typed setting ``key`` (STRATEGY_SETTINGS) set to ``value``."""
    import re

    assert key in STRATEGY_SETTINGS and value in STRATEGY_SETTINGS[key]
    # Spaces and tabs only: \s would also match the line break and eat it.
    line = re.compile(rf"^([ \t]*-?[ \t]*){key}:[ \t]*\S+[ \t]*$", re.M)
    if line.search(text):
        return line.sub(lambda m: f"{m.group(1)}{key}: {value}", text, count=1)
    body = text.rstrip("\n")
    if not re.search(r"^Settings:\s*$", body, re.M):
        body += "\n\nSettings:"
    return body + f"\n- {key}: {value}\n"


class HeuristicResearcher:
    """An offline researcher that diagnoses failing transcripts and edits typed settings.

    It stands in for a model the way the fake reasoner does, so the autoloop can run
    closed and unattended without a network. It knows two failure patterns:

    - failing runs end on the base model with chi2/N above 2 while a sensor-bias
      variant exists and was never compared: set ``compare_variants: on_misfit``;
    - failing runs stop with unidentified parameters and no experiments while the
      playbook forbids them: set ``experiments: as_needed``.

    Anything else returns None, which ends the loop.
    """

    misfit = 2.0

    def __init__(self):
        self.last_usage = None
        self.last_events = None

    def propose(self, playbook_text, report, history=None):
        settings = strategy_settings("Strategy:\n" + playbook_text)
        tried = {(e.get("diff") or "") for e in (history or []) if not e.get("accepted")}
        failing = [t["records"] for t in report.get("failing_transcripts", [])]
        outcomes = [next((r["payload"] for r in reversed(recs) if r["kind"] == "outcome"), None) for recs in failing]
        steps = [[r["payload"] for r in recs if r["kind"] == "step"] for recs in failing]

        def has_variants(run_steps):
            return any("," in s.get("evidence_text", "").split("variants=")[-1].split("\n")[0] for s in run_steps)

        def compared(run_steps):
            return any((s.get("decision") or {}).get("action") == "compare_models" for s in run_steps)

        misfit = [o["fit"]["chi2_per_n"] for o, s in zip(outcomes, steps)
                  if o and o.get("fit") and o["fit"].get("chi2_per_n", 0) > self.misfit and o.get("model") == "base"
                  and has_variants(s) and not compared(s)]
        if misfit and settings["compare_variants"] == "never":
            proposal = {"skill": set_setting(playbook_text, "compare_variants", "on_misfit"),
                        "hypothesis": (f"{len(misfit)} failing run(s) end on the base model with chi2/N "
                                       f"{min(misfit):.1f}-{max(misfit):.1f}, although a sensor-bias variant exists and "
                                       "was never compared; a constant sensor offset would explain that misfit."),
                        "prediction": "those runs adopt the sensor-bias variant and validate; other runs are unchanged."}
            if _diff(playbook_text, proposal["skill"]) not in tried:
                return proposal
        starved = [o for o in outcomes if o and o.get("non_identified") and not o.get("experiments")]
        if starved and settings["experiments"] == "none":
            proposal = {"skill": set_setting(playbook_text, "experiments", "as_needed"),
                        "hypothesis": (f"{len(starved)} failing run(s) stop with unidentified parameters after no "
                                       "experiments, because the playbook forbids requesting any."),
                        "prediction": "those runs request the top-ranked experiment and identify the parameters."}
            if _diff(playbook_text, proposal["skill"]) not in tried:
                return proposal
        return None
