"""ap.connect → Client → Workbook, and resuming an investigation from its records."""

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest

import autophys as ap
from autophys.agent import Investigation, Outcome, ProposalRunner, ScriptedPolicy, ToolError
from autophys.project import Budgets, Project
from autophys.store import MemoryStore, StoreError
from autophys.synthetic import NoiseModel, observe, oscillator_case, thermal_case
from autophys.workbook import WorkbookError, WorkbookStore
from fake_server import FakeAutophys


def project_for(view, **kw):
    kw.setdefault("budgets", Budgets(max_experiments=view.max_experiments))
    return Project(name=view.name, simulator=view.simulator, **kw)


def test_connect_targets(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOPHYS_HOME", str(tmp_path / "home"))
    assert ap.connect().root == tmp_path / "home"
    assert isinstance(ap.connect(tmp_path / "lab"), ap.LocalClient)
    one = ap.connect(tmp_path / "x.ap-workbook")
    assert one.only == tmp_path / "x.ap-workbook" and one.projects() == []
    monkeypatch.delenv("AUTOPHYS_API_KEY", raising=False)
    monkeypatch.setenv("AUTOPHYS_CONFIG_DIR", str(tmp_path / "cfg"))
    with pytest.raises(StoreError, match="no API key"):
        ap.connect("http://127.0.0.1:9")


def test_local_collection_one_workbook_per_project(tmp_path):
    view, _ = thermal_case(0, max_experiments=1)
    project = project_for(view)
    with ap.connect(tmp_path / "lab") as client:
        wb = client.project(project)
        out = wb.investigate(view.dataset, view.runner, policy=ScriptedPolicy()).run()
        assert out.status == "validated"
        path = tmp_path / "lab" / (ap.workbook.slug(project.name) + ".ap-workbook")
        assert path.exists()
        [listed] = client.projects()
        assert listed["name"] == project.name and listed["path"] == str(path)
        [row] = wb.investigations()
        assert row["id"] == out.investigation and row["status"] == "validated"
        assert [c["version"] for c in wb.config_versions()] == [project.config_version]
        assert wb.verify()["ok"]
        # a second investigation lands in the same file
        wb.investigate(view.dataset, view.runner, policy=ScriptedPolicy()).run()
        assert len(wb.investigations()) == 2 and len(list((tmp_path / "lab").glob("*.ap-workbook"))) == 1


def test_open_by_name_is_review_only(tmp_path):
    view, _ = oscillator_case(0, max_experiments=1)
    project = project_for(view)
    client = ap.connect(tmp_path)
    with pytest.raises(WorkbookError, match="no workbook"):
        client.project(project.name)
    inv_id = client.project(project).investigate(view.dataset, ProposalRunner(), policy=ScriptedPolicy()).run().investigation
    review = client.project(project.name)
    assert review.investigations()[0]["status"] == "awaiting_data"
    with pytest.raises(StoreError, match="needs the Project"):
        review.investigate(view.dataset, ProposalRunner())
    with pytest.raises(StoreError, match="needs the Project"):
        review.investigation(inv_id)
    client.close()


def test_slug_collision_is_refused(tmp_path):
    view, _ = thermal_case(0)
    client = ap.connect(tmp_path)
    client.project(project_for(view))
    clash = Project(name=view.name.upper(), simulator=view.simulator)
    with pytest.raises(WorkbookError, match="holds project"):
        client.project(clash)
    client.close()


def test_resume_in_a_new_process_matches_an_uninterrupted_run(tmp_path):
    """Run until a proposal, drop every object, approve from another
    connection (the viewer), resume from the file and finish."""
    view, _ = oscillator_case(0, max_experiments=2)
    ref_view, _ = oscillator_case(0, max_experiments=2)  # attach_data grows a case's dataset
    project = project_for(view)
    truth = {"m": 2.0, "c": 0.8, "k": 15.0}
    noise = NoiseModel({"x": 0.01})

    # the reference: one process, one MemoryStore
    ref = Investigation(project, ref_view.dataset, ProposalRunner(), policy=ScriptedPolicy(), store=MemoryStore())
    pid = ref.run().proposal_id
    ref.approve(pid, by="eng")
    ref.attach_data(pid, observe(view.simulator, truth, ref.pending_experiment, noise, np.random.default_rng(9)))
    resume_step = ref.steps
    want = ref.run()

    # process 1: run until the proposal, then go away
    client = ap.connect(tmp_path)
    first = client.project(project).investigate(view.dataset, ProposalRunner(), policy=ScriptedPolicy())
    out = first.run()
    inv_id, pid = first.id, out.proposal_id
    assert out.status == "awaiting_data"
    client.close()
    del first

    # the viewer: a separate connection approves
    path = tmp_path / (ap.workbook.slug(project.name) + ".ap-workbook")
    with WorkbookStore(path) as viewer:
        viewer.append(inv_id, "proposal", {"proposal_id": pid, "event": "approved", "by": "viewer"})

    # process 2 really is a fresh interpreter, with no in-memory fit state.
    src = str(Path(__file__).resolve().parents[1] / "src")
    script = textwrap.dedent(f"""
        import json
        import numpy as np
        import autophys as ap
        from autophys.agent import ToolError
        from autophys.project import Project, Budgets
        from autophys.synthetic import oscillator_case, NoiseModel, observe
        view, _ = oscillator_case(0, max_experiments=2)
        project = Project(view.name, view.simulator, budgets=Budgets(max_experiments=2))
        with ap.connect({str(tmp_path)!r}) as client:
            inv = client.project(project).investigation({inv_id!r})
            assert inv.pending == {pid!r} and inv.pending_experiment == "sine_0.44Hz"
            assert inv.steps == 3 and inv.simulations == {out.simulations} and inv.experiments_used == 0
            assert inv.outcome.status == "awaiting_data"
            assert inv.fit is not None and inv.fit_model == inv.model == "base"
            try:
                inv.run()
            except ToolError:
                pass
            else:
                raise AssertionError("pending proposal did not block run")
            assert inv.wait_for_approval(timeout=5)["status"] == "approved"
            inv.attach_data({pid!r}, observe(view.simulator, {{"m": 2.0, "c": 0.8, "k": 15.0}},
                            inv.pending_experiment, NoiseModel({{"x": 0.01}}), np.random.default_rng(9)))
            got = inv.run()
            print(json.dumps(got.to_dict()))
    """)
    proc = subprocess.run([sys.executable, "-I", "-B", "-c", f"import sys; sys.path.insert(0, {src!r})\n" + script],
                          env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stderr
    got = Outcome(**json.loads(proc.stdout))
    client = ap.connect(tmp_path)
    inv = client.project(project).investigation(inv_id)
    assert got.status == want.status == "validated"
    assert got.experiments == want.experiments == 1 and got.identified == want.identified
    assert got.estimate == want.estimate  # exact float equality, including the warm start
    assert got.steps == want.steps and got.simulations == want.simulations
    after_resume = lambda i: [r.payload["decision"]["action"] for r in i.records("step")][resume_step:]
    assert after_resume(inv) == after_resume(ref)
    assert [r.payload["decision"]["arguments"] for r in inv.records("step")
            if r.payload["decision"]["action"] == "request_experiment"] == [
                r.payload["decision"]["arguments"] for r in ref.records("step")
                if r.payload["decision"]["action"] == "request_experiment"]
    assert [r.payload["event"] for r in inv.records("proposal")] == ["proposed", "approved", "data_attached"]
    assert inv.proposal(pid)["status"] == "data_attached"
    assert client.project(project).verify()["ok"]

    # resuming a finished investigation restores its counts and outcome
    again = client.project(project).investigation(inv_id)
    assert again.pending is None and again.outcome.status == "validated"
    assert again.experiments_used == 1 and again.runs_per_experiment == {"sine_0.44Hz": 1}
    assert again.steps == got.steps and again.simulations == got.simulations and len(again.dataset) == len(inv.dataset)
    client.close()


@pytest.mark.parametrize("bias", [0.0, 0.5])
def test_resume_counts_a_direct_runner_and_the_adopted_model(tmp_path, bias):
    view, _ = thermal_case(0, max_experiments=1, bias=bias)
    project = project_for(view)
    client = ap.connect(tmp_path)
    wb = client.project(project)
    inv = wb.investigate(view.dataset, view.runner, policy=ScriptedPolicy())
    inv.run()
    back = wb.investigation(inv.id, view.runner)
    assert back.experiments_used == inv.experiments_used == 1
    assert back.runs_per_experiment == inv.runs_per_experiment
    assert back.model == inv.model and back.compared == inv.compared
    assert back.fit_id == inv.fit_id
    assert back.fit.to_dict() == inv.fit.to_dict() and back.fit_model == inv.fit_model
    client.close()


def test_resume_refuses_a_different_config_version(tmp_path):
    view, _ = thermal_case(0)
    client = ap.connect(tmp_path)
    inv = client.project(project_for(view)).investigate(view.dataset, view.runner, policy=ScriptedPolicy())
    changed = project_for(view, budgets=Budgets(max_experiments=5))
    with pytest.raises(StoreError, match="pinned to config version"):
        Investigation.resume(changed, client.project(project_for(view)).store, inv.id)
    client.close()


def test_remote_client_over_api_v1():
    view, _ = thermal_case(0, max_experiments=1)
    project = project_for(view)
    with FakeAutophys() as server:
        client = ap.connect(server.url, api_key=server.issue_key())
        wb = client.project(project)
        out = wb.investigate(view.dataset, view.runner, policy=ScriptedPolicy()).run()
        assert out.status == "validated"
        assert [p["name"] for p in client.projects()] == [project.name]
        assert [i["id"] for i in wb.investigations()] == [out.investigation]
        report = wb.verify()
        assert report["ok"] and report["projections_match"] is None
        assert client.project(project.name).name == project.name
        with pytest.raises(StoreError, match="no project"):
            client.project("missing")
