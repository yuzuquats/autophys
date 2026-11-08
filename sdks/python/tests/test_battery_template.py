"""The battery-fit template scripts."""
from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path

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
