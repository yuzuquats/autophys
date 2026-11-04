import numpy as np
import pytest

from autophys.data import Dataset, Observation
from autophys.design import rank_experiments
from autophys.fit import FitResult, StartResult, fit, residuals
from autophys.models import battery_ecm, oscillator, thermal_rc
from autophys.sensitivity import IdentifiabilityRule, analyze, report_from_jacobian
from autophys.simulator import FIT_OPTIONS, TRUTH_OPTIONS
from autophys.synthetic import NoiseModel, observe

TRUTH = {"m": 2.0, "c": 0.8, "k": 15.0}


@pytest.fixture(scope="module")
def free_obs():
    return observe(oscillator, TRUTH, "free", NoiseModel({"x": 0.01}), np.random.default_rng(0))


def test_reference_ranking_after_free_response(free_obs):
    """JS-prototype sanity reference: 0.44 Hz sine > step > 0.1 Hz sine > impulse > 2 Hz sine; repeat free ~ 0."""
    ranked = rank_experiments(oscillator, TRUTH, [free_obs], {"x": 0.01})
    order = [c.experiment for c in ranked]
    assert order == ["sine_0.44Hz", "step_2N", "sine_0.1Hz", "impulse", "sine_2Hz", "free"]
    scores = {c.experiment: c.min_eig for c in ranked}
    assert scores["free"] < 1e-6 * scores["sine_2Hz"]
    # D-optimality agrees that resonance is best and the repeat is worst
    d = {c.experiment: c.d_opt for c in rank_experiments(oscillator, TRUTH, [free_obs], {"x": 0.01}, criterion="d_opt")}
    assert max(d, key=d.get) == "sine_0.44Hz" and min(d, key=d.get) == "free"


def test_mass_ambiguity_is_structural(free_obs):
    rep, J = analyze(oscillator, TRUTH, [free_obs])
    assert rep.identified == [] and set(rep.non_identified) == {"m", "c", "k"}
    bad = rep.non_identifiable_directions
    assert len(bad) == 1 and bad[0].kind == "structural"
    v = np.array([bad[0].vector[k] for k in "mck"])
    assert np.allclose(np.abs(v), 1 / np.sqrt(3), atol=1e-3)  # m, c, k scale together
    assert bad[0].combination.count("^1") == 3
    assert rep.condition_number > 1e6


def test_forced_experiment_breaks_ambiguity(free_obs):
    sine = observe(oscillator, TRUTH, "sine_0.44Hz", NoiseModel({"x": 0.01}), np.random.default_rng(1))
    rep, _ = analyze(oscillator, TRUTH, [free_obs, sine])
    assert rep.identified == ["m", "c", "k"] and rep.non_identifiable_directions == []


def test_fit_converges_and_reports(free_obs):
    sine = observe(oscillator, TRUTH, "sine_0.44Hz", NoiseModel({"x": 0.01}), np.random.default_rng(1))
    r = fit(oscillator, [free_obs, sine], n_starts=3, seed=0, dataset_version=2)
    assert r.success and r.status > 0 and r.nfev > 0 and len(r.starts) == 3
    assert 0.85 < r.chi2_per_n < 1.15
    for k in TRUTH:
        assert abs(r.params[k] / TRUTH[k] - 1) < 0.01
    assert r.dataset_version == 2 and r.source_hash == oscillator.source_hash
    restored = FitResult.from_dict(r.to_dict())
    assert restored == r and restored.to_dict() == r.to_dict()
    assert all(isinstance(start, StartResult) for start in restored.starts)
    assert r.loss == pytest.approx(np.sum(residuals(oscillator, r.params, [free_obs, sine]) ** 2), rel=1e-6)


def test_missing_samples_and_bounds():
    rng = np.random.default_rng(3)
    obs = observe(thermal_rc, {"C": 500.0, "R": 2.0}, "step_long", NoiseModel({"T": 0.05}, missing_fraction=0.3), rng)
    assert np.isnan(obs.y["T"]).sum() > 100
    r = fit(thermal_rc, [obs], n_starts=2)
    assert r.n == obs.n_samples and abs(r.params["R"] / 2.0 - 1) < 0.01
    assert all(thermal_rc.params[k].lo <= v <= thermal_rc.params[k].hi for k, v in r.params.items())


def test_robust_loss_resists_outliers():
    rng = np.random.default_rng(4)
    obs = observe(thermal_rc, {"C": 500.0, "R": 2.0}, "step_long", NoiseModel({"T": 0.05}), rng)
    y = obs.y["T"].copy()
    y[::40] += 3.0  # gross outliers
    bad = Observation(obs.experiment, obs.settings, obs.t, {"T": y}, obs.sigma)
    plain = fit(thermal_rc, [bad], n_starts=2)
    robust = fit(thermal_rc, [bad], n_starts=2, loss="soft_l1", f_scale=2.0)
    err = lambda r: abs(r.params["R"] / 2.0 - 1)  # noqa: E731
    assert err(robust) < err(plain)


def test_practical_non_identifiability_short_step():
    obs = observe(thermal_rc, {"C": 500.0, "R": 2.0}, "step_short", NoiseModel({"T": 0.05}), np.random.default_rng(0))
    rep, _ = analyze(thermal_rc, {"C": 500.0, "R": 2.0}, [obs])
    assert rep.identified == ["C"] and rep.non_identified == ["R"]
    assert rep.non_identifiable_directions[0].kind == "practical"


def test_rule_thresholds_are_parameters():
    J = np.array([[100.0, 0.0], [0.0, 5.0]])
    strict = report_from_jacobian(["a", "b"], J, IdentifiabilityRule(max_log_std=0.1))
    loose = report_from_jacobian(["a", "b"], J, IdentifiabilityRule(max_log_std=0.5))
    assert strict.non_identified == ["b"] and loose.non_identified == []


def test_truth_tolerance_is_finer_than_fit():
    """Synthetic data must not reproduce the fitting solver's own error (inverse crime)."""
    assert TRUTH_OPTIONS.rtol < FIT_OPTIONS.rtol / 100
    a = oscillator(TRUTH, "sine_2Hz", options=TRUTH_OPTIONS)["x"]
    b = oscillator(TRUTH, "sine_2Hz", options=FIT_OPTIONS)["x"]
    assert 0 < np.max(np.abs(a - b)) < 1e-6


def test_battery_fit_recovers_parameters():
    truth = {"R0": 0.05, "R1": 0.03, "C1": 1000.0}
    rng = np.random.default_rng(5)
    obs = [observe(battery_ecm, truth, "pulse_2A", NoiseModel({"v": 0.001}), rng)]
    r = fit(battery_ecm, obs, initial={"R0": 0.02, "R1": 0.02, "C1": 500.0}, n_starts=1)
    for k, v in truth.items():
        assert abs(r.params[k] / v - 1) < 0.05


def test_dataset_versions_and_test_split():
    ds = Dataset()
    o = Observation("e", {"kind": "x"}, [0, 1], {"y": [1, 2]}, {"y": 0.1})
    assert ds.add(o) == 1 and ds.version == 1
    with pytest.raises(ValueError, match="evaluator-only"):
        ds.add(Observation("e", {"kind": "x"}, [0, 1], {"y": [1, 2]}, {"y": 0.1}, split="test"))
    rt = Observation.from_dict(Observation("e", {"kind": "x"}, [0, 1], {"y": [np.nan, 2]}, {"y": 0.1}).to_dict())
    assert np.isnan(rt.y["y"][0]) and rt.y["y"][1] == 2
