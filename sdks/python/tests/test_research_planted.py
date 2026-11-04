"""The research loop finds a planted strategy fix, offline and end to end.

battery-biased (PLANTED_CASES) has a voltage sensor that reads 10 mV high. A playbook
that never compares model variants ends it inconclusive with ~250% parameter errors;
comparing the sensor-bias variant when the fit is poor validates it. The research loop
must keep that edit, reject a later regression, and improve the held-out score.
"""
import json

import pytest

from autophys.bench import run_case, strategy_settings
from autophys.cli import main
from autophys.playbook import load_playbook
from autophys.research import ScriptedResearcher, research

DEFAULT = load_playbook().data.decode().rstrip("\n")
NEVER = DEFAULT + "\n\nSettings:\n- compare_variants: never\n"
FIX = DEFAULT + "\n\nSettings:\n- compare_variants: on_misfit\n"
WORSE = FIX + "- experiments: none\n"
CASES = ["battery-biased", "battery"]


def test_strategy_settings_default_and_parse():
    assert strategy_settings("") == {"compare_variants": "on_misfit", "experiments": "as_needed"}
    assert strategy_settings("x\nStrategy:\n" + WORSE) == {"compare_variants": "on_misfit", "experiments": "none"}
    with pytest.raises(ValueError):
        strategy_settings("Strategy:\n- experiments: sometimes\n")


@pytest.mark.parametrize("text,status", [(NEVER, "inconclusive"), (FIX, "validated")])
def test_settings_steer_the_fake_reasoner(tmp_path, text, status):
    playbook = tmp_path / "SKILL.md"
    playbook.write_text(text)
    row = run_case("battery-biased", "fake-reasoner", 0, playbook=str(playbook))
    assert row.status == status
    assert (row.max_rel_error < 0.05) == (status == "validated")


def test_research_keeps_the_planted_fix_and_rejects_a_regression(tmp_path):
    start = tmp_path / "start.md"
    start.write_text(NEVER)
    summary = research(researcher=ScriptedResearcher([FIX, WORSE]), output_dir=tmp_path / "run", playbook=start,
                       policy="fake-reasoner", cases=CASES, train_seeds=(0, 1), heldout_seeds=(2, 3), iterations=2)
    assert [i["accepted"] for i in summary["iterations"]] == [True, False]
    assert summary["final_playbook"] == "playbook-001.md"
    assert summary["train"]["correct"] == 4
    assert summary["heldout_initial"]["correct"] == 2
    assert summary["heldout_final"]["correct"] == 4
    rejected = summary["iterations"][1]["score"]
    assert rejected["correct"] < summary["train"]["correct"]


def test_cli_runs_the_research_loop_offline(tmp_path, capsys):
    paths = []
    for name, text in (("start", NEVER), ("fix", FIX), ("worse", WORSE)):
        paths.append(tmp_path / f"{name}.md")
        paths[-1].write_text(text)
    argv = ["research", "--policy", "fake-reasoner", "--researcher", "scripted",
            "--playbook", str(paths[0]), "--edit", str(paths[1]), "--edit", str(paths[2]),
            "--case", CASES[0], "--case", CASES[1], "--train-seeds", "0,1", "--heldout-seeds", "2,3",
            "--iterations", "2", "--output-dir", str(tmp_path / "cli")]
    assert main(argv) == 0
    summary = json.loads((tmp_path / "cli/summary.json").read_text())
    assert [i["accepted"] for i in summary["iterations"]] == [True, False]
    assert (summary["heldout_initial"]["correct"], summary["heldout_final"]["correct"]) == (2, 4)


def test_scripted_researcher_runs_out_cleanly(tmp_path):
    # Out of edits is "nothing further to propose": research stops iterating early.
    assert ScriptedResearcher([]).propose(DEFAULT, {}) is None
