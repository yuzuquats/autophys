"""The simulator worker protocol (``python -m autophys.worker``, cli.md CLI-11).

``autophys mcp --project mypkg.module:project`` spawns the worker and drives
it through ``autophys::worker``; these tests speak the protocol directly.
The binary's side is ``cargo test --test devtools mcp_serves`` and the
``worker`` unit tests in ``sdks/rust``.
"""
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys

import numpy as np
import pytest

from autophys import worker
from autophys.models.battery import battery_ecm
from autophys.project import load_project
from autophys.store import canonical, config_hash

REPO = Path(__file__).resolve().parents[3]
LAB = REPO / "tests/fixtures/python_lab"
SRC = REPO / "sdks/python/src"


def spawn(reference, *, root=LAB):
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(SRC), os.environ.get("PYTHONPATH")]))}
    args = [sys.executable, "-m", "autophys.worker"] + (["--root", str(root)] if root else []) + [reference]
    return subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env=env, cwd=REPO)


def frame(proc):
    line = proc.stdout.readline()
    assert line, proc.stderr.read()
    return json.loads(line)


def ask(proc, request):
    proc.stdin.write(json.dumps(request) + "\n")
    proc.stdin.flush()
    return frame(proc)


@pytest.fixture
def decaylab():
    sys.path.insert(0, str(LAB))
    try:
        import decaylab

        yield decaylab
    finally:
        sys.path.remove(str(LAB))
        sys.modules.pop("decaylab", None)


def test_startup_frame_describes_the_project_with_python_identities(decaylab):
    proc = spawn("decaylab:project")
    head = frame(proc)
    assert head["protocol"] == "autophys-worker" and head["version"] == 1 and head["ok"]
    p = head["project"]
    project = decaylab.project
    assert p["name"] == "decay_lab"
    assert p["simulator"]["source_hash"] == project.simulator.source_hash
    assert p["config_version"] == project.config_version
    assert p["simulator"]["params"] == [s.as_dict() for s in project.simulator.params.values()]
    assert p["simulator"]["experiments"] == project.simulator.experiments
    assert p["simulator"]["outputs"] == ["y"] and p["simulator"]["stochastic"] is False
    assert p["initial"] == {"A": 1.0, "k": 0.5} and p["fixed"] == []
    assert p["noise"] == {"sigma": None, "estimate": False, "bias": "off"}
    assert p["catalog"] == {"short": {"max_runs": None}, "long": {"max_runs": None}}
    assert p["display"] is None and p["n_starts"] == 4
    # The configuration records pin, exactly as this SDK computes it.
    assert canonical(p["config"]) == canonical(project.config())
    assert config_hash(p["config"]) == project.config_version
    proc.stdin.close()
    assert proc.wait(timeout=30) == 0
    # The module's prints went to stderr.
    assert "decaylab imported" in proc.stderr.read()


def test_a_lab_declared_with_integers_keeps_them_in_its_configuration(decaylab):
    proc = spawn("decaylab:integers")
    p = frame(proc)["project"]
    project = decaylab.integers
    # Integers stay integers, so the config version is the one this SDK writes.
    assert p["config"]["params"]["A"]["initial"] == 3 and type(p["config"]["params"]["A"]["initial"]) is int
    assert type(p["config"]["stop"]["validation_threshold"]) is int
    assert p["config_version"] == project.config_version == config_hash(p["config"])
    proc.stdin.close()
    assert proc.wait(timeout=30) == 0


def test_simulate_returns_the_simulators_exact_floats(decaylab):
    proc = spawn("decaylab:project")
    frame(proc)
    settings = decaylab.decay.experiment("short")
    reply = ask(proc, {"id": 7, "op": "simulate", "params": {"A": 2.0, "k": 0.8}, "experiment": settings,
                       "options": {"rtol": 1e-8, "atol": 1e-10, "seed": None}})
    assert reply["id"] == 7 and reply["ok"]
    direct = decaylab.decay({"A": 2.0, "k": 0.8}, settings)
    assert list(reply["result"]["y"]) == ["t", "y"] and reply["result"]["u"] == {}
    for k in ("t", "y"):
        assert reply["result"]["y"][k] == direct[k].tolist()
    proc.stdin.close()
    assert proc.wait(timeout=30) == 0


def test_errors_are_typed_and_keep_the_worker_alive():
    proc = spawn("decaylab:project")
    frame(proc)
    settings = {"kind": "decay", "duration": 1.0, "rate": 2.0}
    out_of_bounds = ask(proc, {"id": 1, "op": "simulate", "params": {"A": 20.0, "k": 0.8}, "experiment": settings})
    assert out_of_bounds == {"id": 1, "ok": False, "error": {"kind": "bounds", "message": out_of_bounds["error"]["message"]}}
    assert "A=20.0 outside" in out_of_bounds["error"]["message"]
    bad = ask(proc, {"id": 2, "op": "simulate", "params": {"A": 2.0, "k": 0.8}, "experiment": {"duration": 1}})
    assert bad["error"]["kind"] == "invalid" and "missing 'kind'" in bad["error"]["message"]
    assert ask(proc, {"id": 3, "op": "fit"})["error"] == {"kind": "protocol", "message": "unknown op 'fit'"}
    proc.stdin.write("not json\n")
    proc.stdin.flush()
    assert frame(proc)["error"]["kind"] == "protocol"
    assert ask(proc, {"id": 4, "op": "simulate", "params": {"A": 2.0, "k": 0.8}, "experiment": settings})["ok"]
    proc.stdin.close()
    assert proc.wait(timeout=30) == 0


def test_a_simulator_reference_and_a_load_failure():
    proc = spawn("decaylab:decay")
    head = frame(proc)
    assert head["project"]["name"] == "decay" and head["project"]["simulator"]["name"] == "decay"
    proc.stdin.close()
    assert proc.wait(timeout=30) == 0
    proc = spawn("decaylab:nothing")
    head = frame(proc)
    assert head["ok"] is False and head["error"]["kind"] == "load"
    assert "AttributeError" in head["error"]["message"] and "nothing" in head["error"]["message"]
    assert proc.wait(timeout=30) == 1
    assert "Traceback" in proc.stderr.read()


def test_a_crash_ends_the_stream_without_a_reply():
    proc = spawn("decaylab:crashes")
    frame(proc)
    proc.stdin.write(json.dumps({"id": 1, "op": "simulate", "params": {"a": 0.5},
                                 "experiment": {"kind": "x", "duration": 1.0, "rate": 2.0}}) + "\n")
    proc.stdin.flush()
    assert proc.stdout.readline() == ""
    assert proc.wait(timeout=30) == 7
    assert "about to fall over" in proc.stderr.read()


def test_input_channels_and_non_finite_floats_in_process():
    # battery_ecm declares a display input channel; serve it in process.
    project = load_project("battery_ecm")
    settings = battery_ecm.experiment("pulse_2A")
    requests = io.StringIO(json.dumps({"id": 1, "op": "simulate", "params": {"R0": 0.03, "R1": 0.04, "C1": 1500.0},
                                       "experiment": settings}) + "\n")
    out = io.StringIO()
    assert worker.serve("battery_ecm", None, requests, out) == 0
    head, reply = [json.loads(line) for line in out.getvalue().splitlines()]
    assert head["project"]["display"]["channels"]["i"]["role"] == "input"
    assert head["project"]["config_version"] == project.config_version
    direct = battery_ecm({"R0": 0.03, "R1": 0.04, "C1": 1500.0}, settings, count=False)
    assert reply["result"]["u"]["i"] == direct.u["i"].tolist()
    assert reply["result"]["y"]["v"] == direct["v"].tolist()
    # NaN and infinities use Python's tokens, which the binary's pyjson reads.
    text = worker.dumps({"y": np.array([np.nan, np.inf, -np.inf, 1.5])})
    assert text == '{"y": [NaN, Infinity, -Infinity, 1.5]}'
    assert [math.isnan(x) or x for x in json.loads(text)["y"]][1:] == [math.inf, -math.inf, 1.5]


def test_the_worker_is_not_a_console_script():
    pyproject = (REPO / "sdks/python/pyproject.toml").read_text()
    assert "[project.scripts]" not in pyproject
