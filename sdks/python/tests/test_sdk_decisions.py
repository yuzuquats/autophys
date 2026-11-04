"""Operator SDK decisions: the same contracts on memory, JSONL, SQLite and HTTP."""

import itertools
import json

import numpy as np
import pytest

import autophys as ap
from autophys import design
from autophys.agent import Investigation, ProposalRunner, ToolError
from autophys.http import Credentials, HttpError, HttpStore, request_json, save_credentials
from autophys.models import oscillator
from autophys.project import Budgets, Project
from autophys.store import JsonlStore, MemoryStore, canonical, config_hash
from autophys.synthetic import oscillator_case, thermal_case
from autophys.workbook import WorkbookError, WorkbookStore
from fake_server import FakeAutophys
from test_workbook import (propose, test_validation_names_the_field as check_validation,
                           test_idempotent_replay_and_conflict as check_replay)


@pytest.fixture(params=["memory", "jsonl", "workbook"])
def store(request, tmp_path):
    if request.param == "memory":
        yield MemoryStore()
    elif request.param == "jsonl":
        yield JsonlStore(tmp_path / "jsonl")
    else:
        with WorkbookStore(tmp_path / "p.ap-workbook") as wb:
            yield wb


def pinned(store):
    pid = store.ensure_project("p")
    cfg = {"name": "p"}
    ver = store.put_config_version(pid, config_hash(cfg), cfg)
    return store.create_investigation({"project_id": pid, "config_version": ver})


def test_every_local_store_enforces_workbook_rules(store):
    # Reuse the workbook contract assertions, including field paths and edit limits.
    for check in (check_validation, check_replay):
        check(store)



def test_every_local_store_enforces_outlook_edit_limits(store):
    inv = pinned(store)
    propose(store, inv)
    base = {"kind": "sine", "freq": 0.5, "amp": 1.0}
    for change, field in (({"freq": 2.5}, "freq"), ({"amp": 2.0}, "amp"),
                          ({"freq": "fast"}, "freq"), ({"freq": True}, "freq")):
        with pytest.raises(WorkbookError) as e:
            store.append(inv, "proposal", {"proposal_id": "p1", "event": "edited", "settings": {**base, **change}})
        assert (e.value.error, e.value.path) == ("invalid", f"payload.settings.{field}")
    store.append(inv, "proposal", {"proposal_id": "p1", "event": "edited", "settings": {**base, "freq": 2.0 + 1e-12}})
    assert store.proposal_status(inv, "p1")["status"] == "edited"
    propose(store, inv, "p2", outlook=None)
    store.append(inv, "proposal", {"proposal_id": "p2", "event": "edited", "settings": {"anything": 1}})

def test_record_ids_are_global_and_replay_precedes_proposal_state(store):
    a, b = pinned(store), pinned(store)
    proposal = {"proposal_id": "p1", "event": "proposed", "experiment": "e"}
    original = store.append(a, "proposal", proposal, record_id="proposal")
    approval = {"proposal_id": "p1", "event": "approved"}
    approved = store.append(a, "proposal", approval, record_id="approval")
    store.append(a, "proposal", {"proposal_id": "p1", "event": "data_attached", "measurement_version": 1})
    assert store.append(a, "proposal", proposal, record_id="proposal") == original
    assert store.append(a, "proposal", approval, record_id="approval") == approved
    for inv, kind, payload in ((b, "proposal", proposal), (a, "step", {}),
                               (a, "proposal", {**approval, "by": "another"})):
        with pytest.raises(WorkbookError) as e:
            store.append(inv, kind, payload, record_id="approval")
        assert e.value.error == "idempotency_conflict"
    assert store.verify(a) and store.verify(b)


@pytest.mark.parametrize("first,second", list(itertools.product(
    ("proposed", "approved", "edited", "rejected", "withdrawn", "data_attached"),
    ("proposed", "approved", "edited", "rejected", "withdrawn", "data_attached"))))
def test_transition_matrix(store, first, second):
    inv = pinned(store)

    def event(ev):
        return {"proposal_id": "p", "event": ev, "experiment": "e", "settings": {}, "measurement_version": 1}

    store.append(inv, "proposal", event("proposed"))
    if first == "data_attached":
        store.append(inv, "proposal", event("approved"))
    if first != "proposed":
        store.append(inv, "proposal", event(first))
    allowed = (first == "proposed" and second in ("approved", "edited", "rejected", "withdrawn")) or (
        first in ("approved", "edited") and second == "data_attached")
    if allowed:
        store.append(inv, "proposal", event(second))
    else:
        with pytest.raises(WorkbookError) as e:
            store.append(inv, "proposal", event(second))
        assert e.value.error == ("proposal_exists" if second == "proposed" else "conflict")


def test_default_outlook_budget_preserves_the_prechange_config_hash():
    project = Project("default", oscillator)
    assert project.config_version == "sha256:d9ba40dfaf5e38a32021bcc95661efd8d637dcdd8ef261ab31bead8f2a7e9220"
    assert "max_outlook_simulations" not in project.config()["budgets"]
    explicit = Project("default", oscillator, budgets=Budgets(max_outlook_simulations=50000))
    assert explicit.config_version == project.config_version
    changed = Project("default", oscillator, budgets=Budgets(max_outlook_simulations=100))
    assert changed.config()["budgets"]["max_outlook_simulations"] == 100
    assert changed.config_version != project.config_version


def editable_project(view, cap=50000):
    name = "sine_0.44Hz"
    return Project(view.name, view.simulator,
                   catalog={name: {"edit": {"freq": [0.1, 2.0], "amplitude": [0.5, 6.0]}}},
                   budgets=Budgets(max_outlook_simulations=cap))


def test_outlook_cap_shrinks_uniformly_without_charging_the_investigation():
    view, _ = oscillator_case(0)
    inv = Investigation(editable_project(view, cap=100), view.dataset, ProposalRunner())
    result = inv.tool_request_experiment("sine_0.44Hz")
    p = inv.records("proposal")[0].payload
    o = p["outlook"]
    freq, amp = [a["values"] for a in o["axes"]]
    assert len(freq) == len(amp) == 3  # two endpoints plus the proposed value
    cell = freq.index(0.44) * len(amp) + amp.index(2.0)
    assert o["score"][cell] == p["score"]
    assert result["outlook_points"] == {"freq": 3, "amplitude": 3}
    assert result["outlook_simulations"] == (9 + 1) * 7 + 6 == 76
    assert inv.simulations == 0
    assert o["at"] == "initial" and o["after_resolved_max"] == design.AFTER_RESOLVED_MAX == 1.0
    assert len(canonical(p).encode()) < 900 * 1024


def test_payload_limit_shrinks_before_simulating(monkeypatch):
    # Cheap scores isolate the grid sizing from ODE cost, with actual float
    # widths near the conservative preflight bound.
    calls = []

    def score(sim, params, F0, noise, settings, **kw):
        calls.append(settings)
        return -1.7976931348623157e308, {n: -1.7976931348623157e308 for n in sim.param_names}

    monkeypatch.setattr(design, "settings_score", score)
    grid, own, _ = design.outlook(oscillator, {"m": 2., "c": .8, "k": 15.}, [], {"x": .01},
                                  oscillator.experiment("sine_0.44Hz"),
                                  {"freq": [.1, 2.], "amplitude": [.5, 6.], "duration": [5., 20.]},
                                  points=24, J0=np.zeros((0, 3)), max_simulations=10**9)
    lengths = [len(a["values"]) for a in grid["axes"]]
    assert max(lengths) < 24 and len(calls) == len(grid["score"]) + 1
    assert len(canonical(grid).encode()) <= design.OUTLOOK_MAX_BYTES
    index = 0
    for a in grid["axes"]:
        index = index * len(a["values"]) + a["values"].index(oscillator.experiment("sine_0.44Hz")[a["name"]])
    assert grid["score"][index] == own


def test_impossible_outlook_cap_fails_before_any_simulation():
    view, _ = oscillator_case(0)
    inv = Investigation(editable_project(view, cap=1), view.dataset, ProposalRunner())
    before = inv.sim.calls
    with pytest.raises(ToolError, match="minimum grid"):
        inv.tool_request_experiment("sine_0.44Hz")
    assert inv.sim.calls == before and inv.pending is None and not inv.records("proposal")


@pytest.mark.parametrize("decision", ["approved", "edited", "rejected", "withdrawn"])
def test_sdk_decision_stamps_and_withdraw_resume(store, decision):
    view, _ = thermal_case(0)
    project = Project(view.name, view.simulator)
    # Workbook fixtures already have no project at this point.
    inv = Investigation(project, view.dataset, ProposalRunner(), store=store)
    result = inv.tool_request_experiment("step_long")
    pid = result["proposal_id"]
    if decision in ("approved", "edited"):
        inv.approve(pid, by="engineer", settings=inv.sim.experiment("step_long") if decision == "edited" else None)
    else:
        getattr(inv, "reject" if decision == "rejected" else "withdraw")(pid, by="engineer", reason="changed plan")
    payload = inv.records("proposal")[-1].payload
    assert payload["event"] == decision and payload["by"] == "engineer" and payload["via"] == "sdk"
    assert "key_id" not in payload
    if decision == "withdrawn":
        assert inv.pending is None and inv.pending_experiment is None
        assert "withdrawn: changed plan" in inv.history[-1]
        again = Investigation.resume(project, store, inv.id)
        assert again.pending is None and again.pending_experiment is None
        assert again.proposal(pid)["status"] == "withdrawn"
        with pytest.raises(ToolError, match="not the pending"):
            inv.withdraw(pid)
    elif decision == "rejected":
        with pytest.raises(ToolError, match="not the pending"):
            inv.withdraw(pid)
    else:
        with pytest.raises(WorkbookError) as e:
            inv.withdraw(pid)
        assert e.value.error == "conflict"


def test_connect_passes_the_credential_key_id_and_remote_decisions(tmp_path, monkeypatch):
    monkeypatch.delenv("AUTOPHYS_API_KEY", raising=False)
    monkeypatch.setenv("AUTOPHYS_CONFIG_DIR", str(tmp_path / "config"))
    with FakeAutophys() as server:
        key = server.issue_key()
        key_id = server.keys[key]["key_id"]
        save_credentials(Credentials(server.url, key, key_id=key_id))
        client = ap.connect(server.url)
        assert client.store.key_id == key_id
        view, _ = thermal_case(0)
        inv = client.project(Project(view.name, view.simulator)).investigate(view.dataset, ProposalRunner())
        for decision in ("approved", "edited", "rejected", "withdrawn"):
            pid = inv.tool_request_experiment("step_long")["proposal_id"]
            if decision in ("approved", "edited"):
                inv.approve(pid, settings=inv.sim.experiment("step_long") if decision == "edited" else None)
            else:
                getattr(inv, "reject" if decision == "rejected" else "withdraw")(pid)
            payload = inv.records("proposal")[-1].payload
            assert payload["event"] == decision and payload["via"] == "sdk" and payload["key_id"] == key_id
            assert key not in canonical(payload)
        assert server.requests[-2][1].endswith("/proposals")  # withdrawal POST, then records GET


def test_http_replays_are_200_even_after_a_proposal_moves_on():
    with FakeAutophys() as server:
        store = HttpStore(server.url, server.issue_key())
        inv = pinned(store)
        proposal = {"proposal_id": "p", "event": "proposed", "experiment": "e"}
        record = store.append(inv, "proposal", proposal, record_id="propose")
        approve = {"proposal_id": "p", "event": "approved", "via": "sdk"}
        approved = store.append(inv, "proposal", approve, record_id="approve")
        store.append(inv, "proposal", {"proposal_id": "p", "event": "data_attached", "measurement_version": 1})
        code, response = request_json("POST", store.base + f"/investigations/{inv}/proposals/p/approvals",
                                      {"id": "approve", "kind": "proposal", "payload": approve}, api_key=store._key)
        assert code == 200 and response["record"] == approved.to_dict() and response["gseq"] == 3
        assert store.append(inv, "proposal", proposal, record_id="propose") == record
        assert store.append(inv, "proposal", approve, record_id="approve") == approved
        for payload in ({**approve, "by": "another"}, {"proposal_id": "unknown", "event": "approved"}):
            with pytest.raises(HttpError) as e:
                store.append(inv, "proposal", payload, record_id="approve")
            assert e.value.status == 409 and e.value.error == "idempotency_conflict"
        code, response = request_json("POST", store.base + f"/investigations/{inv}/runs",
                                     {"id": "new", "kind": "run", "payload": {}}, api_key=store._key)
        assert code == 201 and response["gseq"] == server.gseq
        assert store.verify(inv)


def test_fake_payload_errors_and_route_events_have_422_field_paths():
    with FakeAutophys() as server:
        key = server.issue_key()
        store = HttpStore(server.url, key)
        inv = pinned(store)
        route = store.base + f"/investigations/{inv}/"
        for endpoint, kind, payload, path in (
            ("measurements", "measurement", {}, "payload.observation"),
            ("proposals", "proposal", {"proposal_id": "p", "event": "unknown"}, "payload.event"),
            ("proposals/p/approvals", "proposal", {"proposal_id": "p", "event": "withdrawn"}, "payload.event"),
            ("proposals/p/data", "proposal", {"proposal_id": "p", "event": "approved"}, "payload.event"),
            ("proposals/p/data", "proposal", {"proposal_id": "p", "event": "data_attached"}, "payload.measurement_version"),
        ):
            # request_json exposes the error code/message; inspect the raw JSON
            # here as well to assert the daemon's explicit path field.
            import urllib.error
            import urllib.request
            req = urllib.request.Request(route + endpoint, method="POST",
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    data=canonical({"id": "bad", "kind": kind, "payload": payload}).encode())
            with pytest.raises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(req)
            with e.value as response:
                body = json.load(response)
            assert e.value.code == 422 and body["error"] == "invalid" and body["path"] == path


def test_append_batch_is_all_or_nothing(store):
    """attach_data's measurement and data_attached commit together (RS question 2)."""
    inv = pinned(store)
    before = len(store.records(inv))
    with pytest.raises(WorkbookError):
        store.append_batch(inv, [
            ("measurement", {"version": 1, "observation": {}}),
            ("proposal", {"proposal_id": "nope", "event": "data_attached", "measurement_version": 1}),
        ])
    assert len(store.records(inv)) == before
    assert store.verify(inv)
    propose(store, inv, "p1")
    store.append(inv, "proposal", {"proposal_id": "p1", "event": "approved", "by": "u"})
    recs = store.append_batch(inv, [
        ("measurement", {"version": 1, "observation": {}}),
        ("proposal", {"proposal_id": "p1", "event": "data_attached", "measurement_version": 1}),
    ])
    assert [r.kind for r in recs] == ["measurement", "proposal"]
    assert [r.seq for r in recs] == [recs[0].seq, recs[0].seq + 1]
    assert store.verify(inv)
