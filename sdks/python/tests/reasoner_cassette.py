"""Exact, fake-only recordings for the current numerical environment.

The committed cassette is a fixed historical request corpus, not an oracle for
an arbitrary solver's floating-point trajectory. This helper never selects a
provider or opens a socket. Its usage is synthetic contract-test metadata.
"""
import json
from pathlib import Path

from autophys.agent import Investigation, ReasonLanePolicy
from autophys.heuristic import heuristic_responder
from autophys.synthetic import case_project
from autophys.reasoner import FakeReasoner, ModelSpec, MUSE_SPARK, RecordingReasoner, request_body
from autophys.synthetic import CASES

SPEC = ModelSpec("policy", "meta", MUSE_SPARK)
# Each fit carries its identifiability check (AnalysisConfig.identify_every_fit), so the
# policy needs no separate analyze_sensitivity step.
ACTIONS = ["optimize_parameters", "rank_experiments", "request_experiment",
           "optimize_parameters", "validate_predictions", "stop"]


def fake_response(body, fake):
    """The old fake HTTP response, invoked directly with an exact POST body."""
    reply = fake.complete(body["messages"])
    return {"model": MUSE_SPARK, "choices": [{"message": {"content": reply.content}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 40, "total_tokens": 140,
                      "completion_tokens_details": {"reasoning_tokens": 10},
                      "prompt_tokens_details": {"cached_tokens": 20}}}


class _InProcessFake:
    route, model = SPEC.route, SPEC.model

    def __init__(self):
        self.fake = FakeReasoner(heuristic_responder, model=self.model)

    def complete(self, messages, **options):
        from autophys.reasoner import ReasonReply
        body = request_body(self.route, self.model, messages, **options)
        response = fake_response(body, self.fake)
        return ReasonReply(response["choices"][0]["message"]["content"], self.model,
                           response["usage"], self.route, 0.0)


def generate(path):
    path = Path(path)
    # Reserve before capture; neither committed recordings nor another caller's
    # output can be silently overwritten.
    with path.open("x"):
        pass
    policy = ReasonLanePolicy(RecordingReasoner(_InProcessFake(), path), model_spec=SPEC)
    policy.name = "reason"
    view, evaluator = CASES["oscillator"](0)
    inv = Investigation(case_project(view), view.dataset, view.runner, policy=policy)
    outcome = inv.run()
    assert outcome.status == "validated"
    steps = inv.records("step")
    assert [json.loads(r.payload["raw_output"])["action"] for r in steps] == ACTIONS
    # Independent held-out scientific checks: capturing replies cannot certify
    # a solver merely by agreeing with its own subsequent replay.
    assert evaluator.diagnosis_correct(set(outcome.non_identified))
    assert max(evaluator.relative_errors(outcome.estimate).values()) < 0.02
    assert evaluator.test_rmse(view.simulator, outcome.estimate) < 0.02
    assert [o.experiment for o in view.dataset if o.split == "train"][1:] == ["sine_0.44Hz"]
    assert not inv.records("reveal")
    return path


if __name__ == "__main__":
    import sys
    generate(sys.argv[1])
