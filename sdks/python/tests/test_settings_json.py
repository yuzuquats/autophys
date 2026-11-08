"""G7-VAL: experiment settings are JSON values, checked where they are declared.

A numpy grid used to pass simulator construction, fitting and analysis, then
fail in the record digest with a TypeError naming neither the experiment nor
the setting. Values are never converted: a live ndarray and its replayed list
would diverge, and float32 values would hash differently.
"""
import json

import numpy as np
import pytest

import autophys as ap
from autophys.simulator import Simulator


def _kinetics(params, experiment):
    t = np.asarray(experiment["t"], dtype=float)
    return {"t": t, "rate": params["v"] * t / (params["k"] + t)}


PARAMS = {"v": ("rate", 1.0, 500.0), "k": ("conc", 0.01, 5.0)}


def test_numpy_grid_in_catalog_fails_at_construction_naming_experiment_and_setting():
    experiments = {s: {"kind": "measured", "state": s, "t": np.array([0.02, 0.06, 0.11])}
                   for s in ("treated", "untreated")}
    with pytest.raises(ValueError) as e:
        ap.simulator(params=PARAMS, experiments=experiments)(_kinetics)
    assert str(e.value) == ("experiment 'treated': setting 't' must be a JSON value "
                            "(got numpy.ndarray); use a list, e.g. t.tolist()")


def test_direct_simulator_construction_checks_the_catalog():
    with pytest.raises(ValueError, match=r"experiment 'e': setting 'n' must be a JSON value \(got numpy.int64\)"):
        Simulator(fn=_kinetics, params={}, experiments={"e": {"kind": "m", "n": np.int64(3)}}, name="k")


def test_numpy_grid_in_observation_settings_fails_at_construction():
    with pytest.raises(ValueError) as e:
        ap.Observation(experiment="treated", settings={"kind": "measured", "t": np.array([0.02, 0.06])},
                       t=[0.02, 0.06], y={"rate": [50.0, 90.0]}, sigma={"rate": 5.0})
    assert str(e.value) == ("experiment 'treated': setting 't' must be a JSON value "
                            "(got numpy.ndarray); use a list, e.g. t.tolist()")


@pytest.mark.parametrize("value, path, got", [
    ({"t": np.array([1.0])}, "grid.t", "got numpy.ndarray); use a list, e.g. t.tolist()"),
    ([1.0, np.float32(2.0)], "grid[1]", "got numpy.float32); use a plain Python value, e.g. grid[1].item()"),
    (float("nan"), "grid", "got nan); JSON has no NaN or infinity"),
    ({1: 2.0}, "grid", "key 1 is int); JSON object keys are strings"),
    ({1.5}, "grid", "got set); use a dict, list, str, int, float, bool or None"),
])
def test_nested_values_are_named_by_path(value, path, got):
    with pytest.raises(ValueError) as e:
        ap.Observation("e", {"kind": "m", "grid": value}, [0.0], {"y": [1.0]}, {"y": 1.0})
    assert str(e.value).startswith(f"experiment 'e': setting {path!r} must be a JSON value ({got}")


def test_settings_are_checked_where_made_and_recorded_not_per_simulation():
    # Each simulation call does not re-walk the settings (a fit makes many
    # calls, and a long grid makes the walk cost real time); the settings an
    # Observation carries are checked when it is made and when it is recorded.
    sim = ap.simulator(params=PARAMS, experiments={"e": {"kind": "m", "t": [0.1, 0.2]}})(_kinetics)
    assert sim({"v": 100.0, "k": 0.1}, {"kind": "m", "t": np.array([0.1])})["rate"].shape == (1,)
    obs = ap.Observation(experiment="e", settings={"kind": "m", "t": [0.1]}, t=[0.1],
                         y={"rate": [50.0]}, sigma={"rate": 1.0})
    obs.settings["t"] = np.array([0.1])
    obs.validate()  # per trial point: structure only
    with pytest.raises(ValueError, match=r"setting 't' must be a JSON value \(got numpy.ndarray\)"):
        obs.to_dict()


def test_accepted_settings_digest_and_record_unchanged():
    # Exactly what json.dumps(allow_nan=False) encodes as-is: np.float64 is a
    # float, tuples encode as lists. Validation and the digest agree.
    settings = {"kind": "m", "t": [0.1, 0.2], "scale": np.float64(2.0), "pair": (1, 2), "tag": None,
                "nested": {"on": True, "label": "x"}}
    obs = ap.Observation("e", settings, [0.1, 0.2], {"y": [1.0, 2.0]}, {"y": 1.0})
    assert obs.settings is settings
    assert len(obs.digest()) == 16
    json.dumps(obs.to_dict(), allow_nan=False)
    replay = ap.Observation.from_dict(json.loads(json.dumps(obs.to_dict())))
    assert replay.digest() == obs.digest()
