"""Backtest examples: references, the built-in catalogue and the repository copies."""

from pathlib import Path

import pytest

import autophys
from autophys import backtest as bt
from autophys.synthetic import CASES, PLANTED_CASES, case, run_case

REPO_EXAMPLES = Path(__file__).resolve().parents[3] / "examples"


def test_references_parse():
    assert bt.parse_ref("battery") == bt.Ref("builtin", "battery")
    assert bt.parse_ref("builtin:battery#short-only").case == "short-only"
    assert bt.parse_ref("battery.backtest").source == "battery"
    assert bt.parse_ref("./x.backtest#c") == bt.Ref("path", "./x.backtest", "c")
    assert bt.parse_ref("path:x.backtest").scheme == "path"
    assert bt.parse_ref("builtin:battery#full").canonical() == "builtin:battery#full"
    for bad in ["github:a/b", "Battery", "battery#", "battery#Full", "path:", "builtin:"]:
        with pytest.raises(ValueError):
            bt.parse_ref(bad)


def test_the_suite_keeps_its_ids_and_order():
    assert list(CASES) == ["oscillator-free-only", "oscillator", "thermal-short-only", "thermal",
                           "battery-short-only", "battery"]
    assert list(PLANTED_CASES) == ["battery-biased"]
    assert bt.expand(["battery#full", "oscillator"]) == ["battery", "oscillator-free-only", "oscillator"]
    assert bt.reference_of("battery-short-only") == "builtin:battery#short-only"
    with pytest.raises(KeyError):
        case("battery#nope")
    with pytest.raises((KeyError, ValueError)):
        bt.expand(["nope"])


@pytest.mark.skipif(not REPO_EXAMPLES.is_dir(), reason="needs the repository examples/")
def test_package_copies_match_the_repository_examples():
    pkg = Path(autophys.__file__).parent / "backtests"
    for name in bt.BUILTIN:
        for rel in ("example.toml", "hidden/cases.toml"):
            ours = (pkg / f"{name}.backtest" / rel).read_bytes()
            assert ours == (REPO_EXAMPLES / f"{name}.backtest" / rel).read_bytes(), (name, rel)


def test_a_path_backtest_loads_with_reference_ids(tmp_path):
    src = Path(autophys.__file__).parent / "backtests" / "thermal.backtest"
    d = tmp_path / "cell.backtest"
    (d / "hidden").mkdir(parents=True)
    (d / "example.toml").write_bytes((src / "example.toml").read_bytes())
    (d / "hidden" / "cases.toml").write_bytes((src / "hidden" / "cases.toml").read_bytes())
    b, name = bt.resolve_case(f"{d}#full")
    cid = b.case(name).id
    assert cid == f"path:{d.resolve()}#full"
    view, ev = case(f"{d}#full")(0)
    assert view.name == ev.case == cid
    row = run_case(f"{d}#short-only", "scripted", 0)
    assert row.diagnosis_correct
    with pytest.raises(ValueError):
        bt.Backtest.load_dir(tmp_path)
