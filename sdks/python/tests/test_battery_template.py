"""The battery-fit template scripts: project naming and input-file errors."""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SDK_SRC = Path(__file__).resolve().parents[1] / "src"
TEMPLATE = Path(__file__).resolve().parents[3] / "examples" / "battery-fit.demo" / "python"


def load_closed_loop(folder: Path):
    spec = importlib.util.spec_from_file_location(f"closed_loop_{folder.name}", folder / "closed_loop.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_closed_loop_names_the_project_after_the_scaffold(tmp_path):
    for name in ("alpha", "beta"):
        folder = tmp_path / name
        folder.mkdir()
        shutil.copy(TEMPLATE / "closed_loop.py", folder)
        (folder / "pyproject.toml").write_text(f'[project]\nname = "{name}"\nversion = "0.1.0"\n')
        assert load_closed_loop(folder).project.name == name


def test_closed_loop_in_the_repo_keeps_the_demo_name():
    assert not (TEMPLATE / "pyproject.toml").exists()
    assert load_closed_loop(TEMPLATE).project_name() == "battery_cycler_demo"


@pytest.mark.parametrize("script, args", [
    ("battery_fit.py", []),
    ("closed_loop.py", ["start", "--test", "quick_pulse", "--sigma", "0.002", "--data"]),
])
def test_a_missing_input_file_is_a_clean_error(tmp_path, script, args):
    missing = str(tmp_path / "nope.csv")
    out = subprocess.run([sys.executable, str(TEMPLATE / script), *args, missing],
                         capture_output=True, text=True, cwd=tmp_path, timeout=120,
                         env={**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(SDK_SRC), os.environ.get("PYTHONPATH")])),
                              "AUTOPHYS_HOME": str(tmp_path / "home"), "AUTOPHYS_SERVER": ""})
    assert out.returncode == 1
    assert "Traceback" not in out.stderr
    assert out.stderr.strip() == f"{missing}: cannot read: No such file or directory"


@pytest.mark.parametrize("content, message", [
    ("time,current,voltage\n0,0,3.7\n1,x,3.6\n", "line 3: current must be a number, got 'x'"),
    ("time,current,voltage\n0,0,3.7\n1,0\n", "line 3: voltage must be a number, got None"),
])
def test_a_bad_cell_is_a_clean_error(tmp_path, content, message):
    data = tmp_path / "bad.csv"
    data.write_text(content)
    out = subprocess.run([sys.executable, str(TEMPLATE / "battery_fit.py"), str(data)],
                         capture_output=True, text=True, cwd=tmp_path, timeout=120,
                         env={**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(SDK_SRC), os.environ.get("PYTHONPATH")])),
                              "AUTOPHYS_HOME": str(tmp_path / "home"), "AUTOPHYS_SERVER": ""})
    assert out.returncode == 1 and "Traceback" not in out.stderr
    assert out.stderr.strip() == f"{data}: {message}"


def test_the_serve_hint_expands_a_tilde_home(monkeypatch):
    module = load_closed_loop(TEMPLATE)
    monkeypatch.setenv("AUTOPHYS_HOME", "~/lab")
    monkeypatch.setenv("AUTOPHYS_SERVER", "")
    hint = module.where()
    assert f"--collection {os.path.expanduser('~/lab')}`" in hint
    assert "'~/lab'" not in hint
