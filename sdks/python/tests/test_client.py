"""ap.connect → Client → Workbook, and resuming an investigation from its records."""

import numpy as np
import pytest

import autophys as ap
from autophys.agent import Investigation, ProposalRunner, ScriptedPolicy, ToolError
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

    # process 2: resume from the file
    client = ap.connect(tmp_path)
    inv = client.project(project).investigation(inv_id)
    assert inv.pending == pid and inv.pending_experiment == "sine_0.44Hz"
    assert inv.steps == 4 and inv.simulations == out.simulations and inv.experiments_used == 0
    assert inv.outcome is not None and inv.outcome.status == "awaiting_data"
    with pytest.raises(ToolError):
        inv.run()
    assert inv.wait_for_approval(timeout=5)["status"] == "approved"
    inv.attach_data(pid, observe(view.simulator, truth, inv.pending_experiment, noise, np.random.default_rng(9)))
    got = inv.run()
    assert got.status == want.status == "validated"
    assert got.experiments == want.experiments == 1 and got.identified == want.identified
    assert max(abs(got.estimate[k] / want.estimate[k] - 1) for k in truth) < 1e-3
    assert [r.payload["event"] for r in inv.records("proposal")] == ["proposed", "approved", "data_attached"]
    assert inv.proposal(pid)["status"] == "data_attached"
    assert client.project(project).verify()["ok"]

    # resuming a finished investigation restores its counts and outcome
    again = client.project(project).investigation(inv_id)
    assert again.pending is None and again.outcome.status == "validated"
    assert again.experiments_used == 1 and again.runs_per_experiment == {"sine_0.44Hz": 1}
    assert again.steps == got.steps and again.simulations == got.simulations and len(again.dataset) == len(inv.dataset)
    client.close()


def test_resume_counts_a_direct_runner_and_the_adopted_model(tmp_path):
    view, _ = thermal_case(0, max_experiments=1)
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
