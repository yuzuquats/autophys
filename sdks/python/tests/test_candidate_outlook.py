import numpy as np
import pytest
from autophys.models import oscillator
from autophys.design import rank_experiments, settings_score

def test_candidate_after_matches_outlook():
    params = {"m": 2., "c": .8, "k": 15.}
    for c in rank_experiments(oscillator, params, [], {"x": .01}):
        _, after = settings_score(oscillator, params, np.zeros((3, 3)), {"x": .01}, oscillator.experiment(c.experiment))
        assert c.after == pytest.approx(after, rel=1e-10)
        assert c.to_dict()["after"] == c.after

        import json
        from pathlib import Path
        reference = json.loads(Path(__file__).with_name("candidate_after_reference.json").read_text())
        assert c.after == pytest.approx(reference[c.experiment], rel=1e-8)
