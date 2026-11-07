#!/usr/bin/env python3
"""Distil the scripted policy into chat SFT rows. Offline: no network, no tokens.

Each step's prompt is produced by the SDK's own ``ReasonLanePolicy`` (so it
is byte-identical to what the Python reason policy sends, e.g.
``autophys.synthetic.run_case(case, "reason", ...)`` behind ``autophys train
eval``; the Rust ``autophys bench --policy reason`` renders the same system
prompt and facts format from its own solver's numbers), and its
"model" is a ``FakeReasoner`` that answers with ``ScriptedPolicy``'s choice
for the same facts. The investigation then parses that answer with the
loop's own ``Decision.parse``, so every target is checked by the real
validator. Each teacher-forced trajectory is also checked against a plain
``ScriptedPolicy`` run of the same case and seed (same steps, status and
estimate).

Splits are by seed. Held-out seeds (default 3,4, the ``autophys research``
default) are written to ``heldout.jsonl`` only for later evaluation; they must
never appear in ``train.jsonl`` or ``validation.jsonl``.

Training rows use role ``system`` for the SDK's ``developer`` message: the
Qwen3.6 template rejects ``developer``. The serving template produced by
``patch_chat_template.py`` renders ``developer`` exactly as ``system``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

from autophys.agent import Decision, Investigation, ReasonLanePolicy, ScriptedPolicy, system_prompt
from autophys.synthetic import case_project
from autophys.reasoner import FakeReasoner, parse_json_content
from autophys.store import MemoryStore
from autophys.synthetic import CASES


def seeds(text: str) -> list[int]:
    out: list[int] = []
    for part in text.split(","):
        a, _, b = part.partition("-")
        out.extend(range(int(a), int(b) + 1) if b else [int(a)])
    return out


def target_text(d: Decision) -> str:
    return json.dumps(d.to_dict(), ensure_ascii=False)


class DistilPolicy:
    """The model-driven lane, answered by the scripted teacher."""

    name = "scripted-distil"

    def __init__(self, playbook: str) -> None:
        self.teacher = ScriptedPolicy()
        self._answer: str | None = None
        self.fake = FakeReasoner(lambda messages: self._answer, model="scripted-teacher")
        self.lane = ReasonLanePolicy(self.fake, playbook=playbook)
        self.playbook = self.lane.playbook
        self.steps: list[dict] = []

    def meta(self) -> dict:
        return self.lane.meta()

    def decide(self, facts: dict):
        decision = self.teacher._choose(facts)
        self._answer = target_text(decision)
        raw, trace = self.lane.decide(facts)
        call = self.fake.calls[-1]
        self.steps.append({"messages": call["messages"], "response_schema": call["response_schema"],
                           "target": self._answer, "action": decision.action})
        return raw, trace


def run(case: str, seed: int, playbook: str) -> tuple[list[dict], dict]:
    view, evaluator = CASES[case](seed)
    project = case_project(view)
    policy = DistilPolicy(playbook)
    inv = Investigation(project, view.dataset, view.runner, policy=policy, store=MemoryStore(), seed=seed,
                        title=f"distil {case} seed {seed}")
    out = inv.run()

    # Every recorded step must have been accepted by the loop's validator.
    steps = inv.store.records(inv.id, "step")
    assert len(steps) == len(policy.steps) == out.steps, (case, seed)
    assert all(r.payload.get("valid") for r in steps), f"{case}/{seed}: invalid step"
    for s in policy.steps:  # re-validate independently of the loop
        Decision.parse(parse_json_content(s["target"]), param_names=inv.sim.param_names, catalog=list(project.catalog))

    # The teacher-forced trajectory must equal the plain scripted policy's.
    view2, _ = CASES[case](seed)
    ref = Investigation(case_project(view2), view2.dataset, view2.runner, policy=ScriptedPolicy(),
                        store=MemoryStore(), seed=seed).run()
    same = (ref.status, ref.steps, ref.estimate, ref.experiments) == (out.status, out.steps, out.estimate, out.experiments)
    assert same, f"{case}/{seed}: distilled trajectory differs from ScriptedPolicy"

    rel = evaluator.relative_errors(out.estimate) if out.estimate else {}
    physical = set(view.simulator.param_names)
    score = {"status": out.status, "max_rel_error": max(rel.values()) if rel else None, "rel_errors": rel,
             "test_rmse": evaluator.test_rmse(view.simulator, out.estimate) if out.estimate else None,
             "diagnosis_correct": evaluator.diagnosis_correct(set(out.non_identified) & physical),
             "guardrail_overrides": out.guardrail_overrides, "steps": out.steps, "experiments": out.experiments}
    rows = []
    for i, s in enumerate(policy.steps):
        (dev, user) = s["messages"]
        assert dev["role"] == "developer" and user["role"] == "user"
        rows.append({
            "row": {"messages": [{"role": "system", "content": dev["content"]},
                                 {"role": "user", "content": user["content"]},
                                 {"role": "assistant", "content": s["target"], "weight": 1}]},
            "meta": {"case": case, "seed": seed, "step": i + 1, "action": s["action"],
                     "sdk_messages_sha256": hashlib.sha256(json.dumps(s["messages"], sort_keys=True).encode()).hexdigest(),
                     "response_schema_sent": s["response_schema"] is not None},
        })
    return rows, score


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--out", type=Path, default=Path(__file__).parent / "data")
    p.add_argument("--train-seeds", type=seeds, default=seeds("0,1,2"))
    p.add_argument("--val-seeds", type=seeds, default=seeds("5,6"))
    p.add_argument("--heldout-seeds", type=seeds, default=seeds("3,4"))
    p.add_argument("--case", action="append", help="default: every synthetic case")
    p.add_argument("--playbook", default="default")
    a = p.parse_args(argv)
    tr, va, ho = set(a.train_seeds), set(a.val_seeds), set(a.heldout_seeds)
    if tr & ho or va & ho or tr & va:
        p.error("train, validation and held-out seeds must be disjoint")
    cases = a.case or list(CASES)
    a.out.mkdir(parents=True, exist_ok=True)
    system = system_prompt(a.playbook)
    manifest = {"system_prompt_sha256": hashlib.sha256(system.encode()).hexdigest(), "playbook": a.playbook,
                "cases": cases, "splits": {}, "trajectories": []}
    for split, split_seeds in (("train", a.train_seeds), ("validation", a.val_seeds), ("heldout", a.heldout_seeds)):
        rows_out, meta_out, actions = [], [], Counter()
        for case in cases:
            for seed in split_seeds:
                rows, score = run(case, seed, a.playbook)
                manifest["trajectories"].append({"split": split, "case": case, "seed": seed, **score})
                for r in rows:
                    rows_out.append(r["row"])
                    meta_out.append(r["meta"])
                    actions[r["meta"]["action"]] += 1
        with open(a.out / f"{split}.jsonl", "w") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows_out)
        with open(a.out / f"{split}.meta.jsonl", "w") as f:
            f.writelines(json.dumps(m) + "\n" for m in meta_out)
        prompts = {json.dumps(r["messages"][:2]) for r in rows_out}
        manifest["splits"][split] = {"seeds": split_seeds, "rows": len(rows_out), "distinct_prompts": len(prompts),
                                     "actions": dict(sorted(actions.items()))}
        print(f"{split:10s} seeds={','.join(map(str, split_seeds))} rows={len(rows_out)} "
              f"distinct_prompts={len(prompts)} actions={dict(sorted(actions.items()))}")
    (a.out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    print(f"system_prompt_sha256={manifest['system_prompt_sha256']}")
    print("all targets parsed by Decision.parse; all trajectories equal ScriptedPolicy")
    return 0


if __name__ == "__main__":
    sys.exit(main())
