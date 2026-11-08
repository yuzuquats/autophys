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


def test_drawn_truth_matches_the_rust_sdk():
    b = bt.Backtest.builtin("battery")
    assert b.truth_for(1) == b.truth
    drawn = b.truth_for(1, drawn=True)
    # The same draws as sdks/rust/src/backtest.rs (DRAW_BATTERY_SEED_1).
    expected = [2.207476884798e-2, 4.301236879664e-2, 1.609221981739e3]
    assert list(drawn) == ["R0", "R1", "C1"]
    for got, want in zip(drawn.values(), expected):
        assert got == pytest.approx(want, rel=1e-11)
    assert b.truth_for(2, drawn=True) != drawn
    _, ev = case("battery")(1)
    assert ev.truth == b.truth
    row = run_case("battery-short-only", "scripted", 1, truth="drawn")
    assert row.example == "builtin:battery#short-only"


def _thermal_csv(name, settings):
    import numpy as np

    from autophys.models import thermal_rc
    from autophys.synthetic import NoiseModel, observe

    o = observe(thermal_rc, {"C": 500.0, "R": 2.0}, settings, NoiseModel({"T": 0.05}), np.random.default_rng(7), name=name)
    return "time,temp\n" + "".join(f"{t!r},{v!r}\n" for t, v in zip(o.t, o.y["T"]))


def _dataset_example(d, by_url):
    import hashlib

    runs = [("step_short", {"kind": "step", "power": 10.0, "duration": 120.0, "rate": 1.0}, False),
            ("step_long", {"kind": "step", "power": 10.0, "duration": 3000.0, "rate": 0.1}, False),
            ("pulse", {"kind": "pulse", "power": 15.0, "on": 900.0, "duration": 4000.0, "rate": 0.1}, True)]
    public = ('kind = "backtest"\ntitle = "Recorded heater"\nsummary = "s"\nlanguages = []\n[system]\nmodel = "thermal_rc"\n'
              '[[case]]\nname = "rec"\nsource = "datasets"\nbudget = { max_experiments = 1 }\ntrain = ["step_short"]\n')
    hidden = ('[truth]\nC = 500.0\nR = 2.0\n[case.rec]\ntest = ["pulse"]\n'
              'combos = { C = { C = 1.0 }, R = { R = 1.0 } }\nexpected_non_identified = []\n')
    (d / "data").mkdir(parents=True)
    (d / "hidden").mkdir()
    for name, settings, held_out in runs:
        text = _thermal_csv(name, settings)
        (d / "data" / f"{name}.csv").write_text(text)
        place = f'url = "file://{d / "data" / (name + ".csv")}"' if by_url else f'file = "data/{name}.csv"'
        inline = ", ".join(f"{k} = {v!r}" if not isinstance(v, str) else f'{k} = "{v}"' for k, v in settings.items())
        entry = (f'[[dataset]]\nname = "{name}"\nsettings = {{ {inline} }}\n{place}\n'
                 f'sha256 = "{hashlib.sha256(text.encode()).hexdigest()}"\ncolumns = {{ t = "time", T = "temp" }}\n'
                 'sigma = { T = 0.05 }\nprovenance = "synthetic"\n')
        if held_out:
            hidden += entry
        else:
            public += entry
    (d / "example.toml").write_text(public)
    (d / "hidden" / "cases.toml").write_text(hidden)


def test_a_dataset_case_replays_recorded_runs(tmp_path):
    d = tmp_path / "heater.backtest"
    _dataset_example(d, by_url=False)
    b, name = bt.resolve_case(f"{d}#rec")
    view, ev = b.build(b.case(name), 0)
    assert list(view.catalog) == ["step_long"] and view.catalog["step_long"]["max_runs"] == 1
    assert "pulse" not in view.simulator.experiments
    assert len(list(view.dataset)) == 1 and len(ev.test) == 1
    o = view.runner.run("step_long")
    assert (o.experiment, o.source, len(o.t)) == ("step_long", "synthetic", 301)
    with pytest.raises(KeyError):
        view.runner.run("step_long")
    row = run_case(f"{d}#rec", "scripted", 0)
    assert row.example == f"path:{d.resolve()}#rec" and row.status in ("validated", "inconclusive")
    (d / "data" / "step_long.csv").write_text("time,temp\n0,1\n")
    with pytest.raises(ValueError):
        b.build(b.case(name), 0)


def test_urls_are_fetched_once_into_the_data_directory(tmp_path, monkeypatch):
    d = tmp_path / "heater.backtest"
    _dataset_example(d, by_url=True)
    monkeypatch.setenv("AUTOPHYS_DATASETS_DIR", str(tmp_path / "cache"))
    b, name = bt.resolve_case(f"{d}#rec")
    b.build(b.case(name), 0)
    assert len(list((tmp_path / "cache").iterdir())) == 3
    import shutil

    shutil.rmtree(d / "data")
    b.build(b.case(name), 0)


def test_a_backtest_can_bring_its_own_python_simulator(tmp_path):
    src = Path(autophys.__file__).parent / "backtests" / "thermal.backtest"
    d = tmp_path / "lab.backtest"
    (d / "hidden").mkdir(parents=True)
    (d / "example.toml").write_text((src / "example.toml").read_text().replace('model = "thermal_rc"', 'project = "lab_sim_module:simulator"'))
    (d / "hidden" / "cases.toml").write_bytes((src / "hidden" / "cases.toml").read_bytes())
    (d / "lab_sim_module.py").write_text("from autophys.models import thermal_rc as simulator\n")
    b, name = bt.resolve_case(f"{d}#full")
    assert b.project == "lab_sim_module:simulator"
    view, ev = b.build(b.case(name), 0)
    assert view.simulator.name == "thermal_rc" and ev.truth == b.truth


@pytest.mark.skipif(not (REPO_EXAMPLES / "battery-recorded.backtest" / "data").is_dir(), reason="needs the repository data/")
def test_the_recorded_battery_backtest_builds_from_a_filled_cache(tmp_path, monkeypatch):
    import hashlib

    for f in (REPO_EXAMPLES / "battery-recorded.backtest" / "data").iterdir():
        data = f.read_bytes()
        (tmp_path / hashlib.sha256(data).hexdigest()).write_bytes(data)
    monkeypatch.setenv("AUTOPHYS_DATASETS_DIR", str(tmp_path))
    view, ev = case("battery-recorded#two-tests")(0)
    assert view.name == "battery-recorded"
    assert list(view.catalog) == ["discharge_1A", "pulse_2A", "pulse_train"]
    assert len(list(view.dataset)) == 2 and len(ev.test) == 1
    assert "battery-recorded" not in CASES and "battery-recorded" not in PLANTED_CASES
