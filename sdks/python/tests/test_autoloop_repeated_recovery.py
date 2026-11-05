"""Regression: a retried repeat must not inherit an earlier repeat's charge."""
import json
from pathlib import Path

import pytest

from autophys.autoloop import autoloop
from autophys.research import score


class NoProposals:
    def propose(self, text, report):
        return None


@pytest.mark.parametrize("interrupt_recovery", [False, True])
def test_replacement_repeat_partial_cost_survives_repeated_resume(tmp_path, monkeypatch, interrupt_recovery):
    import autophys.autoloop as module
    monkeypatch.setattr(module, "_workbook_cost", lambda path: float(path.read_text()))
    calls = 0

    def evaluate(path, cases, seeds, policy, directory, **options):
        nonlocal calls
        calls += 1
        directory.mkdir(parents=True, exist_ok=False)
        # First attempt: r0 completes ($1), r1 records $2 and is interrupted.
        # Replacement attempt: r0 records $3 and is interrupted as well.
        usd = float(calls) if calls <= 3 else 1.0
        (directory / "thermal.ap-workbook").write_text(str(usd))
        if calls in (2, 3):
            raise KeyboardInterrupt
        component = {"correct": 1, "mean_log_error": 0.0, "cost_usd": usd}
        return {"score": score([component]), "runs": [{"score": component}], "failing_transcripts": []}

    options = dict(researcher=NoProposals(), output_dir=tmp_path / "run", evaluate_fn=evaluate,
                   policy="scripted", cases=["thermal"], repeats=2, max_iterations=0)
    with pytest.raises(KeyboardInterrupt):
        autoloop(**options)
    with pytest.raises(KeyboardInterrupt):
        autoloop(**options, resume=True)

    if interrupt_recovery:
        # Crash after recovering the new partial workbook but before archiving it.
        # The next resume must not charge that workbook a second time.
        rename = Path.rename
        def fail_archive(path, target):
            if path == tmp_path / "run/train/000":
                raise OSError("interrupted recovery")
            return rename(path, target)
        with monkeypatch.context() as patch:
            patch.setattr(Path, "rename", fail_archive)
            with pytest.raises(OSError, match="interrupted recovery"):
                autoloop(**options, resume=True)

    summary = autoloop(**options, resume=True)
    # Original r0 ($1), partial original r1 ($2), partial replacement r0 ($3),
    # successful baseline ($2), and held-out ($2).
    assert summary["spent_usd"] == pytest.approx(10.0)
    entries = [json.loads(line) for line in (tmp_path / "run/spend.jsonl").read_text().splitlines()]
    assert [entry["usd"] for entry in entries] == [1, 2, 3, 1, 1, 1, 1]
    assert len({entry["identity"] for entry in entries}) == len(entries)
    assert len(list((tmp_path / "run/train").glob("000.interrupted-*"))) == 2
