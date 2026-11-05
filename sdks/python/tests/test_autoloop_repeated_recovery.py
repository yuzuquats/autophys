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


@pytest.mark.parametrize("interrupt_recovery", [False, True])
@pytest.mark.parametrize("repeats", [1, 2])
def test_timestamped_heldout_cost_survives_resume(tmp_path, monkeypatch, repeats, interrupt_recovery):
    import autophys.autoloop as module
    monkeypatch.setattr(module, "_workbook_cost", lambda path: float(path.read_text()))
    strftime = module.time.strftime
    stamp = "20260101T000000"
    monkeypatch.setattr(module.time, "strftime",
                        lambda fmt, value: stamp if fmt == "%Y%m%dT%H%M%S" else strftime(fmt, value))
    heldout_calls = 0

    def evaluate(path, cases, seeds, policy, directory, **options):
        nonlocal heldout_calls
        directory.mkdir(parents=True, exist_ok=False)
        heldout = tuple(seeds) == (3, 4)
        if heldout:
            heldout_calls += 1
        # With repeats, one part completes before the second part is cut off.
        interrupted = heldout and heldout_calls == repeats
        usd = 3.0 if interrupted else 1.0
        (directory / "thermal.ap-workbook").write_text(str(usd))
        if interrupted:
            raise KeyboardInterrupt
        component = {"correct": 1, "mean_log_error": 0.0, "cost_usd": usd}
        return {"score": score([component]), "runs": [{"score": component}], "failing_transcripts": []}

    root = tmp_path / "run"
    options = dict(researcher=NoProposals(), output_dir=root, evaluate_fn=evaluate,
                   policy="scripted", cases=["thermal"], repeats=repeats, max_iterations=0)
    with pytest.raises(KeyboardInterrupt):
        autoloop(**options)
    stamp = "20260102T000000"
    if interrupt_recovery:
        # Fail after the interrupted workbook was charged, before another
        # timestamped attempt starts. The next resume must not charge it twice.
        monotonic = module.time.monotonic
        clock_calls = 0
        def fail_after_recovery():
            nonlocal clock_calls
            clock_calls += 1
            if clock_calls > 1:
                raise OSError("interrupted after heldout recovery")
            return monotonic()
        with monkeypatch.context() as patch:
            patch.setattr(module.time, "monotonic", fail_after_recovery)
            with pytest.raises(OSError, match="interrupted after heldout recovery"):
                autoloop(**options, resume=True)

    summary = autoloop(**options, resume=True)
    entries = [json.loads(line) for line in (root / "spend.jsonl").read_text().splitlines()]
    # Baseline, completed held-out repeats before interruption, the partial
    # workbook ($3), and the successful new timestamped held-out evaluation.
    assert summary["spent_usd"] == pytest.approx(3 * repeats + 2)
    assert sum(entry["usd"] for entry in entries) == summary["spent_usd"]
    assert len({entry["identity"] for entry in entries}) == len(entries)
    assert len([entry for entry in entries if entry["usd"] == 3]) == 1
    assert (root / "heldout/initial-20260101T000000").is_dir()
    assert (root / "heldout/initial-20260102T000000").is_dir()
