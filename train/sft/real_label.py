#!/usr/bin/env python3
"""Label decision steps of investigations replayed from REAL battery data.

A stress test of the SFT pipeline, not a dataset of good decisions. Each
trajectory is one ``Investigation`` of the user project ``m50t_hppc:project``
(Samsung INR21700-M50T, R0 + R1||C1) whose experiment catalog is the nine
recorded HPPC windows; ``request_experiment`` returns the recorded window
(``read_csv``, the SDK's measured-data path), nothing is simulated as data.
The initial data is one window (train split); trajectories differ by their
starting window and seed. Budgets are the project's own (24 steps, 2
experiments).

Prompts come from the SDK's ``ReasonLanePolicy`` with a ``FakeReasoner``,
exactly as ``build_dataset.py::DistilPolicy``: byte-identical to what
``autophys bench --policy reason`` sends. The replies are labels.

Protocol (each command replays every trajectory from scratch; deterministic):

  advance   --labels L.jsonl --work DIR   label known steps, stop each trajectory at
                                          its first unlabelled step -> DIR/pending.jsonl
  autolabel --work DIR --labels L.jsonl   answer every pending step with the scripted
                                          suggestion (offline testing)
  label-response --work DIR --labels L.jsonl --response JSON --labeller NAME
                                          append one supplied response for all pending steps
  export    --labels L.jsonl --work DIR --out OUT   train/validation/heldout.jsonl,
                                          *.meta.jsonl, manifest.json (build_dataset.py format)

A step's key is sha256 of the canonical JSON (``autophys.store.canonical``)
of the messages sent. A label row is ``{"key", "response", "labeller"}``;
``response`` is the raw model reply (string) or a decision object. The last
row for a key wins. Invalid labels never crash: the loop rejects them as it
would a model's reply (three in a row fail the run) and they are listed in
``DIR/gaps.jsonl`` and the summary.

Data: Pozzato, Allam, Onori 2022 (CC BY 4.0), local only; never copy it into
the repo. Output belongs in the gitignored ``data-real*/`` and ``label-work*/``.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import os
import sys
import traceback
from collections import Counter
from pathlib import Path

import autophys
from autophys.agent import (Decision, DecisionError, Investigation, ReasonLanePolicy, ScriptedPolicy, ToolError,
                            system_prompt)
from autophys.data import Dataset
from autophys.mcp.measurements import read_csv
from autophys.reasoner import FakeReasoner, ReasonerError, parse_json_content
from autophys.store import MemoryStore, canonical

HERE = Path(__file__).resolve().parent
EVIDENCE = Path(os.environ.get("AUTOPHYS_REAL_EVIDENCE",
                               "~/.local/state/autophys/evidence/onori-pozzato-2022")).expanduser()
PROJECT_REF = "m50t_hppc:project"
COLUMNS = {"t": "time", "v": "v"}
SIGMA = {"v": 0.001}  # declared Arbin voltage accuracy, as in scripts/run_session.py
WINDOWS = [f"hppc_soc{n}" for n in range(10, 100, 10)]
# Split by trajectory (starting window). Neighbouring SOCs share no rows but do share
# catalog windows: every trajectory may request any other window.
SPLITS = {
    "train": ["hppc_soc10", "hppc_soc30", "hppc_soc50", "hppc_soc70", "hppc_soc90"],
    "validation": ["hppc_soc20", "hppc_soc60"],
    "heldout": ["hppc_soc40", "hppc_soc80"],
}
SOURCE = {
    "name": "Pozzato, Allam, Onori 2022: Samsung INR21700-M50T cell V5, Diag_1 HPPC, 23 C",
    "citation": 'G. Pozzato, A. Allam, S. Onori, "Lithium-ion battery aging dataset based on electric vehicle '
                'real-driving profiles", Data in Brief 41 (2022) 107995',
    "doi": "https://doi.org/10.1016/j.dib.2022.107995",
    "license": "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/legalcode); attribution required",
    "osf_project": "qsabn",
    "derived": "nine 105-sample HPPC windows (lab/hppc_soc10..90.csv); see the evidence SOURCE.md",
}
FALLBACK = {"hypothesis": "scripted policy had no suggestion for this state", "evidence": [],
            "action": "stop", "arguments": {"status": "inconclusive", "summary": "autolabel fallback"},
            "expected_information": "none"}


def message_key(messages: list[dict]) -> str:
    return hashlib.sha256(canonical(messages).encode()).hexdigest()


def trajectories() -> list[dict]:
    split_of = {w: s for s, ws in SPLITS.items() for w in ws}
    return [{"trajectory": f"real-{w}", "start": w, "seed": i, "split": split_of[w]} for i, w in enumerate(WINDOWS)]


def base_project():
    if str(EVIDENCE / "scripts") not in sys.path:
        sys.path.insert(0, str(EVIDENCE / "scripts"))  # trusted user module, outside the repo
    from autophys.mcp.session import load_project
    return load_project(PROJECT_REF)


def trajectory_project(base, start: str):
    # Workaround (GAPS-real.md #2): the initial window does not count as a run, and a replay
    # can only return the same recording again, so give every window one run and the start none.
    catalog = {n: {"max_runs": 0 if n == start else 1} for n in base.simulator.experiments}
    return dataclasses.replace(base, catalog=catalog)


class ReplayRunner:
    """``request_experiment`` returns the recorded window, read by the SDK's CSV importer."""

    kind = "replay"

    def __init__(self, project) -> None:
        self.project = project

    def load(self, window: str, split: str = "train"):
        return read_csv(self.project, EVIDENCE / "lab", f"{window}.csv", window, columns=COLUMNS, sigma=SIGMA,
                        split=split)

    def run(self, experiment):
        if not isinstance(experiment, str):
            raise ToolError("replay runner returns recorded windows only; custom settings have no recording")
        try:
            return self.load(experiment)
        except (OSError, ValueError) as e:  # the loop only survives ToolError (GAPS-real.md #4)
            raise ToolError(f"recorded window {experiment} cannot be imported: {e}") from None


class Pending(Exception):
    def __init__(self, step: dict) -> None:
        super().__init__("unlabelled step")
        self.step = step


class LabelReasoner(FakeReasoner):
    """FakeReasoner that also keeps the response schema the lane sent."""

    schema = None

    def complete(self, messages, *, response_schema=None, **kw):
        self.schema = response_schema
        return super().complete(messages, response_schema=response_schema, **kw)


def scripted_suggestion(facts: dict, inv) -> tuple[dict | None, str | None]:
    try:
        d = ScriptedPolicy()._choose(facts)
        Decision.parse(d.to_dict(), param_names=inv.sim.param_names, catalog=list(inv.limits))
        return d.to_dict(), None
    except Exception as e:  # real states may break the teacher; that is a finding
        return None, f"{type(e).__name__}: {e}"


class LabelPolicy:
    """The model-driven lane, answered from the labels file."""

    name = "real-label"

    def __init__(self, labels: dict, playbook: str) -> None:
        self.labels = labels
        self.fake = LabelReasoner(self._respond, model="labeller")
        self.lane = ReasonLanePolicy(self.fake, playbook=playbook)
        self.playbook = self.lane.playbook
        self.inv = None
        self.steps: list[dict] = []
        self._facts: dict | None = None

    def meta(self) -> dict:
        return self.lane.meta()

    def decide(self, facts: dict):
        self._facts = facts
        return self.lane.decide(facts)

    def _respond(self, messages: list[dict]):
        inv = self.inv
        suggestion, error = scripted_suggestion(self._facts, inv)
        step = {"key": message_key(messages), "step": inv.steps, "messages": messages,
                "response_schema": self.fake.schema, "scripted_suggestion": suggestion, "scripted_error": error}
        label = self.labels.get(step["key"])
        if label is None:
            raise Pending(step)
        step["label"] = label
        try:  # the loop parses it the same way right after; this only records the verdict
            parsed = Decision.parse(parse_json_content(label["response"]), param_names=inv.sim.param_names,
                                    catalog=list(inv.limits)).to_dict()
            step.update(valid=True, error=None, decision=parsed, action=parsed["action"])
        except (ReasonerError, DecisionError, ValueError, TypeError) as e:
            step.update(valid=False, error=f"{type(e).__name__}: {e}", decision=None, action=None)
        self.steps.append(step)
        return label["response"]


def replay(traj: dict, labels: dict, base, playbook: str) -> dict:
    out = {**traj, "steps": [], "state": None}
    try:
        project = trajectory_project(base, traj["start"])
        runner = ReplayRunner(project)
        policy = LabelPolicy(labels, playbook)
        inv = Investigation(project, Dataset([runner.load(traj["start"])]), runner, policy=policy,
                            store=MemoryStore(), seed=traj["seed"], title=f"real-label {traj['trajectory']}")
        policy.inv = inv
    except Exception as e:
        out.update(state="error", error=f"setup {type(e).__name__}: {e}", traceback=traceback.format_exc())
        return out
    try:
        outcome = inv.run()
        out.update(state="finished", outcome=outcome.to_dict())
    except Pending as p:
        out.update(state="pending", pending=p.step)
    except Exception as e:
        out.update(state="error", error=f"{type(e).__name__}: {e}", traceback=traceback.format_exc())
    results = {r.payload["index"]: r.payload.get("result") or {} for r in inv.store.records(inv.id, "step")}
    for s in policy.steps:
        res = results.get(s["step"], {})
        s["tool_error"] = res.get("error") if isinstance(res, dict) else None
    out["steps"] = policy.steps
    out["system_prompt_sha256"] = policy.meta()["system_prompt_sha256"]
    return out


def load_labels(path: Path) -> tuple[dict, list[dict], int]:
    labels, problems, rows = {}, [], 0
    if not path.exists():
        return labels, problems, rows
    for i, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        rows += 1
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            problems.append({"kind": "label_file_problem", "line": i, "detail": f"not JSON: {e}"})
            continue
        if not isinstance(row, dict) or not isinstance(row.get("key"), str) or "response" not in row:
            problems.append({"kind": "label_file_problem", "line": i, "detail": "need an object with key and response"})
            continue
        labels[row["key"]] = row
    return labels, problems, rows


def replay_all(labels_path: Path, playbook: str) -> tuple[list[dict], list[dict], dict]:
    labels, problems, rows = load_labels(labels_path)
    base = base_project()
    results = [replay(t, labels, base, playbook) for t in trajectories()]
    gaps = list(problems)
    used = set()
    for r in results:
        for s in r["steps"]:
            used.add(s["key"])
            if not s["valid"]:
                gaps.append({"kind": "invalid_label", "trajectory": r["trajectory"], "step": s["step"], "key": s["key"],
                             "labeller": s["label"].get("labeller"), "detail": s["error"]})
            if s["scripted_error"]:
                gaps.append({"kind": "scripted_failed", "trajectory": r["trajectory"], "step": s["step"],
                             "key": s["key"], "detail": s["scripted_error"]})
            if s.get("tool_error"):
                gaps.append({"kind": "tool_error", "trajectory": r["trajectory"], "step": s["step"], "key": s["key"],
                             "action": s["action"], "detail": s["tool_error"]})
        if r["state"] == "pending" and r["pending"]["scripted_error"]:
            gaps.append({"kind": "scripted_failed", "trajectory": r["trajectory"], "step": r["pending"]["step"],
                         "key": r["pending"]["key"], "detail": r["pending"]["scripted_error"]})
        if r["state"] == "error":
            gaps.append({"kind": "trajectory_error", "trajectory": r["trajectory"], "detail": r["error"],
                         "traceback": r["traceback"]})
    info = {"label_rows": rows, "labels": len(labels), "unused_labels": len(set(labels) - used),
            "labels_sha256": hashlib.sha256(labels_path.read_bytes()).hexdigest() if labels_path.exists() else None}
    return results, gaps, info


def outcome_summary(o: dict) -> dict:
    keys = ("status", "reasons", "estimate", "identified", "non_identified", "guardrail_overrides", "fit",
            "validation", "steps", "experiments", "simulations")
    return {k: o.get(k) for k in keys}


def summary_line(results, gaps, info) -> dict:
    kinds = Counter(g["kind"] for g in gaps)
    return {"pending": sum(r["state"] == "pending" for r in results),
            "finished": sum(r["state"] == "finished" for r in results),
            "errors": sum(r["state"] == "error" for r in results),
            "labelled_steps": sum(len(r["steps"]) for r in results),
            "invalid_labels": kinds.get("invalid_label", 0),
            "label_file_problems": kinds.get("label_file_problem", 0),
            "scripted_failed": kinds.get("scripted_failed", 0),
            "tool_errors": kinds.get("tool_error", 0),
            "unused_labels": info["unused_labels"]}


def write_jsonl(path: Path, rows) -> None:
    with open(path, "w") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)


def cmd_advance(a) -> int:
    a.work.mkdir(parents=True, exist_ok=True)
    results, gaps, info = replay_all(a.labels, a.playbook)
    pending = [{"key": r["pending"]["key"], "trajectory": r["trajectory"], "step": r["pending"]["step"],
                "messages": r["pending"]["messages"], "response_schema": r["pending"]["response_schema"],
                "scripted_suggestion": r["pending"]["scripted_suggestion"],
                "scripted_error": r["pending"]["scripted_error"]}
               for r in results if r["state"] == "pending"]
    write_jsonl(a.work / "pending.jsonl", pending)
    finished = {r["trajectory"]: {"start": r["start"], "seed": r["seed"], "split": r["split"],
                                  "labelled_steps": len(r["steps"]), **outcome_summary(r["outcome"])}
                for r in results if r["state"] == "finished"}
    (a.work / "finished.json").write_text(json.dumps(finished, indent=1, sort_keys=True) + "\n")
    errors = {r["trajectory"]: {"error": r["error"], "labelled_steps": len(r["steps"])}
              for r in results if r["state"] == "error"}
    (a.work / "errors.json").write_text(json.dumps(errors, indent=1, sort_keys=True) + "\n")
    write_jsonl(a.work / "gaps.jsonl", gaps)
    print(json.dumps(summary_line(results, gaps, info)))
    return 0


def cmd_autolabel(a) -> int:
    path = a.work / "pending.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()] if path.exists() else []
    out, fallback = [], 0
    for p in rows:
        d = p["scripted_suggestion"]
        if d is None:
            d, fallback = FALLBACK, fallback + 1
        out.append({"key": p["key"], "response": json.dumps(d, ensure_ascii=False),
                    "labeller": "scripted-autolabel" if d is not FALLBACK else "scripted-autolabel-fallback",
                    "trajectory": p["trajectory"], "step": p["step"]})
    with open(a.labels, "a") as f:
        f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in out)
    print(json.dumps({"labelled": len(out), "fallback": fallback}))
    return 0


def cmd_label_response(a) -> int:
    """Apply an explicitly supplied label to this pending round; never infer its author."""
    if not a.labeller.strip():
        raise ValueError("--labeller must name the source of the supplied response")
    response = json.loads(a.response)
    if not isinstance(response, (dict, str)):
        raise ValueError("--response must encode a decision object or raw reply string")
    pending = [json.loads(line) for line in (a.work / "pending.jsonl").read_text().splitlines() if line.strip()]
    # Validate the whole round before opening the append-only label file.
    rows = [{"key": row["key"], "response": response, "labeller": a.labeller,
             **{key: row[key] for key in ("trajectory", "step") if key in row}} for row in pending]
    with a.labels.open("a") as file:
        file.writelines(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)
    print(json.dumps({"labelled": len(rows), "labeller": a.labeller}))
    return 0


def target_text(label: dict) -> str:
    r = label["response"]
    return r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)


def cmd_export(a) -> int:
    results, gaps, info = replay_all(a.labels, a.playbook)
    system = system_prompt(a.playbook)
    sha = hashlib.sha256(system.encode()).hexdigest()
    a.out.mkdir(parents=True, exist_ok=True)
    manifest = {"system_prompt_sha256": sha, "playbook": a.playbook, "cases": ["m50t_hppc_replay"],
                "kind": "real-data labels (pipeline stress test; label quality not assessed)",
                "data_source": SOURCE, "project": PROJECT_REF,
                "sdk": {"autophys": str(Path(autophys.__file__).parent)},
                "labels": {"path": str(a.labels.resolve()), **info},
                "summary": summary_line(results, gaps, info), "gaps": dict(Counter(g["kind"] for g in gaps)),
                "splits": {}, "trajectories": [], "excluded_trajectories": []}
    by_split = {s: [] for s in SPLITS}
    for r in results:
        if r.get("system_prompt_sha256", sha) != sha:
            raise SystemExit(f"{r['trajectory']}: system prompt differs from system_prompt({a.playbook!r})")
        if r["state"] != "finished":
            manifest["excluded_trajectories"].append({"trajectory": r["trajectory"], "state": r["state"],
                                                      "error": r.get("error")})
            continue
        by_split[r["split"]].append(r)
    for split, rs in by_split.items():
        rows_out, meta_out, actions = [], [], Counter()
        for r in rs:
            kept = 0
            for s in r["steps"]:
                if not s["valid"]:
                    continue  # rejected by the loop; listed in gaps
                (dev, user) = s["messages"]
                assert dev["role"] == "developer" and user["role"] == "user"
                target = target_text(s["label"])
                rows_out.append({"messages": [{"role": "system", "content": dev["content"]},
                                              {"role": "user", "content": user["content"]},
                                              {"role": "assistant", "content": target, "weight": 1}]})
                sug = s["scripted_suggestion"]
                meta_out.append({"case": "m50t_hppc_replay", "trajectory": r["trajectory"], "start_window": r["start"],
                                 "seed": r["seed"], "step": s["step"], "action": s["action"], "key": s["key"],
                                 "labeller": s["label"].get("labeller"),
                                 "label_equals_scripted": sug is not None and s["decision"] == sug,
                                 "action_equals_scripted": sug is not None and s["action"] == sug["action"],
                                 "scripted_error": s["scripted_error"], "tool_error": s.get("tool_error"),
                                 "sdk_messages_sha256": hashlib.sha256(json.dumps(s["messages"], sort_keys=True).encode()).hexdigest(),
                                 "response_schema_sent": s["response_schema"] is not None})
                actions[s["action"]] += 1
                kept += 1
            manifest["trajectories"].append({"split": split, "trajectory": r["trajectory"], "start": r["start"],
                                             "seed": r["seed"], "rows": kept,
                                             "invalid_steps": sum(not s["valid"] for s in r["steps"]),
                                             **outcome_summary(r["outcome"])})
        write_jsonl(a.out / f"{split}.jsonl", rows_out)
        write_jsonl(a.out / f"{split}.meta.jsonl", meta_out)
        prompts = {json.dumps(x["messages"][:2]) for x in rows_out}
        manifest["splits"][split] = {"trajectories": [r["trajectory"] for r in rs], "rows": len(rows_out),
                                     "distinct_prompts": len(prompts), "actions": dict(sorted(actions.items())),
                                     "label_equals_scripted": sum(m["label_equals_scripted"] for m in meta_out)}
        print(f"{split:10s} trajectories={len(rs)} rows={len(rows_out)} distinct_prompts={len(prompts)} "
              f"actions={dict(sorted(actions.items()))}")
    (a.out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(f"system_prompt_sha256={sha}")
    print(json.dumps(manifest["summary"]))
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("advance", "autolabel", "label-response", "export"):
        s = sub.add_parser(name)
        s.add_argument("--labels", type=Path, required=True)
        s.add_argument("--work", type=Path, default=HERE / "label-work")
        s.add_argument("--playbook", default="default")
        if name == "label-response":
            s.add_argument("--response", required=True)
            s.add_argument("--labeller", required=True)
        if name == "export":
            s.add_argument("--out", type=Path, default=HERE / "data-real")
    a = p.parse_args(argv)
    return {"advance": cmd_advance, "autolabel": cmd_autolabel, "label-response": cmd_label_response, "export": cmd_export}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
