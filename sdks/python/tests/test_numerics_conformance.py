"""Recompute shared numeric goldens using the Rust comparison rules."""
import json

import pytest

from numerics_cases import ROOT, all_cases, compare, execute, field

CASES = sorted(ROOT.glob("*/*.json"))


@pytest.mark.parametrize("path", CASES, ids=lambda p: f"{p.parent.name}/{p.stem}")
def test_python_numerics_goldens(path):
    case = json.loads(path.read_text())
    assert case["format"] == 1
    result = execute(case)
    for key, rule in case["expect"].items():
        try:
            compare(field(result, key), rule)
        except AssertionError as exc:
            raise AssertionError(f"{path}:{key}: {exc}") from exc
    if case["op"] == "run" and "script" in case["inputs"]:
        assert [(d["action"], d["arguments"]) for d in result["decisions"]] == [
            (d["action"], d["arguments"]) for d in case["inputs"]["script"]]


def test_numerics_generator_is_current():
    generated = dict(all_cases())
    assert {str(p.relative_to(ROOT)) for p in CASES} == set(generated)
    for path in CASES:
        saved = json.loads(path.read_text())
        current = generated[str(path.relative_to(ROOT))]
        assert saved["expect"].keys() == current["expect"].keys()
        for key, rule in saved["expect"].items():
            fresh = current["expect"][key]
            assert {k: v for k, v in rule.items() if k != "value"} == {
                k: v for k, v in fresh.items() if k != "value"}
            # Generation is numeric too: use replay tolerances rather than
            # requiring identical floating-point text on every platform.
            compare(fresh["value"], rule)
