import numpy as np
import pytest

import autophys as ml
from autophys.models import battery_ecm, oscillator, thermal_rc
from autophys.simulator import BoundsError, SimulationError, TRUTH_OPTIONS


def test_decorator_schema_and_hash():
    @ml.simulator(params={"a": ("1/s", 0.1, 10)}, experiments={"e": {"kind": "decay", "duration": 1, "rate": 10}}, outputs=("y",))
    def decay(params, experiment):
        t = np.linspace(0, experiment["duration"], 11)
        return {"t": t, "y": np.exp(-params["a"] * t)}

    assert decay.params["a"].unit == "1/s" and decay.params["a"].log
    assert decay.source_hash.startswith("sha256:")
    out = decay({"a": 1.0}, "e")
    assert out["y"][0] == 1.0 and decay.calls == 1
    assert decay.check_determinism({"a": 2.0}, "e")
    with pytest.raises(BoundsError):
        decay({"a": 20.0}, "e")
    with pytest.raises(BoundsError):
        decay({"a": 1.0, "b": 2.0}, "e")
    with pytest.raises(KeyError):
        decay({"a": 1.0}, "nope")


def test_bad_declarations():
    with pytest.raises(ValueError):
        ml.simulator(params={"a": ("u", 1, 1)})
    with pytest.raises(ValueError):
        ml.simulator(params={"a": ("u", 0.1, 1)}, experiments={"e": {"duration": 1}})  # no kind


def test_result_checks():
    @ml.simulator(params={"a": ("u", 0.1, 1)}, outputs=("y",))
    def broken(params, experiment):
        return {"t": np.arange(3), "y": np.array([1.0, np.nan, 2.0])}

    with pytest.raises(SimulationError, match="non-finite"):
        broken({"a": 0.5}, {"kind": "x"})


def test_stochastic_requires_seed():
    @ml.simulator(params={"a": ("u", 0.1, 1)}, stochastic=True)
    def noisy(params, experiment, options=None):
        rng = np.random.default_rng(options.seed)
        return {"t": np.arange(4.0), "y": rng.normal(size=4)}

    with pytest.raises(SimulationError, match="seed"):
        noisy({"a": 0.5}, {"kind": "x"})
    assert noisy.check_determinism({"a": 0.5}, {"kind": "x"}, seed=3)


def test_oscillator_matches_analytic_free_response():
    th = {"m": 2.0, "c": 0.8, "k": 15.0}
    out = oscillator(th, "free", options=TRUTH_OPTIONS)
    zeta_w = th["c"] / (2 * th["m"])
    wd = np.sqrt(th["k"] / th["m"] - zeta_w**2)
    t = out["t"]
    x = 0.1 * np.exp(-zeta_w * t) * (np.cos(wd * t) + zeta_w / wd * np.sin(wd * t))
    assert np.max(np.abs(out["x"] - x)) < 1e-9
    step = oscillator(th, "step_2N", options=TRUTH_OPTIONS)
    assert abs(step["x"][-1] - 2.0 / 15.0) < 0.02  # settles near F/k


def test_thermal_matches_analytic_step():
    out = thermal_rc({"C": 500.0, "R": 2.0}, "step_long", options=TRUTH_OPTIONS)
    expect = 20.0 + 10.0 * 2.0 * (1 - np.exp(-out["t"] / 1000.0))
    assert np.max(np.abs(out["T"] - expect)) < 1e-7


def test_battery_pulse_shape():
    p = {"R0": 0.05, "R1": 0.03, "C1": 1000.0}
    out = battery_ecm(p, "pulse_2A")
    v, t = out["v"], out["t"]
    # instantaneous R0 drop, RC relaxation during the pulse, recovery after it
    assert v[0] < 4.06 and v[0] > 3.9
    on = t < 30
    assert v[on][-1] < v[on][0]
    assert v[-1] > v[on][-1]
    assert abs((v[-1] - v[on][-1]) - (2.0 * 0.05 + 2.0 * 0.03 * (1 - np.exp(-30 / 30)))) < 0.02


def test_with_fixed_and_bias():
    fixed = oscillator.with_fixed(m=2.0)
    assert fixed.param_names == ["c", "k"]
    a = fixed({"c": 0.8, "k": 15.0}, "free")["x"]
    b = oscillator({"m": 2.0, "c": 0.8, "k": 15.0}, "free")["x"]
    assert np.array_equal(a, b)
    biased = oscillator.with_bias("x", -1, 1)
    c = biased({"m": 2.0, "c": 0.8, "k": 15.0, "bias_x": 0.25}, "free")["x"]
    assert np.allclose(c - b, 0.25)
    assert biased.source_hash != oscillator.source_hash != fixed.source_hash
