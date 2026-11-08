"""G8: a held-out observation reusing the train settings grid gets a named error.

The simulator predicts on the settings' grid; the observation carries its own
``t``. validate_predictions used to combine the two with boolean masks and die
with an IndexError after fitting and recording had succeeded. The SDK cannot
know which setting is a model's grid, so it never re-predicts on ``t``.
"""
import numpy as np
import pytest

import autophys as ap
from autophys.agent import Investigation, ProposalRunner, ScriptedPolicy
from autophys.fit import residuals
from autophys.project import Budgets, Project
from autophys.simulator import GridMismatchError, SimulationError
from autophys.store import MemoryStore

GRID = [0.02, 0.06, 0.11, 0.22, 0.56, 1.1]
TRUTH = {"v": 200.0, "k": 0.06}


def _kinetics(params, experiment):
    t = np.asarray(experiment["t"], dtype=float)
    return {"t": t, "rate": params["v"] * t / (params["k"] + t)}


kinetics = ap.simulator(params={"v": ("rate", 10.0, 500.0), "k": ("conc", 0.005, 1.0)},
                        experiments={"treated": {"kind": "measured", "t": GRID}}, outputs=("rate",))(_kinetics)


def _obs(settings, t, split):
    t = np.asarray(t, dtype=float)
    return ap.Observation("treated", settings, t, {"rate": TRUTH["v"] * t / (TRUTH["k"] + t)},
                          {"rate": 1.0}, split=split)


def _investigation(validation):
    train = _obs(kinetics.experiment("treated"), GRID, "train")
    project = Project(name="kinetics", simulator=kinetics, budgets=Budgets(max_experiments=0))
    return Investigation(project, ap.Dataset([train, validation]), ProposalRunner(),
                         policy=ScriptedPolicy(), store=MemoryStore())


MESSAGE = ("validation observation 1 of 1 (experiment 'treated'): the prediction for 'rate' has 6 samples "
           "but the observation has 2; give this observation settings whose grid matches its own samples "
           "(e.g. its own 't')")


def test_validation_reusing_train_settings_names_the_observation():
    inv = _investigation(_obs(kinetics.experiment("treated"), [1.1, 1.1], "validation"))
    inv.tool_optimize_parameters()
    with pytest.raises(GridMismatchError) as e:
        inv.tool_validate_predictions()
    assert str(e.value) == MESSAGE


def _step_errors(inv, out, action):
    return [r.payload["result"]["error"] for r in inv.store.records(out.investigation, "step")
            if r.payload.get("decision", {}).get("action") == action and "error" in (r.payload.get("result") or {})]


def test_a_scripted_run_records_the_named_validation_error_and_finishes():
    # G8-LOOP: the error is a step result, as in the Rust loop, and the run still writes an outcome.
    inv = _investigation(_obs(kinetics.experiment("treated"), [1.1, 1.1], "validation"))
    out = inv.run()
    assert out.status == "budget_exhausted"
    errors = _step_errors(inv, out, "validate_predictions")
    assert errors and errors[0] == MESSAGE
    assert inv.last_error == f"validate_predictions: {MESSAGE}"  # what the next turn's facts carry
    assert inv.store.records(out.investigation, "outcome")


def test_a_scripted_run_records_the_named_training_error_and_finishes():
    bad = _obs(kinetics.experiment("treated"), [0.5, 1.0, 2.0], "train")
    project = Project(name="kinetics", simulator=kinetics, budgets=Budgets(max_experiments=0))
    train = _obs(kinetics.experiment("treated"), GRID, "train")
    inv = Investigation(project, ap.Dataset([train, bad]), ProposalRunner(), policy=ScriptedPolicy(), store=MemoryStore())
    out = inv.run()
    assert out.status == "budget_exhausted"
    errors = _step_errors(inv, out, "optimize_parameters")
    assert errors and errors[0].startswith("train observation 2 of 2 (experiment 'treated')")


def test_validation_with_its_own_grid_is_scored():
    own = {"kind": "measured", "t": [1.1, 1.1]}
    inv = _investigation(_obs(own, [1.1, 1.1], "validation"))
    inv.tool_optimize_parameters()
    out = inv.tool_validate_predictions()
    assert out["available"] and out["n"] == 2 and out["passed"]


def test_training_residuals_name_the_misaligned_observation():
    good = _obs(kinetics.experiment("treated"), GRID, "train")
    bad = _obs(kinetics.experiment("treated"), [0.5, 1.0, 2.0], "train")
    with pytest.raises(GridMismatchError, match=r"^train observation 2 of 2 \(experiment 'treated'\): "
                                                r"the prediction for 'rate' has 6 samples but the observation has 3"):
        residuals(kinetics, TRUTH, [good, bad])
    assert issubclass(GridMismatchError, SimulationError)


def test_a_fit_stops_on_a_training_grid_mismatch():
    # G8-TRAIN: a data error, not a failed trial point, so no fit result.
    good = _obs(kinetics.experiment("treated"), GRID, "train")
    bad = _obs(kinetics.experiment("treated"), [0.5, 1.0, 2.0], "train")
    with pytest.raises(GridMismatchError, match=r"^train observation 2 of 2 \(experiment 'treated'\)"):
        ap.fit(kinetics, [good, bad], n_starts=1)


def test_a_solver_failure_at_every_point_is_penalized_not_raised():
    # G8-TRAIN keeps the penalty for real solver failures: only a grid mismatch stops the fit.
    @ap.simulator(params={"v": ("rate", 10.0, 500.0)},
                  experiments={"treated": {"kind": "measured", "t": GRID}}, outputs=("rate",))
    def fails(params, experiment):
        raise SimulationError("diverged")

    result = ap.fit(fails, [_obs(fails.experiment("treated"), GRID, "train")], n_starts=1)
    assert result.loss >= 1e12


def test_a_same_size_wrong_shape_prediction_names_both_shapes():
    from autophys.simulator import aligned_prediction
    obs = ap.Observation(experiment="treated", settings={"kind": "m"}, t=[0.1, 0.2],
                         y={"rate": [1.0, 2.0]}, sigma={"rate": 1.0})
    with pytest.raises(GridMismatchError, match=r"has shape \(2, 1\) but the observation's samples have shape \(2,\)"):
        aligned_prediction({"rate": np.zeros((2, 1))}, obs, "rate", "train observation 1 of 1")


def test_a_run_whose_simulator_always_fails_ends_with_an_outcome():
    # LOOP-PARITY and G8-FINISH: a plain SimulationError from a tool step is the
    # step's result, and the closing identifiability check names it as a reason.
    @ap.simulator(params={"v": ("rate", 10.0, 500.0), "k": ("conc", 0.005, 1.0)},
                  experiments={"treated": {"kind": "measured", "t": GRID}}, outputs=("rate",))
    def fails(params, experiment):
        raise SimulationError("diverged")

    project = Project(name="fails", simulator=fails, budgets=Budgets(max_experiments=0, max_steps=6))
    train = _obs(fails.experiment("treated"), GRID, "train")
    inv = Investigation(project, ap.Dataset([train]), ProposalRunner(), policy=ScriptedPolicy(), store=MemoryStore())
    out = inv.run()
    assert out.status == "budget_exhausted"
    errors = _step_errors(inv, out, "analyze_sensitivity")
    assert errors and set(errors) == {"diverged"}
    assert "identifiability could not be checked at the final estimate: diverged" in out.reasons
    assert out.identified == []
    assert inv.store.records(out.investigation, "outcome")


def test_a_claim_the_closing_check_could_not_test_says_it_was_not_checked():
    # FINISH-WORDING: the rule never ran, so the outcome must not say it disagreed.
    from autophys.agent import Decision
    from autophys.project import AnalysisConfig
    failing = {"on": False}

    @ap.simulator(params={"v": ("rate", 10.0, 500.0), "k": ("conc", 0.005, 1.0)},
                  experiments={"treated": {"kind": "measured", "t": GRID}}, outputs=("rate",))
    def flaky(params, experiment):
        if failing["on"]:
            raise SimulationError("diverged")
        return _kinetics(params, experiment)

    class StopClaiming:
        name = "stop"

        def decide(self, facts):
            return Decision("done", ["fit"], "stop", {"status": "validated", "identified": ["v", "k"],
                                                     "summary": "claims both"}, "none"), {}

    project = Project(name="flaky", simulator=flaky, budgets=Budgets(max_experiments=0),
                      analysis=AnalysisConfig(identify_every_fit=False))
    train = _obs(flaky.experiment("treated"), GRID, "train")
    inv = Investigation(project, ap.Dataset([train]), ProposalRunner(), policy=StopClaiming(), store=MemoryStore())
    inv.tool_optimize_parameters()
    failing["on"] = True
    out = inv.run()
    assert out.status == "inconclusive" and out.identified == []
    assert "identifiability could not be checked at the final estimate: diverged" in out.reasons
    assert "guardrail: claimed identified but identifiability was not checked: v, k" in out.reasons
    assert not any(r.startswith("not identified by the rule") or "disagrees" in r for r in out.reasons), out.reasons
