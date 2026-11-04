import io
import json

from autophys import cli
from autophys.bench import format_table, run_benchmark, summarize

EXPECTED = {
    "oscillator-free-only": "inconclusive",
    "oscillator": "validated",
    "thermal-short-only": "inconclusive",
    "thermal": "validated",
}


def test_benchmark_all_cases_both_policies():
    rows = run_benchmark(seeds=1)
    assert len(rows) == 8
    for r in rows:
        assert r.status == EXPECTED[r.case], r
        assert r.diagnosis_correct, r
        assert r.max_rel_error < 0.02, r
        assert r.simulations > 0 and r.wall_s > 0
    by = {(r.case, r.policy): r for r in rows}
    assert by[("oscillator", "scripted")].requested == ["sine_0.44Hz"]
    assert by[("oscillator-free-only", "scripted")].non_identified == ["c", "k", "m"]
    assert by[("thermal-short-only", "scripted")].non_identified == ["R"]
    # the mass ambiguity shows up out of sample: forced test experiments are badly predicted
    assert by[("oscillator-free-only", "scripted")].test_rmse > 10 * by[("oscillator", "scripted")].test_rmse
    table = format_table(summarize(rows))
    assert "oscillator-free-only" in table and "diagnosis" in table


def test_cli_bench_json():
    out = io.StringIO()
    assert cli.main(["bench", "--case", "thermal", "--policy", "scripted", "--seeds", "1", "--json"], out=out) == 0
    rows = json.loads(out.getvalue())
    assert rows[0]["case"] == "thermal" and rows[0]["status"] == "validated"
