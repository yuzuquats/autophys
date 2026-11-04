"""The autoloop runs closed and unattended, journals every iteration, and resumes.

The end-to-end tests use the offline HeuristicResearcher and the playbook-sensitive
fake reasoner on the planted battery-biased case (see test_research_planted.py), so
the loop has a real fix to find. The rest use a fast fake evaluator.
"""
import json

import pytest

from autophys.autoloop import HeuristicResearcher, autoloop, set_setting
from autophys.cli import main
from autophys.playbook import load_playbook
from autophys.research import score

DEFAULT = load_playbook().data.decode().rstrip("\n")
NEVER = DEFAULT + "\n\nSettings:\n- compare_variants: never\n"
CASES = ["battery-biased", "battery"]


def test_set_setting_edits_or_appends():
    assert set_setting(NEVER, "compare_variants", "on_misfit").endswith("- compare_variants: on_misfit\n")
    appended = set_setting(DEFAULT + "\n", "experiments", "none")
    assert appended.endswith("\n\nSettings:\n- experiments: none\n")
    assert set_setting(appended, "compare_variants", "never").count("Settings:") == 1


def test_autoloop_finds_the_planted_fix_by_itself(tmp_path):
    start = tmp_path / "start.md"
    start.write_text(NEVER)
    run = tmp_path / "run"
    summary = autoloop(researcher=HeuristicResearcher(), output_dir=run, playbook=start, policy="fake-reasoner",
                       cases=CASES, train_seeds=(0, 1), heldout_seeds=(2, 3), max_iterations=5)
    assert summary["stop_reason"] == "researcher has no further proposal"
    assert (summary["iterations"], summary["accepted"]) == (1, 1)
    assert (summary["train_initial"]["correct"], summary["train_final"]["correct"]) == (2, 4)
    assert (summary["heldout_initial"]["correct"], summary["heldout_final"]["correct"]) == (2, 4)
    [entry] = [json.loads(line) for line in (run / "journal.jsonl").read_text().splitlines()]
    assert entry["accepted"] and "sensor-bias variant" in entry["hypothesis"]
    assert "+- compare_variants: on_misfit" in entry["diff"]
    state = json.loads((run / "state.json").read_text())
    assert state["incumbent"] == "001.md" and state["stopped"]["reason"] == summary["stop_reason"]


def test_cli_autoloop_runs_offline(tmp_path):
    start = tmp_path / "start.md"
    start.write_text(NEVER)
    argv = ["autoloop", "--researcher", "heuristic", "--policy", "fake-reasoner", "--playbook", str(start),
            "--case", CASES[0], "--case", CASES[1], "--train-seeds", "0,1", "--heldout-seeds", "2,3",
            "--output-dir", str(tmp_path / "cli")]
    assert main(argv) == 0
    summary = json.loads((tmp_path / "cli/summary.json").read_text())
    assert (summary["heldout_initial"]["correct"], summary["heldout_final"]["correct"]) == (2, 4)


def _component(correct, error):
    return {"correct": correct, "mean_log_error": error, "cost_usd": 0.0}


class FakeEval:
    """Scores a playbook by the number of 'Improve.' lines; counts evaluations."""

    def __init__(self):
        self.calls = []

    def __call__(self, path, cases, seeds, policy, directory, **kw):
        text = path.read_text()
        self.calls.append((tuple(seeds), path.name))
        n = text.count("Improve.")
        return {"score": score([_component(n, 1.0 / (1 + n))]), "runs": [], "failing_transcripts": []}


class Proposer:
    """Proposes from a list; records the history each call received."""

    def __init__(self, edits, cost=0.0):
        self.edits, self.cost, self.histories = list(edits), cost, []
        self.last_usage = None

    def propose(self, text, report, history=None):
        self.histories.append(history)
        self.last_usage = {"cost_usd": self.cost}
        if not self.edits:
            return None
        edit = self.edits.pop(0)
        return {"skill": text + edit, "hypothesis": f"adds {edit.strip()}", "prediction": "better"}


def _run(tmp_path, researcher, **kw):
    start = tmp_path / "start.md"
    start.write_text(DEFAULT + "\n")
    evaluate = kw.pop("evaluate_fn", FakeEval())
    summary = autoloop(researcher=researcher, output_dir=tmp_path / "run", playbook=start, policy="scripted",
                       cases=["thermal"], evaluate_fn=evaluate, **kw)
    return summary, evaluate


def test_patience_stops_after_rejections_and_history_is_passed(tmp_path):
    researcher = Proposer(["\nImprove.\n", "\nNoise.\n", "\nNoise again.\n", "\nImprove.\n"])
    summary, _ = _run(tmp_path, researcher, patience=2)
    assert summary["stop_reason"] == "2 rejections in a row"
    assert summary["iterations"] == 3 and summary["accepted"] == 1
    assert [len(h) for h in researcher.histories] == [0, 1, 2]
    assert researcher.histories[2][1]["accepted"] is False and "Noise." in researcher.histories[2][1]["diff"]
    assert "heldout" not in json.dumps(researcher.histories)


def test_invalid_and_unchanged_proposals_are_journalled_not_fatal(tmp_path):
    class Bad:
        last_usage = None
        def __init__(self):
            self.n = 0
        def propose(self, text, report):
            self.n += 1
            return text if self.n == 1 else {"skill": None} if self.n == 2 else None
    summary, _ = _run(tmp_path, Bad(), patience=5)
    journal = [json.loads(l) for l in (tmp_path / "run/journal.jsonl").read_text().splitlines()]
    assert [e["reason"].split(":")[0] for e in journal] == ["invalid edit", "invalid edit"]
    assert summary["stop_reason"] == "researcher has no further proposal"


def test_stop_file_budget_and_max_iterations(tmp_path):
    (tmp_path / "a").mkdir()
    summary, _ = _run(tmp_path / "a", Proposer(["\nImprove.\n"] * 9), max_iterations=2)
    assert summary["stop_reason"] == "max iterations" and summary["iterations"] == 2
    (tmp_path / "b").mkdir()
    summary, _ = _run(tmp_path / "b", Proposer(["\nImprove.\n"] * 9, cost=0.4), max_usd=1.0)
    assert summary["stop_reason"] == "budget" and summary["iterations"] == 3
    assert summary["spent_usd"] == pytest.approx(1.2)


def test_resume_continues_without_rescoring_the_baseline(tmp_path):
    first = Proposer(["\nImprove.\n"])
    summary, evaluate = _run(tmp_path, first, max_iterations=1)
    assert summary["accepted"] == 1
    (tmp_path / "run/STOP").write_text("")
    second = Proposer(["\nImprove.\n"])
    stopped = autoloop(researcher=second, output_dir=tmp_path / "run", resume=True, max_iterations=5,
                       evaluate_fn=evaluate)
    assert stopped["stop_reason"] == "stop file" and stopped["iterations"] == 1
    (tmp_path / "run/STOP").unlink()
    resumed = autoloop(researcher=second, output_dir=tmp_path / "run", resume=True, max_iterations=5,
                       evaluate_fn=evaluate)
    assert resumed["iterations"] == 2 and resumed["accepted"] == 2 and resumed["final_playbook"] == "002.md"
    trains = [c for c in evaluate.calls if c[0] == (0, 1, 2)]
    assert [name for _, name in trains] == ["000.md", "001.md", "002.md"]
    assert len(second.histories[0]) == 1


def test_resume_requires_a_run(tmp_path):
    with pytest.raises(ValueError):
        autoloop(researcher=Proposer([]), output_dir=tmp_path / "none", resume=True)


# --- AR-3: paired bootstrap acceptance -------------------------------------------

from autophys.research import paired_bootstrap


def _runs(correct_by_unit, error=0.1):
    return [{"row": {"case": case, "seed": seed}, "score": {"correct": c, "mean_log_error": error, "cost_usd": 0.0}}
            for (case, seed), c in correct_by_unit.items()]


UNITS = [(f"c{i % 7}", i // 7) for i in range(21)]


def test_bootstrap_rejects_a_single_lucky_unit_and_accepts_a_consistent_gain():
    base = {u: False for u in UNITS}
    lucky = {**base, UNITS[0]: True}
    accepted, stats = paired_bootstrap(_runs(lucky), _runs(base))
    assert not accepted and stats["metric"] == "correct" and stats["improved"] == 1 and stats["p_better"] < 0.95
    consistent = {**base, **{u: True for u in UNITS[:6]}}
    accepted, stats = paired_bootstrap(_runs(consistent), _runs(base))
    assert accepted and stats["improved"] == 6 and stats["p_better"] >= 0.95


def test_bootstrap_falls_back_to_error_and_rejects_mismatched_or_unchanged_units():
    same = {u: True for u in UNITS}
    accepted, stats = paired_bootstrap(_runs(same, error=0.01), _runs(same, error=0.5))
    assert accepted and stats["metric"] == "mean_log_error"
    accepted, stats = paired_bootstrap(_runs(same), _runs(same))
    assert not accepted and stats["reason"] == "no unit changed"
    accepted, stats = paired_bootstrap(_runs({UNITS[0]: True}), _runs({UNITS[1]: False}))
    assert not accepted and "same units" in stats["reason"]
    # Missing estimates (null/inf errors) are capped rather than breaking the comparison.
    nulls = [dict(r, score=dict(r["score"], mean_log_error=None)) for r in _runs(same)]
    accepted, stats = paired_bootstrap(_runs(same), nulls)
    assert accepted and stats["metric"] == "mean_log_error"


class UnitEval:
    """Per-unit fake evaluator: 'Lucky.' fixes one unit, 'Solid.' fixes six; counts repeats."""

    def __init__(self):
        self.dirs = []

    def __call__(self, path, cases, seeds, policy, directory, **kw):
        self.dirs.append(directory.name)
        text = path.read_text()
        fixed = 6 if "Solid." in text else 1 if "Lucky." in text else 0
        runs = _runs({u: i < fixed for i, u in enumerate(UNITS)})
        return {"runs": runs, "score": score([r["score"] for r in runs]), "failing_transcripts": []}


def test_autoloop_bootstrap_keeps_only_the_robust_edit(tmp_path):
    researcher = Proposer(["\nLucky.\n", "\nSolid.\n"])
    summary, _ = _run(tmp_path, researcher, evaluate_fn=UnitEval(), acceptance="bootstrap", patience=5)
    journal = [json.loads(l) for l in (tmp_path / "run/journal.jsonl").read_text().splitlines()]
    assert [e["accepted"] for e in journal] == [False, True]
    assert journal[0]["acceptance"]["improved"] == 1 and journal[0]["acceptance"]["rule"] == "paired-bootstrap"
    assert summary["acceptance"] == "bootstrap" and summary["final_playbook"] == "002.md"
    assert summary["heldout_comparison"]["improved"] == 6
    # The researcher sees why its earlier edit was rejected.
    assert researcher.histories[1][0]["acceptance"]["p_better"] < 0.95


def test_lexicographic_keeps_the_lucky_edit_and_auto_resolves_by_policy(tmp_path):
    summary, _ = _run(tmp_path, Proposer(["\nLucky.\n"]), evaluate_fn=UnitEval())
    assert summary["acceptance"] == "lexicographic" and summary["accepted"] == 1
    with pytest.raises(ValueError):
        (tmp_path / "x").mkdir()
        _run(tmp_path / "x", Proposer([]), acceptance="vibes")


def test_repeats_score_each_playbook_several_times(tmp_path):
    evaluate = UnitEval()
    summary, _ = _run(tmp_path, Proposer(["\nSolid.\n"]), evaluate_fn=evaluate, acceptance="bootstrap", repeats=2)
    assert evaluate.dirs[:2] == ["r0", "r1"] and summary["train_final"]["correct"] == 12
    state = json.loads((tmp_path / "run/state.json").read_text())
    assert state["config"]["repeats"] == 2 and state["config"]["acceptance"] == "bootstrap"


def test_bootstrap_autoloop_finds_the_planted_fix(tmp_path):
    start = tmp_path / "start.md"
    start.write_text(NEVER)
    summary = autoloop(researcher=HeuristicResearcher(), output_dir=tmp_path / "run", playbook=start,
                       policy="fake-reasoner", cases=["battery-biased"], train_seeds=(0, 1, 2, 3, 4),
                       heldout_seeds=(5, 6), acceptance="bootstrap")
    assert summary["accepted"] == 1 and summary["train_final"]["correct"] == 5
    entry = json.loads((tmp_path / "run/journal.jsonl").read_text().splitlines()[0])
    assert entry["acceptance"]["p_better"] == 1.0


def test_an_invalid_setting_value_is_a_rejected_edit_not_a_crash(tmp_path):
    researcher = Proposer(["\n- compare_variants: always\n"])
    summary, evaluate = _run(tmp_path, researcher, patience=5)
    [entry] = [json.loads(l) for l in (tmp_path / "run/journal.jsonl").read_text().splitlines()]
    assert entry["reason"].startswith("invalid edit") and "compare_variants" in entry["reason"]
    assert summary["stop_reason"] == "researcher has no further proposal"


def test_a_researcher_that_rejects_its_own_output_is_journalled(tmp_path):
    from autophys.research import _InvalidEdit, validate_edit

    class SelfValidating:
        last_usage = None
        last_events = {"terminal": "completed", "usage": {"calls": 3}, "message": "ok"}
        def __init__(self):
            self.n = 0
        def propose(self, text, report):
            self.n += 1
            if self.n == 1:
                return validate_edit(text, text)  # raises: unchanged
            return None
    summary, _ = _run(tmp_path, SelfValidating(), patience=5)
    [entry] = [json.loads(l) for l in (tmp_path / "run/journal.jsonl").read_text().splitlines()]
    assert entry["reason"] == "invalid edit: researcher left SKILL.md unchanged"
    assert entry["researcher_events"] == {"terminal": "completed", "usage": {"calls": 3}}
    assert summary["stop_reason"] == "researcher has no further proposal"
