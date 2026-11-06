"""Oracle redaction and final-audit ordering at the real orchestration boundary."""
import copy
import json
from autophys.research import proposer_report, proposal_prompt, research
from autophys.playbook import load_playbook


def oracle_report():
    return {"score": {"correct": 0, "mean_log_error": 1., "cost_usd": None},
            "runs": [{"row": {"status": "inconclusive", "test_rmse": 99., "rel_errors": {"R": 2.}},
                      "score": {"log_errors": {"R": 1.}, "correct": False}}],
            "failing_transcripts": [{"records": [
                {"kind": "outcome", "payload": {"estimate": {"R": 1.}}},
                {"kind": "reveal", "payload": {"truth": {"R": 2.}, "quantities": ["secret"]}}]}]}


def test_redaction_is_nonmutating_and_keeps_action_evidence():
    report = oracle_report(); original = copy.deepcopy(report)
    safe = proposer_report(report)
    assert report == original
    text = json.dumps(safe)
    for field in ('"truth"', '"quantities"', '"reveal"', '"test_rmse"', '"rel_errors"', '"log_errors"'):
        assert field not in text
    assert safe["score"] == report["score"]
    assert safe["failing_transcripts"][0]["records"] == [report["failing_transcripts"][0]["records"][0]]
    assert '"truth"' not in proposal_prompt("skill", report)


def test_research_only_proposes_from_redacted_training_before_final_audit(tmp_path):
    events = []
    def evaluate(*args, **kwargs):
        events.append(("evaluate", tuple(args[2])))
        return oracle_report()
    class Researcher:
        def propose(self, text, report):
            events.append(("propose", None))
            assert report == proposer_report(oracle_report())
            return text + "\nA predeclared edit.\n"
    research(researcher=Researcher(), output_dir=tmp_path/"run", policy="scripted",
             cases=["thermal"], train_seeds=(11,), heldout_seeds=(12,), iterations=1,
             evaluate_fn=evaluate)
    assert events == [("evaluate", (11,)), ("propose", None), ("evaluate", (11,)),
                      ("evaluate", (12,)), ("evaluate", (12,))]
