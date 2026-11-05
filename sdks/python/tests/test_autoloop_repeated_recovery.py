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


def _legacy_run(tmp_path, monkeypatch):
    import autophys.autoloop as module
    monkeypatch.setattr(module, "_workbook_cost", lambda path: float(path.read_text()))
    strftime = module.time.strftime
    stamp = ["20260101T000000"]
    monkeypatch.setattr(module.time, "strftime",
                        lambda fmt, value: stamp[0] if fmt == "%Y%m%dT%H%M%S" else strftime(fmt, value))
    usd = [1.0]
    def evaluate(path, cases, seeds, policy, directory, **options):
        directory.mkdir(parents=True, exist_ok=False)
        (directory / "thermal.ap-workbook").write_text(str(usd[0]))
        component = {"correct": 1, "mean_log_error": 0.0, "cost_usd": usd[0]}
        return {"score": score([component]), "runs": [{"row": {"case": "thermal", "seed": seeds[0]}, "score": component}], "failing_transcripts": []}
    root = tmp_path / "run"
    options = dict(researcher=NoProposals(), output_dir=root, evaluate_fn=evaluate,
                   policy="scripted", cases=["thermal"], repeats=2, max_iterations=0)
    assert autoloop(**options)["spent_usd"] == 4
    (root / "attempts").rename(root / "old-attempts")
    usd[0] = 0.0
    stamp[0] = "20260102T000000"
    return root, options, stamp, usd


@pytest.mark.parametrize("aggregate", [False, True])
def test_legacy_repeated_charges_are_not_recharged_on_resume(tmp_path, monkeypatch, aggregate):
    root, options, stamp, _ = _legacy_run(tmp_path, monkeypatch)
    labels = ["train/000", "heldout/initial-20260101T000000"]
    entries = ([{"what": label, "usd": 2.0} for label in labels] if aggregate else
               [{"what": f"{label}/r{k}", "usd": 1.0} for label in labels for k in range(2)])
    (root / "spend.jsonl").write_text("".join(json.dumps(e) + "\n" for e in entries))
    options.update(max_iterations=1, max_usd=5)
    for day in (2, 3):
        stamp[0] = f"2026010{day}T000000"
        result = autoloop(**options, resume=True)
        assert result["spent_usd"] == 4
        assert result["stop_reason"] == "researcher has no further proposal"
    assert len((root / "spend.jsonl").read_text().splitlines()) == len(entries)


@pytest.mark.parametrize("crash", [None, "before", "after"])
def test_preledger_completed_workbooks_migrate_atomically(tmp_path, monkeypatch, crash):
    root, options, stamp, _ = _legacy_run(tmp_path, monkeypatch)
    (root / "spend.jsonl").rename(root / "old-spend.jsonl")
    if crash:
        replace = Path.replace
        def fail_commit(path, target):
            if path == root / "spend.jsonl.tmp":
                if crash == "after":
                    replace(path, target)
                raise OSError("migration interrupted")
            return replace(path, target)
        with monkeypatch.context() as patch:
            patch.setattr(Path, "replace", fail_commit)
            with pytest.raises(OSError, match="migration interrupted"):
                autoloop(**options, resume=True)
    assert autoloop(**options, resume=True)["spent_usd"] == 4
    stamp[0] = "20260103T000000"
    assert autoloop(**options, resume=True)["spent_usd"] == 4
    entries = [json.loads(line) for line in (root / "spend.jsonl").read_text().splitlines()]
    assert len(entries) == 1
    assert entries[0]["usd"] == 4
    assert len(entries[0]["covered_workbooks"]) == 4


def test_preledger_ambiguous_heldout_coverage_stops_before_writing(tmp_path, monkeypatch):
    root, options, _, _ = _legacy_run(tmp_path, monkeypatch)
    (root / "spend.jsonl").rename(root / "old-spend.jsonl")
    partial = root / "heldout/initial-20260101T010000/r0"
    partial.mkdir(parents=True)
    (partial / "thermal.ap-workbook").write_text("3.0")
    before = (root / "state.json").read_bytes()
    with pytest.raises(ValueError, match="cannot bind pre-ledger"):
        autoloop(**options, resume=True)
    assert not (root / "spend.jsonl").exists()
    assert (root / "state.json").read_bytes() == before


def test_preledger_interrupted_training_remains_chargeable(tmp_path, monkeypatch):
    root, options, _, usd = _legacy_run(tmp_path, monkeypatch)
    # Only the completed baseline is in this old state. A later candidate has
    # paid for a workbook but has not committed its iteration yet.
    (root / "heldout").rename(root / "old-heldout")
    state = json.loads((root / "state.json").read_text())
    state["spent_usd"] = 2.0
    state.pop("stopped")
    (root / "state.json").write_text(json.dumps(state))
    (root / "spend.jsonl").rename(root / "old-spend.jsonl")
    partial = root / "train/001/r0"
    partial.mkdir(parents=True)
    (partial / "thermal.ap-workbook").write_text("3.0")
    class OneProposal:
        def propose(self, text, report):
            return text + "\nImprove.\n"
    options.update(researcher=OneProposal(), max_iterations=1)
    assert autoloop(**options, resume=True)["spent_usd"] == 5
    # Reusing train/001 for another attempt must not inherit migration coverage.
    # The recovered $3 is bound to the old attempt and stays charged once.
    assert autoloop(**options, resume=True)["spent_usd"] == 5


def test_migration_coverage_does_not_hide_a_replacement_attempt(tmp_path, monkeypatch):
    root, options, _, _ = _legacy_run(tmp_path, monkeypatch)
    (root / "spend.jsonl").rename(root / "old-spend.jsonl")
    assert autoloop(**options, resume=True)["spent_usd"] == 4
    state = json.loads((root / "state.json").read_text())
    state.pop("incumbent")
    (root / "state.json").write_text(json.dumps(state))
    evaluate = options["evaluate_fn"]
    failed = False
    def interrupt(path, cases, seeds, policy, directory, **kw):
        nonlocal failed
        if not failed:
            failed = True
            directory.mkdir(parents=True)
            (directory / "thermal.ap-workbook").write_text("3.0")
            raise KeyboardInterrupt
        return evaluate(path, cases, seeds, policy, directory, **kw)
    options["evaluate_fn"] = interrupt
    with pytest.raises(KeyboardInterrupt):
        autoloop(**options, resume=True)
    assert autoloop(**options, resume=True)["spent_usd"] == 7
    assert autoloop(**options, resume=True)["spent_usd"] == 7
