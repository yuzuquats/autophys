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
